//! Process-local evidence retained independently of exit notification delivery.
//! This is not persistence, owner acknowledgement, or transferable wait authority.

use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, OnceLock};

use crate::{events::AppEvent, layout::PaneId, platform::ChildExitReason};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitEvidence {
    ChildWait(ChildExitReason),
    /// PTY reader termination does not establish a child wait result.
    #[cfg(unix)]
    ImportedReaderEnded,
}

impl ExitEvidence {
    fn reason(self) -> ChildExitReason {
        match self {
            Self::ChildWait(reason) => reason,
            #[cfg(unix)]
            Self::ImportedReaderEnded => ChildExitReason::Handoff,
        }
    }
}

/// The retained allocation identifies one runtime incarnation, independently of
/// reusable pane IDs and PIDs. Readers cannot clear or acknowledge its evidence.
#[derive(Clone, Debug, Default)]
pub(crate) struct ExitRecord(Arc<OnceLock<ExitEvidence>>);

impl ExitRecord {
    pub(crate) fn evidence(&self) -> Option<ExitEvidence> {
        self.0.get().copied()
    }

    // Identity validation will be integrated with retired-runtime bookkeeping.
    #[allow(dead_code)]
    pub(crate) fn same_runtime(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub(super) fn record(&self, evidence: ExitEvidence, completed: &AtomicBool) -> bool {
        if self.0.set(evidence).is_err() {
            tracing::error!("runtime exit evidence already recorded");
            return false;
        }
        // Keep the existing shutdown/CWD completion semantics, including wait
        // failure. Acquire readers of this flag can also observe the evidence.
        completed.store(true, Ordering::Release);
        true
    }

    pub(super) async fn notify(
        &self,
        pane_id: PaneId,
        events: &tokio::sync::mpsc::Sender<AppEvent>,
    ) {
        let Some(evidence) = self.evidence() else {
            tracing::error!(
                pane = pane_id.raw(),
                "runtime exit notification has no evidence"
            );
            return;
        };
        // Still reliable blocking publication at the caller. Best-effort wakeups
        // would require owner reconciliation, which is not implemented yet.
        if let Err(err) = events
            .send(AppEvent::PaneDied {
                pane_id,
                exit_reason: evidence.reason(),
            })
            .await
        {
            tracing::error!(pane = pane_id.raw(), %err, "failed to send PaneDied event");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, task::Poll};

    #[cfg(unix)]
    #[tokio::test]
    async fn real_child_watcher_retains_outcome_with_full_or_closed_owner_channel() {
        use crate::pane::{AgentDetection, PaneLaunchEnv, PaneRuntime};
        for closed in [false, true] {
            let pane_id = PaneId::alloc();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tx.send(AppEvent::TerminalBell { pane_id, count: 1 })
                .await
                .unwrap();
            let mut rx = Some(rx);
            if closed {
                drop(rx.take());
            }
            let mut runtime = PaneRuntime::spawn_shell_command(
                pane_id,
                5,
                40,
                std::env::temp_dir(),
                "exit 0",
                &PaneLaunchEnv::default(),
                AgentDetection::Disabled,
                100_000,
                crate::terminal_theme::TerminalTheme::default(),
                None,
                tx,
                Arc::new(tokio::sync::Notify::new()),
                Arc::new(crate::render_signal::RenderSignal::new()),
            )
            .unwrap();
            let record = runtime.exit_record();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !runtime
                    .child_wait_completed
                    .as_ref()
                    .unwrap()
                    .load(Ordering::Acquire)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            let expected = Some(ExitEvidence::ChildWait(ChildExitReason::Exited));
            assert_eq!(record.evidence(), expected);
            assert!(record.same_runtime(&runtime.exit_record()));
            // The test-owned child has already been reaped. Do not signal its
            // now-reusable numeric PID during test fixture destruction.
            runtime.preserve_processes_on_drop = true;
            if let Some(mut rx) = rx {
                assert!(matches!(
                    rx.recv().await,
                    Some(AppEvent::TerminalBell { .. })
                ));
                let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                    .await
                    .unwrap();
                assert!(
                    matches!(event, Some(AppEvent::PaneDied { pane_id: id, exit_reason: ChildExitReason::Exited }) if id == pane_id)
                );
            }
            drop(runtime);
            assert_eq!(record.evidence(), expected);
        }
    }

    #[tokio::test]
    async fn blocked_notification_retains_evidence_before_completion_and_cancellation() {
        let record = ExitRecord::default();
        let identity = record.clone();
        let completed = AtomicBool::new(false);
        let pane_id = PaneId::alloc();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(AppEvent::TerminalBell { pane_id, count: 1 })
            .await
            .unwrap();
        let evidence = ExitEvidence::ChildWait(ChildExitReason::Interrupted);
        assert!(record.record(evidence, &completed));
        assert!(completed.load(Ordering::Acquire));
        assert_eq!(identity.evidence(), Some(evidence));
        let mut publish = Box::pin(record.notify(pane_id, &tx));
        std::future::poll_fn(|cx| {
            assert!(publish.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert!(completed.load(Ordering::Acquire));
        assert_eq!(identity.evidence(), Some(evidence));
        drop(publish);
        assert_eq!(identity.evidence(), Some(evidence));
        assert!(identity.same_runtime(&record));
        assert!(!identity.same_runtime(&ExitRecord::default()));
        assert!(matches!(
            rx.recv().await,
            Some(AppEvent::TerminalBell { .. })
        ));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn closed_channel_and_duplicate_recording_cannot_erase_first_outcome() {
        let record = ExitRecord::default();
        let completed = AtomicBool::new(false);
        let pane_id = PaneId::alloc();
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        drop(rx);
        let evidence = ExitEvidence::ChildWait(ChildExitReason::WaitFailed);
        assert!(record.record(evidence, &completed));
        record.notify(pane_id, &tx).await;
        assert!(completed.load(Ordering::Acquire));
        assert_eq!(record.evidence(), Some(evidence));
        assert!(!record.record(ExitEvidence::ChildWait(ChildExitReason::Exited), &completed));
        assert_eq!(record.evidence(), Some(evidence));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn imported_reader_evidence_is_not_a_child_wait_status() {
        let record = ExitRecord::default();
        let completed = AtomicBool::new(false);
        let pane_id = PaneId::alloc();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        assert!(record.record(ExitEvidence::ImportedReaderEnded, &completed));
        record.notify(pane_id, &tx).await;
        assert_eq!(record.evidence(), Some(ExitEvidence::ImportedReaderEnded));
        assert!(matches!(
            rx.recv().await,
            Some(AppEvent::PaneDied {
                exit_reason: ChildExitReason::Handoff,
                ..
            })
        ));
        assert_eq!(record.evidence(), Some(ExitEvidence::ImportedReaderEnded));
    }
}
