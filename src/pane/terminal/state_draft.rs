//! Coordinated in-memory capture primitive, NOT a handoff-ready format.
//!
//! Retained graphics/glyph state is rejected; empty graphics policy is preserved.
//! This still is not a complete handoff format. The caller
//! must fence readers and control producers: replies/notifications already
//! returned from process_pty_bytes or queued in PTY actors are outside this lock.
//! Do not expose this draft through runtime negotiation or transport.
//! Restored callback queues require explicit consumption: process_pty_bytes
//! discards pre-existing callback effects as historical, not newly received.

use super::{policy_snapshot::PolicySnapshot, *};
use crate::pane::cursor::CursorSettleSnapshot;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

#[derive(Clone, Copy)]
pub(super) struct DraftLimits {
    pub native_bytes: usize,
    pub caller_bytes: usize,
    pub reply_bytes: usize,
    pub callback_bytes: usize,
    pub native_allocation_bytes: usize,
    pub continuation_bytes: usize,
    pub graphics_policy_bytes: usize,
    pub clipboard_write_bytes: usize,
}

pub(super) struct PaneStateDraft {
    native: Vec<u8>,
    caller: Vec<u8>,
    callbacks: crate::ghostty::TerminalCallbackSnapshot,
    graphics_policy: crate::ghostty::GraphicsPolicySnapshot,
    clipboard_write: Vec<u8>,
    replies: Vec<Bytes>,
    #[cfg(windows)]
    observer: Option<crate::ghostty::TrackedRowSnapshot>,
}

#[derive(Serialize)]
struct CallerRef<'a> {
    version: u8,
    windows: bool,
    policy: PolicySnapshot,
    keyboard: &'a KittyKeyboardTracker,
    color: &'a DefaultColorOscTracker,
    color_events: &'a DefaultColorEventTracker,
    c1: &'a C1XtgettcapQueryTracker,
    debug: &'a OscDebugTracker,
    agent: &'a AgentOscStateTracker,
    cursor: &'a DecscusrTracker,
    settle: CursorSettleSnapshot,
    #[cfg(windows)]
    fallback: &'a windows_recent_fallback::Cache,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallerOwned {
    version: u8,
    windows: bool,
    policy: PolicySnapshot,
    keyboard: KittyKeyboardTracker,
    color: DefaultColorOscTracker,
    color_events: DefaultColorEventTracker,
    c1: C1XtgettcapQueryTracker,
    debug: OscDebugTracker,
    agent: AgentOscStateTracker,
    cursor: DecscusrTracker,
    settle: CursorSettleSnapshot,
    #[cfg(windows)]
    fallback: windows_recent_fallback::Cache,
}

struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let len = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("caller snapshot length overflow"))?;
        if len > self.limit {
            return Err(io::Error::other("caller snapshot exceeds limit"));
        }
        if len > self.bytes.capacity() {
            let capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(1024)
                .max(len)
                .min(self.limit);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(io::Error::other)?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn check_replies(replies: &[Bytes], limit: usize) -> Result<(), String> {
    // Bytes clones share backing storage. Count logical payload and entries,
    // not retained backing capacities or allocator bookkeeping.
    let size = replies
        .len()
        .checked_mul(std::mem::size_of::<Bytes>())
        .and_then(|size| {
            replies
                .iter()
                .try_fold(size, |total, reply| total.checked_add(reply.len()))
        });
    if size.is_none_or(|size| size > limit) {
        return Err("pending replies exceed snapshot limit".into());
    }
    Ok(())
}

// These draft methods are exercised before production graphics/fencing gates
// exist. Keep them opt-in and disconnected from the legacy handoff.
#[allow(dead_code)]
impl GhosttyPaneTerminal {
    /// Capture a private partial draft. Graphics/glyph preservation and external
    /// reader/event/writer fencing are NOT established by this method.
    pub(super) fn capture_state_draft(
        &self,
        limits: DraftLimits,
    ) -> Result<PaneStateDraft, String> {
        let core = self.core.lock().map_err(|_| "poisoned terminal core")?;
        let exclusions = core
            .terminal
            .snapshot_graphics_exclusions()
            .map_err(|e| e.to_string())?;
        if exclusions != 0 {
            return Err(format!(
                "unsupported graphics/glyph snapshot state: {exclusions:#x}"
            ));
        }
        // This order is the existing core -> callback-reply order. Never reverse it.
        // Native encode_alloc copies continuation and calls the pure core encoder
        // with an allocating writer; it does not invoke terminal callbacks.
        let replies = self
            .pending_pty_responses
            .lock()
            .map_err(|_| "poisoned terminal reply queue")?;
        let now = Instant::now();
        check_replies(&replies, limits.reply_bytes)?;
        let mut copied_replies = Vec::new();
        copied_replies
            .try_reserve_exact(replies.len())
            .map_err(|e| e.to_string())?;
        copied_replies.extend(replies.iter().cloned());
        let callbacks = core
            .terminal
            .callback_snapshot(limits.callback_bytes)
            .map_err(|e| e.to_string())?;
        let caller = CallerRef {
            version: 1,
            windows: cfg!(windows),
            policy: PolicySnapshot::capture(&core),
            keyboard: &core.kitty_keyboard,
            color: &core.default_color_tracker,
            color_events: &core.default_color_event_tracker,
            c1: &core.c1_xtgettcap_tracker,
            debug: &core.osc_debug_tracker,
            agent: &core.agent_osc_state,
            cursor: &core.decscusr_tracker,
            settle: CursorSettleSnapshot::capture(&core.cursor_settle_state, now)?,
            #[cfg(windows)]
            fallback: &core.recent_fallback,
        };
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            limit: limits.caller_bytes,
        };
        serde_json::to_writer(&mut writer, &caller).map_err(|e| e.to_string())?;
        let native = core.terminal.snapshot_bytes().map_err(|e| e.to_string())?;
        // Native encoding allocates before this check; this is an encoded-size
        // limit, not a native encoder allocation budget.
        if native.len() > limits.native_bytes {
            return Err("native snapshot exceeds limit".into());
        }
        Ok(PaneStateDraft {
            clipboard_write: core
                .terminal
                .clipboard_write_snapshot(limits.clipboard_write_bytes)
                .map_err(|e| e.to_string())?,
            graphics_policy: core
                .terminal
                .graphics_policy_snapshot(limits.graphics_policy_bytes)
                .map_err(|e| e.to_string())?,
            native,
            caller: writer.bytes,
            callbacks,
            replies: copied_replies,
            #[cfg(windows)]
            observer: core
                .terminal
                .tracked_row_snapshot()
                .map_err(|e| e.to_string())?,
        })
    }

    /// Build an unpublished partial draft terminal, never a handoff-ready owner.
    /// External effect queues and unsupported graphics remain caller obligations.
    pub(super) fn restore_state_draft(
        draft: PaneStateDraft,
        limits: DraftLimits,
        writer: mpsc::Sender<Bytes>,
    ) -> Result<Self, String> {
        if draft.native.len() > limits.native_bytes || draft.caller.len() > limits.caller_bytes {
            return Err("pane snapshot exceeds encoded limits".into());
        }
        check_replies(&draft.replies, limits.reply_bytes)?;
        let caller: CallerOwned =
            serde_json::from_slice(&draft.caller).map_err(|e| e.to_string())?;
        if caller.version != 1 || caller.windows != cfg!(windows) {
            return Err("incompatible pane caller snapshot".into());
        }
        let mut terminal = crate::ghostty::Terminal::from_snapshot_with_budget(
            &draft.native,
            limits.continuation_bytes,
            limits.native_allocation_bytes,
        )
        .map_err(|e| e.to_string())?;
        terminal
            .restore_graphics_policy_snapshot(&draft.graphics_policy, limits.graphics_policy_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_clipboard_write_snapshot(&draft.clipboard_write, limits.clipboard_write_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_callback_snapshot(draft.callbacks, limits.callback_bytes)
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        terminal
            .restore_tracked_row_snapshot(draft.observer)
            .map_err(|e| e.to_string())?;
        let result = Self::new(terminal, writer).map_err(|e| e.to_string())?;
        let mut core = result
            .core
            .lock()
            .map_err(|_| "poisoned restored terminal core")?;
        // Start all relative presentation timers at one instant after decoding.
        let settle = caller.settle.restore(Instant::now())?;
        caller.policy.apply(&mut core);
        core.kitty_keyboard = caller.keyboard;
        core.default_color_tracker = caller.color;
        core.default_color_event_tracker = caller.color_events;
        core.c1_xtgettcap_tracker = caller.c1;
        core.osc_debug_tracker = caller.debug;
        core.agent_osc_state = caller.agent;
        core.decscusr_tracker = caller.cursor;
        core.cursor_settle_state = settle;
        #[cfg(windows)]
        {
            core.recent_fallback = caller.fallback;
        }
        *result
            .pending_pty_responses
            .lock()
            .map_err(|_| "poisoned restored reply queue")? = draft.replies;
        drop(core);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> DraftLimits {
        DraftLimits {
            native_bytes: 16 << 20,
            caller_bytes: 1 << 20,
            reply_bytes: 1 << 20,
            callback_bytes: 1 << 20,
            native_allocation_bytes: 64 << 20,
            continuation_bytes: 4096,
            graphics_policy_bytes: 16384,
            clipboard_write_bytes: 1 << 20,
        }
    }

    fn pane(tx: &mpsc::Sender<Bytes>) -> GhosttyPaneTerminal {
        GhosttyPaneTerminal::new(
            crate::ghostty::Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap(),
            tx.clone(),
        )
        .unwrap()
    }

    fn feed(
        pane: &GhosttyPaneTerminal,
        tx: &mpsc::Sender<Bytes>,
        bytes: &[u8],
    ) -> ProcessBytesResult {
        pane.process_pty_bytes(PaneId::from_raw(1), 0, bytes, tx)
    }

    fn assert_effects(left: ProcessBytesResult, right: ProcessBytesResult) {
        assert_eq!(left.terminal_title_changed, right.terminal_title_changed);
        assert_eq!(left.terminal_responses, right.terminal_responses);
        assert_eq!(left.terminal_bells, right.terminal_bells);
        assert_eq!(left.reported_cwd, right.reported_cwd);
        assert_eq!(left.clipboard_writes, right.clipboard_writes);
    }

    #[test]
    fn pane_state_draft_preserves_clipboard_transaction_and_pending_reply() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = pane(&tx);
        let begin =
            b"\x1b]5522;type=write:id=c1\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;SGV\x1b\\";
        let finish =
            b"\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;sbG8=\x1b\\\x1b]5522;type=wdata\x1b\\";
        feed(&source, &tx, begin);
        let restricted = DraftLimits {
            clipboard_write_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert!(rx.try_recv().is_err());
        let expected = feed(&source, &tx, finish);
        assert_eq!(expected.clipboard_writes, vec![b"Hello".to_vec()]);
        assert!(!expected.terminal_responses.is_empty());
        assert_effects(expected, feed(&restored, &tx, finish));
        assert!(restored
            .core
            .lock()
            .unwrap()
            .terminal
            .clipboard_write_snapshot(0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn pane_state_draft_preserves_graphics_policy_and_enforces_directory_budget() {
        let (tx, _rx) = mpsc::channel(16);
        let source = pane(&tx);
        {
            let mut core = source.core.lock().unwrap();
            core.terminal.enable_kitty_graphics().unwrap();
            core.terminal.set_kitty_source_forwarding(false).unwrap();
        }
        let restricted = DraftLimits {
            graphics_policy_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        for bytes in [b"\x1b[?1049h".as_slice(), b"\x1b[?1049l"] {
            assert_effects(feed(&source, &tx, bytes), feed(&restored, &tx, bytes));
            assert_eq!(
                source
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .graphics_policy_snapshot(16384)
                    .unwrap(),
                restored
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .graphics_policy_snapshot(16384)
                    .unwrap()
            );
        }
    }

    #[test]
    fn pane_state_draft_rejects_graphics_without_mutation() {
        let (tx, mut rx) = mpsc::channel(32);
        for prefix in [b"\x1b_".as_slice(), b"\x1b_G", b"\x1b_25a1;r;"] {
            let source = pane(&tx);
            source.core.lock().unwrap().terminal.write(prefix);
            let before = source
                .core
                .lock()
                .unwrap()
                .terminal
                .snapshot_bytes()
                .unwrap();
            assert!(source
                .capture_state_draft(limits())
                .err()
                .unwrap()
                .contains("unsupported graphics/glyph"));
            assert_eq!(
                source
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .snapshot_bytes()
                    .unwrap(),
                before
            );
            assert!(source.pending_pty_responses.lock().unwrap().is_empty());
            assert!(rx.try_recv().is_err());
            source.core.lock().unwrap().terminal.write(b"\x1b\\");
            source.capture_state_draft(limits()).unwrap();
        }
    }

    #[test]
    fn pane_state_draft_continues_partial_native_and_caller_protocols() {
        let (tx, _rx) = mpsc::channel(16);
        for sequence in [
            "界é".as_bytes(),
            b"\x1b[31mRED\x1b[0m",
            b"\x1b]2;agent title\x07",
            b"\x1b]10;#123456\x07\x1b]10;?\x07",
            b"\x1b[>3u\x1b[<u",
            b"\x1b[3 q\x1b[0 q",
            b"\x90+q524742\x9c",
            b"\x1bP$qm\x1b\\",
            b"\x1b]9;4;1;25\x07",
            b"\x1b[?1049hALT\x1b[?1049l",
        ] {
            for cut in 0..=sequence.len() {
                let source = pane(&tx);
                feed(&source, &tx, &sequence[..cut]);
                let draft = source.capture_state_draft(limits()).unwrap();
                let restored =
                    GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
                let draft = restored.capture_state_draft(limits()).unwrap();
                let restored =
                    GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
                for suffix in [
                    &sequence[cut..],
                    b"\x1b]10;?\x07\x1b[6n".as_slice(),
                    b"\x1b[0 qtail",
                ] {
                    assert_effects(feed(&source, &tx, suffix), feed(&restored, &tx, suffix));
                    let source = source.core.lock().unwrap();
                    let restored = restored.core.lock().unwrap();
                    assert_eq!(
                        source
                            .terminal
                            .screen_vt(crate::ghostty::ActiveScreen::Primary)
                            .unwrap(),
                        restored
                            .terminal
                            .screen_vt(crate::ghostty::ActiveScreen::Primary)
                            .unwrap(),
                        "cut={cut} sequence={sequence:?}"
                    );
                    assert_eq!(
                        PolicySnapshot::capture(&source),
                        PolicySnapshot::capture(&restored)
                    );
                    assert_eq!(
                        serde_json::to_value(&source.agent_osc_state).unwrap(),
                        serde_json::to_value(&restored.agent_osc_state).unwrap()
                    );
                    assert_eq!(
                        serde_json::to_value(&source.kitty_keyboard).unwrap(),
                        serde_json::to_value(&restored.kitty_keyboard).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn pane_state_draft_preserves_queued_replies_and_callback_effects_without_draining() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = pane(&tx);
        source
            .core
            .lock()
            .unwrap()
            .terminal
            .write(b"\x07\x1b[6n\x1b]7;file://localhost/tmp/snapshot\x07\x1b]52;c;YWJj\x07");
        let before = source.pending_pty_responses.lock().unwrap().clone();
        assert_eq!(before, vec![Bytes::from_static(b"\x1b[1;1R")]);
        let callbacks = source
            .core
            .lock()
            .unwrap()
            .terminal
            .callback_snapshot(1 << 20)
            .unwrap();
        assert!(callbacks.bell_count > 0);
        let draft = source.capture_state_draft(limits()).unwrap();
        assert_eq!(*source.pending_pty_responses.lock().unwrap(), before);
        assert_eq!(
            source
                .core
                .lock()
                .unwrap()
                .terminal
                .callback_snapshot(1 << 20)
                .unwrap(),
            callbacks
        );
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert_eq!(*restored.pending_pty_responses.lock().unwrap(), before);
        assert_eq!(
            restored
                .core
                .lock()
                .unwrap()
                .terminal
                .callback_snapshot(1 << 20)
                .unwrap(),
            callbacks
        );
        assert!(rx.try_recv().is_err());
        for pane in [&source, &restored] {
            let mut core = pane.core.lock().unwrap();
            assert_eq!(core.terminal.take_bell_count(), callbacks.bell_count);
            assert_eq!(core.terminal.take_pwd_changes(), callbacks.pwd_changes);
            assert_eq!(
                core.terminal.take_clipboard_writes(),
                callbacks.clipboard_writes
            );
            assert_eq!(core.terminal.take_bell_count(), 0);
            assert!(core.terminal.take_pwd_changes().is_empty());
            assert!(core.terminal.take_clipboard_writes().is_empty());
        }
        assert_effects(feed(&source, &tx, b""), feed(&restored, &tx, b""));
        assert_eq!(*source.pending_pty_responses.lock().unwrap(), before);
        assert_eq!(*restored.pending_pty_responses.lock().unwrap(), before);
        let effects = feed(&source, &tx, b"x");
        assert_eq!(effects.terminal_responses, before);
        assert_effects(effects, feed(&restored, &tx, b"x"));
        assert!(source.pending_pty_responses.lock().unwrap().is_empty());
        assert!(restored.pending_pty_responses.lock().unwrap().is_empty());
        assert!(feed(&source, &tx, b"y").terminal_responses.is_empty());
        assert!(feed(&restored, &tx, b"y").terminal_responses.is_empty());
    }

    #[test]
    fn pane_state_draft_rejects_limits_and_schema_without_changing_source() {
        let (tx, _rx) = mpsc::channel(4);
        let source = pane(&tx);
        source
            .core
            .lock()
            .unwrap()
            .terminal
            .write(b"\x07\x1b[6n\x1b]52;c;YWJj\x07");
        let native = source
            .core
            .lock()
            .unwrap()
            .terminal
            .snapshot_bytes()
            .unwrap();
        let replies = source.pending_pty_responses.lock().unwrap().clone();
        for restricted in [
            DraftLimits {
                native_bytes: 0,
                ..limits()
            },
            DraftLimits {
                caller_bytes: 0,
                ..limits()
            },
            DraftLimits {
                reply_bytes: 0,
                ..limits()
            },
            DraftLimits {
                callback_bytes: 0,
                ..limits()
            },
        ] {
            assert!(source.capture_state_draft(restricted).is_err());
            assert_eq!(
                source
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .snapshot_bytes()
                    .unwrap(),
                native
            );
            assert_eq!(*source.pending_pty_responses.lock().unwrap(), replies);
        }
        for mutate in 0..4 {
            let mut draft = source.capture_state_draft(limits()).unwrap();
            match mutate {
                0 => draft.native.push(0),
                1 => {
                    let mut caller: serde_json::Value =
                        serde_json::from_slice(&draft.caller).unwrap();
                    caller["version"] = serde_json::json!(2);
                    draft.caller = serde_json::to_vec(&caller).unwrap();
                }
                2 => {
                    let mut caller: serde_json::Value =
                        serde_json::from_slice(&draft.caller).unwrap();
                    caller["windows"] = serde_json::json!(!cfg!(windows));
                    draft.caller = serde_json::to_vec(&caller).unwrap();
                }
                _ => {
                    let mut caller: serde_json::Value =
                        serde_json::from_slice(&draft.caller).unwrap();
                    caller.as_object_mut().unwrap().remove("keyboard");
                    draft.caller = serde_json::to_vec(&caller).unwrap();
                }
            }
            assert!(GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).is_err());
        }
        for restricted in [
            DraftLimits {
                caller_bytes: 0,
                ..limits()
            },
            DraftLimits {
                reply_bytes: 0,
                ..limits()
            },
            DraftLimits {
                callback_bytes: 0,
                ..limits()
            },
        ] {
            let draft = source.capture_state_draft(limits()).unwrap();
            assert!(
                GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err()
            );
        }
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(
            draft,
            DraftLimits {
                native_allocation_bytes: 0,
                ..limits()
            },
            tx
        )
        .is_err());
    }

    #[test]
    fn pane_state_draft_rejects_poisoned_locks() {
        let (tx, _rx) = mpsc::channel(4);
        for poison_core in [false, true] {
            let source = pane(&tx);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if poison_core {
                    let _guard = source.core.lock().unwrap();
                    panic!("poison core");
                } else {
                    let _guard = source.pending_pty_responses.lock().unwrap();
                    panic!("poison replies");
                }
            }));
            assert!(source
                .capture_state_draft(limits())
                .err()
                .unwrap()
                .contains("poisoned"));
        }
    }
}
