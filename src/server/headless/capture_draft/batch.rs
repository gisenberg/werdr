//! Simultaneous terminal-only drafts, not a shared session or transport capsule.
//! Child watchers and external producers remain outside these pause leases.

use super::*;
use crate::terminal::TerminalId;
use futures_util::{stream::FuturesUnordered, StreamExt};

// Private until complete effect and process ownership is implemented.
#[allow(dead_code)]
impl HeadlessServer {
    pub(in crate::server::headless) async fn capture_terminal_batch(
        &mut self,
        limits: crate::pane::DraftLimits,
        retained_bytes: usize,
        max_terminals: usize,
        timeout: Duration,
    ) -> Result<Vec<(TerminalId, crate::pane::PaneStateDraft)>, String> {
        self.check_capture_shutdown()?;
        if self.app.terminal_runtimes.len() > max_terminals {
            return Err("terminal capture count exceeds batch limit".into());
        }
        let mut identities: Vec<_> = self
            .app
            .terminal_runtimes
            .iter()
            .map(|(id, runtime)| (id.clone(), runtime.capture_identity()))
            .collect();
        identities.sort_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
        let attachments = self.capture_attachments();
        self.apply_capture_prefix(self.app.event_rx.admission_cut()?)?;
        self.validate_capture_runtime_set(&identities)?;
        if self.capture_attachments() != attachments {
            return Err("terminal attachments changed while applying queued prefix".into());
        }
        let work = self.app.event_rx.work_checkpoint()?;
        // Acquisition and serialization share a deadline. Resume acknowledgements
        // have a separate bounded cleanup grace using each guard's timeout.
        let deadline = tokio::time::Instant::now() + timeout;
        let result = {
            let inbox = &mut self.app.event_rx;
            let runtimes = &mut self.app.terminal_runtimes;
            let operation = async {
                let mut pending: FuturesUnordered<_> = runtimes
                    .iter_mut()
                    .map(|(id, runtime)| async move {
                        let result = tokio::time::timeout_at(
                            deadline,
                            runtime.pause_for_terminal_capture(timeout),
                        )
                        .await
                        .map_err(|_| "terminal batch pause deadline exceeded".to_owned())?;
                        result.map(|guard| (id.clone(), guard))
                    })
                    .collect();
                let mut guards = Vec::new();
                let mut failure = None;
                while let Some(result) = pending.next().await {
                    match result {
                        Ok(guard) => guards.push(guard),
                        Err(err) => {
                            failure = Some(err);
                            break;
                        }
                    }
                }
                // Cancel partially acquired requests before explicit cleanup of
                // complete guards. Their Drop cleanup is queued, not acknowledged.
                if !pending.is_empty() {
                    if let Some(err) = &mut failure {
                        err.push_str(
                            "; pending acquisition cleanup queued without acknowledgement",
                        );
                    }
                }
                drop(pending);
                guards.sort_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
                let mut drafts = Vec::new();
                let mut remaining = retained_bytes;
                if failure.is_none() {
                    for (id, guard) in &guards {
                        if tokio::time::Instant::now() >= deadline {
                            failure = Some("terminal batch capture deadline exceeded".into());
                            break;
                        }
                        match guard.snapshot(limits) {
                            Ok(draft) => {
                                if tokio::time::Instant::now() >= deadline {
                                    failure =
                                        Some("terminal batch capture deadline exceeded".into());
                                    break;
                                }
                                let charge = draft
                                    .retained_bytes()
                                    .and_then(|n| n.checked_add(id.as_str().len()))
                                    .and_then(|n| n.checked_add(std::mem::size_of::<TerminalId>()));
                                let Some(next) = charge.and_then(|n| remaining.checked_sub(n))
                                else {
                                    failure = Some(
                                        "terminal batch retained payload limit exceeded".into(),
                                    );
                                    break;
                                };
                                remaining = next;
                                drafts.push((id.clone(), draft));
                            }
                            Err(err) => {
                                failure = Some(err);
                                break;
                            }
                        }
                    }
                }
                // No guard resumes before the complete serialization attempt.
                // Resume all acquired guards even if another acknowledgement fails.
                let mut resumes: FuturesUnordered<_> = guards
                    .into_iter()
                    .map(|(id, guard)| async move { (id, guard.resume().await) })
                    .collect();
                let mut cleanup = Vec::new();
                while let Some((id, result)) = resumes.next().await {
                    if let Err(err) = result {
                        cleanup.push(format!("{id}: {err}"));
                    }
                }
                if !cleanup.is_empty() {
                    cleanup.sort();
                    return Err(format!(
                        "{}; terminal batch resume failed: {}",
                        failure.unwrap_or_else(|| "terminal drafts captured".into()),
                        cleanup.join("; ")
                    ));
                }
                if let Some(err) = failure {
                    Err(err)
                } else {
                    Ok(drafts)
                }
            };
            tokio::pin!(operation);
            loop {
                tokio::select! {
                    biased;
                    result = &mut operation => break result,
                    staged = inbox.stage_next(crate::app::APP_EVENT_CHANNEL_CAPACITY) => {
                        match staged {
                            Ok(true) => {},
                            // Inbox exhaustion cannot safely wait for a producer
                            // blocked on that inbox. Abort drops leases nonblocking;
                            // normal owner consumption then permits actor cleanup.
                            Ok(false) => break Err("event channel closed during batch capture".into()),
                            Err(err) => break Err(format!("{err}; batch cleanup queued without acknowledgement")),
                        }
                    }
                }
            }
        };
        self.check_capture_shutdown()?;
        let drafts = result?;
        self.validate_capture_runtime_set(&identities)?;
        self.app.event_rx.validate_work_checkpoint(&work)?;
        if !self.app.event_rx.is_empty() {
            return Err(
                "events arrived during terminal batch capture; apply them before retrying".into(),
            );
        }
        Ok(drafts)
    }

    pub(in crate::server::headless) fn validate_capture_runtime_set(
        &mut self,
        identities: &[(TerminalId, crate::pane::CaptureIdentity)],
    ) -> Result<(), String> {
        self.check_capture_shutdown()?;
        if identities.len() != self.app.terminal_runtimes.len() {
            return Err("terminal runtime set changed while applying queued prefix".into());
        }
        for (id, identity) in identities {
            self.capture_runtime_if_unchanged(id, identity)?;
        }
        Ok(())
    }

    fn capture_attachments(&self) -> Vec<(u32, TerminalId)> {
        let mut attachments: Vec<_> = self
            .app
            .state
            .workspaces
            .iter()
            .flat_map(|workspace| &workspace.tabs)
            .flat_map(|tab| &tab.panes)
            .map(|(id, pane)| (id.raw(), pane.attached_terminal_id.clone()))
            .collect();
        attachments.sort_by_key(|(id, _)| *id);
        attachments
    }
}
