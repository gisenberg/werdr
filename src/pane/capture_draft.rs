//! Private terminal-only capture through the real Unix PTY actor.
//!
//! This is not a runtime handoff or an event ownership cut. Queued application
//! effects, child-exit state and detector state are not captured here. Detector
//! suspension preserves its live task state, not a transferable representation.
//! Keep this disconnected from the production handoff protocol.

use super::{
    terminal::state_draft::{DraftLimits, PaneStateDraft},
    PaneRuntime,
};
use std::time::Duration;

/// Retains the allocation, not process authority, so runtime replacement cannot
/// pass an identity check even if its terminal id (or allocator address) is reused.
pub(crate) struct CaptureIdentity(std::sync::Arc<super::PaneTerminal>);

// Deliberately opt-in until the complete runtime/effect ownership cut exists.
#[allow(dead_code)]
impl PaneRuntime {
    pub(crate) fn capture_identity(&self) -> CaptureIdentity {
        CaptureIdentity(self.terminal.clone())
    }

    pub(crate) fn matches_capture_identity(&self, identity: &CaptureIdentity) -> bool {
        std::sync::Arc::ptr_eq(&self.terminal, &identity.0)
    }

    /// Excludes owner-side mutations with an exclusive borrow, then drains the
    /// actor before taking the existing core/reply snapshot locks. No lock is
    /// held while waiting for the actor, which may still need to parse output
    /// and produce replies to finish draining accepted input.
    pub(crate) async fn capture_terminal_state_draft(
        &mut self,
        limits: DraftLimits,
        timeout: Duration,
    ) -> Result<PaneStateDraft, String> {
        TerminalDraftPause::begin(self, timeout)
            .await?
            .capture(limits)
            .await
    }
}

#[cfg(test)]
impl PaneRuntime {
    pub(crate) fn test_for_draft_capture(bytes: &[u8]) -> Self {
        let (mut runtime, _) = Self::test_with_channel(40, 5);
        runtime.detect_handle.take().unwrap().abort();
        runtime.compression.abort();
        let (tx, _) = tokio::sync::mpsc::channel(1);
        let mut native =
            crate::ghostty::Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap();
        native.write(bytes);
        runtime.terminal = std::sync::Arc::new(super::PaneTerminal::new(
            super::GhosttyPaneTerminal::new(native, tx).unwrap(),
        ));
        runtime
    }

    pub(crate) fn test_for_draft_capture_with_delayed_detector(
        bytes: &[u8],
    ) -> (Self, tokio::sync::oneshot::Sender<()>) {
        Self::test_for_draft_capture_with_publishing_detector(bytes, None)
    }

    pub(crate) fn test_for_draft_capture_with_publishing_detector(
        bytes: &[u8],
        publication: Option<(
            tokio::sync::mpsc::Sender<crate::events::AppEvent>,
            Vec<crate::events::AppEvent>,
        )>,
    ) -> (Self, tokio::sync::oneshot::Sender<()>) {
        let mut runtime = Self::test_for_draft_capture(bytes);
        let (controller, mut worker) = super::detection_pause::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let detector = tokio::spawn(async move {
            if wait.await.is_err() {
                return;
            }
            if let Some((sender, events)) = publication {
                for event in events {
                    sender.send(event).await.unwrap();
                }
            }
            while worker.checkpoint().await {
                worker.changed().await;
            }
        });
        runtime.detect_handle = Some(detector.abort_handle());
        runtime.detection_pause = Some(controller);
        (runtime, release)
    }
}

struct TerminalDraftPause<'a> {
    runtime: &'a mut PaneRuntime,
    actor: Option<crate::pty::actor::CapturePause>,
    timeout: Duration,
    // Explicit completion waits for actor resume before releasing the detector.
    // Cancellation/unwind queues actor cleanup first, without awaiting its ack.
    _detector: Option<super::detection_pause::Paused>,
}

impl<'a> TerminalDraftPause<'a> {
    async fn capture(self, limits: DraftLimits) -> Result<PaneStateDraft, String> {
        let draft = self.runtime.terminal.ghostty.capture_state_draft(limits);
        let resumed = self.resume().await;
        match (draft, resumed) {
            (Ok(draft), Ok(())) => Ok(draft),
            (Err(err), Ok(())) => Err(err),
            (Ok(_), Err(err)) => Err(format!(
                "terminal draft captured, but PTY resume failed: {err}"
            )),
            (Err(capture), Err(resume)) => Err(format!(
                "terminal draft capture failed: {capture}; PTY resume failed: {resume}"
            )),
        }
    }

    async fn begin(runtime: &'a mut PaneRuntime, timeout: Duration) -> Result<Self, String> {
        let detector = if runtime.detect_handle.is_some() {
            let controller = runtime
                .detection_pause
                .as_mut()
                .ok_or("terminal draft capture requires an acknowledged detector pause")?;
            Some(controller.pause(timeout).await.map_err(|e| e.to_string())?)
        } else {
            None
        };
        let actor = match &runtime.io {
            super::PaneRuntimeIo::Actor(actor) => Some(
                actor
                    .pause_for_capture(timeout)
                    .await
                    .map_err(|e| e.to_string())?,
            ),
            #[cfg(test)]
            super::PaneRuntimeIo::TestChannel { .. } => None,
        };
        Ok(Self {
            runtime,
            actor,
            timeout,
            _detector: detector,
        })
    }

    async fn resume(mut self) -> Result<(), String> {
        if let Some(actor) = self.actor.take() {
            actor
                .resume(self.timeout)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane::{
        terminal::{state_draft::test_limits, GhosttyPaneTerminal, PaneTerminal},
        PaneRuntimeIo,
    };
    use crate::pty::actor::{PtyIoActor, PtyIoActorConfig, PtyReadResult};
    use bytes::Bytes;
    use std::{
        io::{Read, Write},
        os::{fd::OwnedFd, unix::net::UnixStream},
        sync::{mpsc as channel, Arc},
    };
    use tokio::sync::mpsc;

    const TIMEOUT: Duration = Duration::from_secs(2);

    fn fixture() -> (PaneRuntime, UnixStream, channel::Receiver<Vec<u8>>) {
        let (mut runtime, _) = PaneRuntime::test_with_channel(40, 5);
        runtime.detect_handle.take().unwrap().abort();
        runtime.compression.abort();
        let (responses, _) = mpsc::channel(1);
        let native =
            crate::ghostty::Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap();
        runtime.terminal = Arc::new(PaneTerminal::new(
            GhosttyPaneTerminal::new(native, responses.clone()).unwrap(),
        ));
        let (actor, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(TIMEOUT)).unwrap();
        peer.set_write_timeout(Some(TIMEOUT)).unwrap();
        let terminal = Arc::clone(&runtime.terminal);
        let pane_id = runtime.pane_id;
        let (read_tx, read_rx) = channel::channel();
        runtime.io = PaneRuntimeIo::Actor(
            PtyIoActor::spawn(PtyIoActorConfig {
                pane_id: pane_id.raw(),
                master_fd: OwnedFd::from(actor),
                initially_quiesced: false,
                on_read: Box::new(move |bytes| {
                    let result = terminal.process_pty_bytes(pane_id, 0, bytes, &responses);
                    read_tx.send(bytes.to_vec()).unwrap();
                    PtyReadResult {
                        terminal_responses: result.terminal_responses,
                    }
                }),
                on_reader_exit: None,
            })
            .unwrap(),
        );
        (runtime, peer, read_rx)
    }

    fn feed(peer: &mut UnixStream, reads: &channel::Receiver<Vec<u8>>, bytes: &[u8]) {
        peer.write_all(bytes).unwrap();
        let mut observed = Vec::new();
        while observed.len() < bytes.len() {
            observed.extend(reads.recv_timeout(TIMEOUT).unwrap());
        }
        assert_eq!(observed, bytes);
    }

    #[tokio::test]
    #[ignore = "non-gating populated PTY actor scaling profile"]
    async fn capture_actor_output_scale_profile() {
        // Exercise the ordinary actor loop with no active capture, including
        // actual PTY reads, tracked parsing and populated retained history.
        // Fixed geometry is the fixture's 40x5 for every pane/cardinality.
        for count in [1, 15] {
            let mut panes: Vec<_> = (0..count).map(|_| fixture()).collect();
            for (_, peer, reads) in &mut panes {
                feed(peer, reads, "populated history\r\n".repeat(1000).as_bytes());
            }
            for sample in 0..3 {
                let started = std::time::Instant::now();
                for _ in 0..5000 {
                    for (_, peer, reads) in &mut panes {
                        feed(peer, reads, b"output\x1b[31mcolored\x1b[0m\r\n");
                    }
                }
                eprintln!(
                    "capture_actor_scale panes={count} sample={sample} elapsed_us={}",
                    started.elapsed().as_micros()
                );
            }
            for (runtime, _, _) in panes {
                runtime.shutdown();
            }
        }
    }

    fn assert_input_resumed(runtime: &PaneRuntime, peer: &mut UnixStream) {
        let deadline = std::time::Instant::now() + TIMEOUT;
        while runtime
            .try_send_bytes(Bytes::from_static(b"resumed"))
            .is_err()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "actor did not acknowledge cancellation"
            );
            std::thread::yield_now();
        }
        let mut received = [0; 7];
        peer.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"resumed");
    }

    fn attach_basic_detector(runtime: &mut PaneRuntime) -> mpsc::Receiver<crate::events::AppEvent> {
        let (events, events_rx) = mpsc::channel(16);
        let (handle, reset, release, controller) = super::super::spawn_basic_detection_task(
            runtime.pane_id,
            runtime.child_pid.clone(),
            runtime.terminal.clone(),
            runtime.detection_content_seq.clone(),
            runtime.full_lifecycle_authority_active.clone(),
            runtime.self_reported_agent_active.clone(),
            events,
        );
        runtime.detect_handle = Some(handle);
        runtime.detect_reset_notify = reset;
        runtime.pending_release = release;
        runtime.detection_pause = Some(controller);
        events_rx
    }

    #[tokio::test]
    async fn basic_detector_survives_capture_failure_and_actor_resume_failure() {
        let (mut runtime, mut peer, reads) = fixture();
        let _events = attach_basic_detector(&mut runtime);
        feed(&mut peer, &reads, b"\x1b]2;pending");
        let mut limits = test_limits();
        limits.native_bytes = 0;
        assert!(runtime
            .capture_terminal_state_draft(limits, TIMEOUT)
            .await
            .is_err());
        assert_input_resumed(&runtime, &mut peer);
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .unwrap();
        assert!(!runtime.detect_handle.as_ref().unwrap().is_finished());
        let pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT)
            .await
            .unwrap();
        pause.runtime.io.shutdown();
        let err = pause.capture(test_limits()).await.err().unwrap();
        assert!(err.contains("PTY resume failed"), "{err}");
        // Actor failure must not leave the unrelated detector parked forever.
        let detector = runtime
            .detection_pause
            .as_mut()
            .unwrap()
            .pause(TIMEOUT)
            .await
            .unwrap();
        drop(detector);
        assert!(!runtime.detect_handle.as_ref().unwrap().is_finished());
    }

    #[tokio::test]
    async fn spawned_detector_and_actor_can_be_paused_and_resumed_repeatedly() {
        use crate::pane::{AgentDetection, PaneLaunchEnv};
        let (events, _event_rx) = mpsc::channel(16);
        let mut runtime = PaneRuntime::spawn_shell_command(
            crate::layout::PaneId::from_raw(42),
            5,
            40,
            std::env::temp_dir(),
            "cat",
            &PaneLaunchEnv::default(),
            AgentDetection::Enabled,
            100_000,
            crate::terminal_theme::TerminalTheme::default(),
            None,
            events,
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(crate::render_signal::RenderSignal::new()),
        )
        .unwrap();
        for _ in 0..3 {
            let pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT)
                .await
                .unwrap();
            assert!(!pause.runtime.detect_handle.as_ref().unwrap().is_finished());
            pause.resume().await.unwrap();
        }
        runtime.shutdown();
    }

    #[tokio::test]
    async fn spawned_runtime_captures_partial_parser_state_without_replacing_terminal() {
        use crate::pane::{AgentDetection, PaneLaunchEnv};

        // The child writes the prefix through a real PTY, then waits for input.
        // No test terminal replacement or direct writes into the source parser.
        for (prefix, suffix) in [
            (&b"ready\x1b[38;2;10;20;"[..], &b"30mX"[..]),
            (&b"ready\x1b]2;partial"[..], &b" title\x07X"[..]),
            (&b"ready\xf0\x9f"[..], &b"\x98\x80X"[..]),
            (
                &b"history0\r\nhistory1\r\nhistory2\r\nhistory3\r\nhistory4\r\nhistory5\r\nprimary\x1b[?1049halt\x1b[38;2;10;20;"[..],
                &b"30mX\x1b[?1049l"[..],
            ),
        ] {
            let octal = |bytes: &[u8]| {
                bytes.iter().map(|b| format!("\\{b:03o}")).collect::<String>()
            };
            let command = format!(
                "stty -echo -onlcr; printf '{}'; read -r gate; printf '{}'; read -r gate",
                octal(prefix), octal(suffix)
            );
            let (events, _event_rx) = mpsc::channel(128);
            let mut runtime = PaneRuntime::spawn_shell_command(
                crate::layout::PaneId::from_raw(42),
                5,
                40,
                std::env::temp_dir(),
                &command,
                &PaneLaunchEnv::default(),
                AgentDetection::Disabled,
                100_000,
                crate::terminal_theme::TerminalTheme::default(),
                None,
                events,
                Arc::new(tokio::sync::Notify::new()),
                Arc::new(crate::render_signal::RenderSignal::new()),
            )
            .unwrap();
            let (tx, _rx) = mpsc::channel(128);
            let expected = GhosttyPaneTerminal::new(
                crate::ghostty::Terminal::new(40, 5, 100_000).unwrap(),
                tx.clone(),
            )
            .unwrap();
            expected.process_pty_bytes(runtime.pane_id, 0, prefix, &tx);
            expected.process_pty_bytes(runtime.pane_id, 0, suffix, &tx);

            // PTY reads can split anywhere, including before the partial suffix.
            // Retry until the captured parser continues to the expected result.
            // The child cannot advance past the cut until we explicitly release it.
            let restored = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(draft) = runtime
                        .capture_terminal_state_draft(test_limits(), TIMEOUT)
                        .await
                    {
                        let restored = GhosttyPaneTerminal::restore_state_draft(
                            draft,
                            test_limits(),
                            tx.clone(),
                        )
                        .unwrap();
                        restored.process_pty_bytes(runtime.pane_id, 0, suffix, &tx);
                        if restored.visible_ansi() == expected.visible_ansi()
                            && restored.terminal_title() == expected.terminal_title()
                            && restored.recent_text(100) == expected.recent_text(100)
                        {
                            break restored;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("real spawned terminal must preserve the unfinished prefix");
            runtime.try_send_bytes(Bytes::from_static(b"go\n")).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while runtime.visible_ansi() != restored.visible_ansi()
                    || runtime.terminal_title() != restored.terminal_title()
                    || runtime.terminal.ghostty.recent_text(100) != restored.recent_text(100)
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("original parser must continue identically after capture");
            assert_eq!(runtime.terminal_title(), restored.terminal_title());
            assert_eq!(
                runtime.terminal.ghostty.recent_text(100),
                restored.recent_text(100)
            );
            runtime.shutdown();
        }
    }

    #[tokio::test]
    async fn actor_capture_restores_partial_input_and_resumes_original() {
        let (mut runtime, mut peer, reads) = fixture();
        feed(
            &mut peer,
            &reads,
            b"primary\r\n\x1b[?1049h\x1b[Halt\x1b[6n\x1b[38;2;10;20;",
        );
        let draft = runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .unwrap();
        // This pre-cut query was returned by on_read, then drained by the actor.
        // It is neither lost nor copied into the restored terminal's reply queue.
        let mut query_reply = [0; 6];
        peer.read_exact(&mut query_reply).unwrap();
        assert_eq!(&query_reply, b"\x1b[1;4R");
        assert_input_resumed(&runtime, &mut peer);

        let (tx, mut rx) = mpsc::channel(8);
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, test_limits(), tx.clone()).unwrap();
        assert!(rx.try_recv().is_err());
        let suffix = b"30mX\x1b[?1049l\x1b[6n";
        feed(&mut peer, &reads, suffix);
        let effects = restored.process_pty_bytes(runtime.pane_id, 0, suffix, &tx);
        assert_eq!(restored.visible_ansi(), runtime.visible_ansi());
        let expected: Vec<u8> = effects.terminal_responses.into_iter().flatten().collect();
        assert!(!expected.is_empty());
        let mut actual = vec![0; expected.len()];
        peer.read_exact(&mut actual).unwrap();
        assert_eq!(actual, expected);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn capture_rejection_resumes_without_losing_parser_continuation() {
        let (mut runtime, mut peer, reads) = fixture();
        feed(&mut peer, &reads, b"\x1b]2;partial");
        let mut limits = test_limits();
        limits.native_bytes = 0;
        let err = runtime
            .capture_terminal_state_draft(limits, TIMEOUT)
            .await
            .err()
            .unwrap();
        assert!(err.contains("native snapshot exceeds limit"), "{err}");
        assert_input_resumed(&runtime, &mut peer);
        feed(&mut peer, &reads, b" title\x07after");
        assert_eq!(runtime.terminal_title().as_deref(), Some("partial title"));
        assert!(runtime.visible_text().contains("after"));
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn preexisting_pause_is_not_resumed_by_rejected_capture() {
        let (mut runtime, mut peer, _) = fixture();
        let _events = attach_basic_detector(&mut runtime);
        runtime.pause_handoff_reader(TIMEOUT).unwrap();
        let err = runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .err()
            .unwrap();
        assert!(err.contains("already in progress"), "{err}");
        assert!(runtime
            .try_send_bytes(Bytes::from_static(b"blocked"))
            .is_err());
        let detector = runtime
            .detection_pause
            .as_mut()
            .unwrap()
            .pause(TIMEOUT)
            .await
            .unwrap();
        drop(detector);
        runtime.io.set_handoff_paused(false).unwrap();
        assert_input_resumed(&runtime, &mut peer);
    }

    #[tokio::test]
    async fn detector_is_rejected_before_actor_admission_changes() {
        let (mut runtime, mut peer, _) = fixture();
        runtime.detect_handle = Some(tokio::spawn(std::future::pending::<()>()).abort_handle());
        let err = runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .err()
            .unwrap();
        assert!(err.contains("acknowledged detector pause"), "{err}");
        assert_input_resumed(&runtime, &mut peer);
    }

    #[tokio::test]
    async fn actor_loss_does_not_report_successful_capture_or_hide_capture_error() {
        for fail_capture in [false, true] {
            let (mut runtime, _peer, _) = fixture();
            let pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT)
                .await
                .unwrap();
            // Shutdown is queued before resume on the same control channel.
            pause.runtime.io.shutdown();
            let mut limits = test_limits();
            if fail_capture {
                limits.native_bytes = 0;
            }
            let err = pause.capture(limits).await.err().unwrap();
            assert!(err.contains("PTY resume failed"), "{err}");
            if fail_capture {
                assert!(err.contains("native snapshot exceeds limit"), "{err}");
            } else {
                assert!(err.contains("terminal draft captured"), "{err}");
            }
        }
    }

    #[tokio::test]
    async fn unwinding_capture_scope_resumes_actor() {
        let (mut runtime, mut peer, _) = fixture();
        let _events = attach_basic_detector(&mut runtime);
        let pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT)
            .await
            .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _pause = pause;
            panic!("test capture unwind");
        }));
        assert!(result.is_err());
        assert_input_resumed(&runtime, &mut peer);
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_capture_while_waiting_for_detector_leaves_actor_running() {
        use std::{future::Future, task::Poll};
        let (mut runtime, mut peer, _) = fixture();
        let (controller, mut worker) = super::super::detection_pause::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let detector = tokio::spawn(async move {
            release_rx.await.unwrap();
            while worker.checkpoint().await {
                worker.changed().await;
            }
        });
        runtime.detect_handle = Some(detector.abort_handle());
        runtime.detection_pause = Some(controller);
        let mut capture = Box::pin(runtime.capture_terminal_state_draft(test_limits(), TIMEOUT));
        std::future::poll_fn(|cx| {
            assert!(capture.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(capture);
        assert_input_resumed(&runtime, &mut peer);
        release_tx.send(()).unwrap();
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .await
            .unwrap();
        assert_input_resumed(&runtime, &mut peer);
    }
}
