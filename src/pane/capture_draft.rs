//! Private terminal-only capture through the real Unix PTY actor.
//!
//! This is not a runtime handoff or an event ownership cut. Queued application
//! effects, child-exit state and detector state are not captured here. Runtimes
//! with a detector are rejected until cooperative detector suspension exists.
//! Keep this disconnected from the production handoff protocol.

use super::{
    terminal::state_draft::{DraftLimits, PaneStateDraft},
    PaneRuntime,
};
use std::time::Duration;

// Deliberately opt-in until the complete runtime/effect ownership cut exists.
#[allow(dead_code)]
impl PaneRuntime {
    /// Excludes owner-side mutations with an exclusive borrow, then drains the
    /// actor before taking the existing core/reply snapshot locks. No lock is
    /// held while waiting for the actor, which may still need to parse output
    /// and produce replies to finish draining accepted input.
    pub(super) fn capture_terminal_state_draft(
        &mut self,
        limits: DraftLimits,
        timeout: Duration,
    ) -> Result<PaneStateDraft, String> {
        TerminalDraftPause::begin(self, timeout)?.capture(limits)
    }
}

struct TerminalDraftPause<'a> {
    runtime: &'a mut PaneRuntime,
    active: bool,
}

impl<'a> TerminalDraftPause<'a> {
    fn capture(self, limits: DraftLimits) -> Result<PaneStateDraft, String> {
        let draft = self.runtime.terminal.ghostty.capture_state_draft(limits);
        let resumed = self.resume();
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

    fn begin(runtime: &'a mut PaneRuntime, timeout: Duration) -> Result<Self, String> {
        if runtime.detect_handle.is_some() {
            return Err("terminal draft capture requires an acknowledged detector pause".into());
        }
        // Failure belongs to begin_handoff, including its timeout rollback.
        // Do not resume somebody else's pre-existing pause on rejection.
        runtime
            .io
            .begin_handoff(timeout)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            runtime,
            active: true,
        })
    }

    fn resume(mut self) -> Result<(), String> {
        // Report a failed acknowledgement instead of retrying implicitly and
        // pretending that ownership is known. Drop is only the unwind fallback.
        self.active = false;
        self.runtime
            .io
            .set_handoff_paused(false)
            .map_err(|e| e.to_string())
    }
}

impl Drop for TerminalDraftPause<'_> {
    fn drop(&mut self) {
        if self.active {
            self.active = false;
            if let Err(err) = self.runtime.io.set_handoff_paused(false) {
                tracing::warn!(pane = self.runtime.pane_id.raw(), %err,
                    "failed to resume PTY after terminal draft unwind");
            }
        }
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

    fn assert_input_resumed(runtime: &PaneRuntime, peer: &mut UnixStream) {
        runtime
            .try_send_bytes(Bytes::from_static(b"resumed"))
            .unwrap();
        let mut received = [0; 7];
        peer.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"resumed");
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
            .err()
            .unwrap();
        assert!(err.contains("native snapshot exceeds limit"), "{err}");
        assert_input_resumed(&runtime, &mut peer);
        feed(&mut peer, &reads, b" title\x07after");
        assert_eq!(runtime.terminal_title().as_deref(), Some("partial title"));
        assert!(runtime.visible_text().contains("after"));
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .unwrap();
    }

    #[tokio::test]
    async fn preexisting_pause_is_not_resumed_by_rejected_capture() {
        let (mut runtime, mut peer, _) = fixture();
        runtime.pause_handoff_reader(TIMEOUT).unwrap();
        let err = runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .err()
            .unwrap();
        assert!(err.contains("already in progress"), "{err}");
        assert!(runtime
            .try_send_bytes(Bytes::from_static(b"blocked"))
            .is_err());
        runtime.io.set_handoff_paused(false).unwrap();
        assert_input_resumed(&runtime, &mut peer);
    }

    #[tokio::test]
    async fn detector_is_rejected_before_actor_admission_changes() {
        let (mut runtime, mut peer, _) = fixture();
        runtime.detect_handle = Some(tokio::spawn(std::future::pending::<()>()).abort_handle());
        let err = runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .err()
            .unwrap();
        assert!(err.contains("acknowledged detector pause"), "{err}");
        assert_input_resumed(&runtime, &mut peer);
    }

    #[tokio::test]
    async fn actor_loss_does_not_report_successful_capture_or_hide_capture_error() {
        for fail_capture in [false, true] {
            let (mut runtime, _peer, _) = fixture();
            let pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT).unwrap();
            // Shutdown is queued before resume on the same control channel.
            pause.runtime.io.shutdown();
            let mut limits = test_limits();
            if fail_capture {
                limits.native_bytes = 0;
            }
            let err = pause.capture(limits).err().unwrap();
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
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _pause = TerminalDraftPause::begin(&mut runtime, TIMEOUT).unwrap();
            panic!("test capture unwind");
        }));
        assert!(result.is_err());
        assert_input_resumed(&runtime, &mut peer);
        runtime
            .capture_terminal_state_draft(test_limits(), TIMEOUT)
            .unwrap();
    }
}
