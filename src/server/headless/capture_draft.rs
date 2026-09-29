//! Owner-side prerequisite for private terminal capture, not a shared state cut.
//!
//! Apply the finite prefix already queued at entry before borrowing a runtime.
//! Handlers may remove/replace runtimes and reapply geometry, so they must never
//! run while a terminal capture guard holds one. Later events, in-flight
//! producers and work spawned by these handlers are NOT acknowledged here.
//! Stage new events while awaiting detector/actor acknowledgements, then reject
//! the draft if any are pending. An empty inbox is not proof of a producer or
//! shared-session cut.
//! Keep this disconnected from production handoff and endpoint negotiation.

use super::*;

mod batch;

// This coordinator remains private until queued-effect transfer, child-exit
// ownership and the complete runtime snapshot protocol are implemented.
#[allow(dead_code)]
impl HeadlessServer {
    pub(super) async fn capture_terminal_after_queued_prefix(
        &mut self,
        terminal_id: &crate::terminal::TerminalId,
        limits: crate::pane::DraftLimits,
        timeout: Duration,
    ) -> Result<crate::pane::PaneStateDraft, String> {
        self.check_capture_shutdown()?;
        let identity = self
            .app
            .terminal_runtimes
            .get(terminal_id)
            .ok_or("terminal runtime not found before prefix application")?
            .capture_identity();
        let prefix_len = self.app.event_rx.len();
        self.apply_capture_prefix(prefix_len)?;
        self.capture_runtime_if_unchanged(terminal_id, &identity)?;
        let result = {
            // Borrow disjoint owner fields. Never apply handlers while the
            // runtime operation owns its producer pauses: they can remove or
            // resize that runtime. The inbox retains events even if cancelled.
            let inbox = &mut self.app.event_rx;
            let runtime = self
                .app
                .terminal_runtimes
                .get_mut(terminal_id)
                .ok_or("terminal runtime missing after identity validation")?;
            let capture = runtime.capture_terminal_state_draft(limits, timeout);
            tokio::pin!(capture);
            loop {
                tokio::select! {
                    biased;
                    result = &mut capture => break result,
                    staged = inbox.stage_next(crate::app::APP_EVENT_CHANNEL_CAPACITY) => {
                        match staged {
                            Ok(true) => {},
                            Ok(false) => break Err("event channel closed during capture".into()),
                            Err(err) => break Err(err.into()),
                        }
                    }
                }
            }
        };
        // Shutdown may arrive while awaiting detector acknowledgement. The
        // scoped runtime operation has already resumed its producers here.
        self.check_capture_shutdown()?;
        let draft = result?;
        if !self.app.event_rx.is_empty() {
            return Err(
                "events arrived during terminal capture; apply them before retrying".into(),
            );
        }
        Ok(draft)
    }

    pub(super) fn capture_runtime_if_unchanged(
        &mut self,
        terminal_id: &crate::terminal::TerminalId,
        identity: &crate::pane::CaptureIdentity,
    ) -> Result<&mut crate::terminal::TerminalRuntime, String> {
        self.check_capture_shutdown()?;
        let runtime = self
            .app
            .terminal_runtimes
            .get_mut(terminal_id)
            .ok_or("terminal runtime removed while applying queued prefix")?;
        if !runtime.matches_capture_identity(identity) {
            return Err("terminal runtime replaced while applying queued prefix".into());
        }
        Ok(runtime)
    }

    fn check_capture_shutdown(&self) -> Result<(), String> {
        if self.should_quit.load(Ordering::Acquire)
            || self.host_shutdown_requested.load(Ordering::Acquire)
        {
            Err("server shutdown prevents terminal draft capture".into())
        } else {
            Ok(())
        }
    }

    /// `count` is sampled once from event_rx.len() by the owner. Do not drain
    /// until empty: concurrent producers or handlers can append indefinitely.
    pub(super) fn apply_capture_prefix(&mut self, count: usize) -> Result<(), String> {
        self.check_capture_shutdown()?;
        for _ in 0..count {
            self.check_capture_shutdown()?;
            let event = self
                .app
                .event_rx
                .try_recv()
                .map_err(|_| "queued event prefix could not be completely applied")?;
            if self.handle_internal_event_with_forwarding(event) {
                self.app.render_dirty.request_generic();
                self.app.render_notify.notify_one();
            }
        }
        self.check_capture_shutdown()
    }
}
