//! Coordinated pane terminal capture and its live-handoff transfer encoding.
//!
//! In-process drafts preserve retained graphics and owned file attachments.
//! The transfer encoding (`encode_transfer`/`decode_transfer`) carries every
//! domain by value between builds with an identical `terminal_state_codec`;
//! native-file backed images are the only state it cannot carry, and it
//! reports them as dropped. Glyph state and unsupported external producer
//! authority remain rejected at capture.
//! The caller must fence readers and control producers: replies/notifications
//! already returned from process_pty_bytes or queued in PTY actors are outside
//! this lock. Live handoff captures only after its PTY actor quiesce, which
//! drains queued writes and replies and stops reads.
//! Restored callback queues require explicit consumption: process_pty_bytes
//! discards pre-existing callback effects as historical, not newly received.

use super::{policy_snapshot::PolicySnapshot, *};
use crate::pane::cursor::CursorSettleSnapshot;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

fn check_graphics_domains(exclusions: u64) -> Result<(), String> {
    // Dedicated records preserve exactly these domains, not unknown future bits.
    let preserved = crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_APC
        | crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_IMAGES
        | crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_PLACEMENTS
        | crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_LOADING
        | crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_AUTO_IDS
        | crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_BYTES;
    if exclusions & !u64::from(preserved) != 0 {
        return Err(format!(
            "unsupported graphics/glyph snapshot state: {exclusions:#x}"
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct DraftLimits {
    pub native_bytes: usize,
    pub caller_bytes: usize,
    pub reply_bytes: usize,
    pub callback_bytes: usize,
    pub native_allocation_bytes: usize,
    pub continuation_bytes: usize,
    pub graphics_policy_bytes: usize,
    pub graphics: crate::ghostty::GraphicsSnapshotLimits,
    pub clipboard_write_bytes: usize,
    pub dnd_bytes: usize,
    pub handler_bytes: usize,
    pub osc_capture_bytes: usize,
    pub apc_bytes: usize,
}

pub(crate) struct PaneStateDraft {
    native: Vec<u8>,
    caller: Vec<u8>,
    callbacks: crate::ghostty::TerminalCallbackSnapshot,
    graphics_policy: crate::ghostty::GraphicsPolicySnapshot,
    // Absent only for transferred drafts whose file-backed images could not
    // cross the process boundary; restoration then starts graphics-empty.
    graphics: Option<crate::ghostty::GraphicsSnapshot>,
    clipboard_write: Vec<u8>,
    dnd: Vec<u8>,
    handler: Vec<u8>,
    osc_capture: Vec<u8>,
    apc: Vec<u8>,
    replies: Vec<Bytes>,
    #[cfg(windows)]
    observer: Option<crate::ghostty::TrackedRowSnapshot>,
}

impl PaneStateDraft {
    #[cfg(all(test, unix))]
    pub(crate) fn test_restored_text(self) -> String {
        let (tx, _) = tokio::sync::mpsc::channel(1);
        GhosttyPaneTerminal::restore_state_draft(self, test_limits(), tx)
            .unwrap()
            .visible_text()
    }
    /// Charge retained payload and fixed Rust records, not peak native capture
    /// allocations or allocator overhead. Shared attachments are charged per
    /// draft so a batch does not assume a future transport will deduplicate them.
    #[cfg(unix)]
    pub(crate) fn retained_bytes(&self) -> Option<usize> {
        let mut total = std::mem::size_of::<Self>();
        for bytes in [
            &self.native,
            &self.caller,
            &self.clipboard_write,
            &self.dnd,
            &self.handler,
            &self.osc_capture,
            &self.apc,
        ] {
            total = total.checked_add(bytes.len())?;
        }
        if let Some(graphics) = &self.graphics {
            total = total.checked_add(graphics.retained_payload_bytes()?)?;
        }
        total = total.checked_add(self.graphics_policy.retained_payload_bytes()?)?;
        for queue in [
            &self.callbacks.pwd_changes,
            &self.callbacks.clipboard_writes,
        ] {
            total = total.checked_add(queue.len().checked_mul(std::mem::size_of::<Vec<u8>>())?)?;
            for bytes in queue {
                total = total.checked_add(bytes.len())?;
            }
        }
        total = total.checked_add(
            self.replies
                .len()
                .checked_mul(std::mem::size_of::<Bytes>())?,
        )?;
        for reply in &self.replies {
            total = total.checked_add(reply.len())?;
        }
        Some(total)
    }
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
    /// Capture a private partial draft. Glyph preservation and external
    /// reader/event/writer fencing are NOT established by this method.
    pub(in crate::pane) fn capture_state_draft(
        &self,
        limits: DraftLimits,
    ) -> Result<PaneStateDraft, String> {
        let core = self.core.lock().map_err(|_| "poisoned terminal core")?;
        let exclusions = core
            .terminal
            .snapshot_graphics_exclusions()
            .map_err(|e| e.to_string())?;
        check_graphics_domains(exclusions)?;
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
            apc: core
                .terminal
                .apc_snapshot(limits.apc_bytes)
                .map_err(|e| e.to_string())?,
            osc_capture: core
                .terminal
                .osc_capture_snapshot(limits.osc_capture_bytes)
                .map_err(|e| e.to_string())?,
            handler: core
                .terminal
                .handler_snapshot(limits.handler_bytes)
                .map_err(|e| e.to_string())?,
            dnd: core
                .terminal
                .dnd_snapshot(limits.dnd_bytes)
                .map_err(|e| e.to_string())?,
            clipboard_write: core
                .terminal
                .clipboard_write_snapshot(limits.clipboard_write_bytes)
                .map_err(|e| e.to_string())?,
            graphics_policy: core
                .terminal
                .graphics_policy_snapshot(limits.graphics_policy_bytes)
                .map_err(|e| e.to_string())?,
            graphics: Some(
                core.terminal
                    .graphics_snapshot(limits.graphics)
                    .map_err(|e| e.to_string())?,
            ),
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
    /// External effect queues, glyphs and producer authority remain unresolved.
    pub(in crate::pane) fn restore_state_draft(
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
        if let Some(graphics) = &draft.graphics {
            terminal
                .restore_graphics_snapshot(graphics, limits.graphics)
                .map_err(|e| e.to_string())?;
        }
        terminal
            .restore_clipboard_write_snapshot(&draft.clipboard_write, limits.clipboard_write_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_dnd_snapshot(&draft.dnd, limits.dnd_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_handler_snapshot(&draft.handler, limits.handler_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_osc_capture_snapshot(&draft.osc_capture, limits.osc_capture_bytes)
            .map_err(|e| e.to_string())?;
        terminal
            .restore_apc_snapshot(&draft.apc, limits.apc_bytes)
            .map_err(|e| e.to_string())?;
        // Both GSTOR1 and the authoritative APC record duplicate policy.
        // Check after both are installed, before exposing the destination.
        if terminal
            .graphics_policy_snapshot(limits.graphics_policy_bytes)
            .map_err(|e| e.to_string())?
            != draft.graphics_policy
        {
            return Err("inconsistent graphics snapshot policy".into());
        }
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

/// Bump whenever the meaning of any herdr-side draft encoding changes without
/// a matching decode failure, so mismatched builds never exchange exact state.
#[cfg(unix)]
pub(crate) const TERMINAL_STATE_SCHEMA: u32 = 1;
#[cfg(unix)]
const TRANSFER_MAGIC: &[u8] = b"herdr-pane-state";

/// Identity of this build's exact terminal-state codec. Exact state crosses a
/// live handoff only between builds reporting the same identity: the vendored
/// native snapshot format carries no cross-version compatibility guarantee.
#[cfg(unix)]
pub(crate) fn terminal_state_codec() -> String {
    format!(
        "herdr-pane-state-{TERMINAL_STATE_SCHEMA}+{}",
        env!("HERDR_TERMINAL_STATE_CODEC")
    )
}

/// Production budgets for live handoff. The importer only decodes records from
/// a token-authenticated exporter of the same user, but every length is still
/// bounded. Continuation must equal the runtime tracking limit so restored
/// panes keep capturing the same unfinished input after a later handoff.
#[cfg(unix)]
pub(crate) fn handoff_limits() -> DraftLimits {
    const MIB: usize = 1 << 20;
    DraftLimits {
        native_bytes: 256 * MIB,
        caller_bytes: 16 * MIB,
        reply_bytes: 16 * MIB,
        callback_bytes: 16 * MIB,
        native_allocation_bytes: 1024 * MIB,
        continuation_bytes: super::super::runtime_terminal::CONTINUATION_BYTES,
        graphics_policy_bytes: 64 * 1024,
        graphics: crate::ghostty::GraphicsSnapshotLimits {
            encoded_bytes: 256 * MIB,
            backing_bytes: 1024 * MIB,
            images: 1 << 16,
            placements: 1 << 16,
            policy_bytes: 64 * 1024,
        },
        clipboard_write_bytes: 16 * MIB,
        dnd_bytes: 16 * MIB,
        handler_bytes: 16 * MIB,
        osc_capture_bytes: 16 * MIB,
        apc_bytes: 16 * MIB,
    }
}

/// A draft encoded for another process, and whether retained graphics had to
/// be dropped because they referenced process-local file attachments.
#[cfg(unix)]
pub(crate) struct TransferredDraft {
    pub bytes: Vec<u8>,
    pub graphics_dropped: bool,
}

#[cfg(unix)]
impl PaneStateDraft {
    /// Encode every captured domain by value. Native-file backed images are the
    /// only state that cannot cross the boundary; they are reported, not hidden.
    pub(crate) fn encode_transfer(&self) -> TransferredDraft {
        use crate::ghostty::TransferWriter;
        let mut w = TransferWriter::new();
        w.bytes(TRANSFER_MAGIC);
        w.u32(TERMINAL_STATE_SCHEMA);
        w.bytes(&self.native);
        w.bytes(&self.caller);
        let callbacks = &self.callbacks;
        w.u16(callbacks.rows);
        w.u16(callbacks.columns);
        w.u32(callbacks.cell_width);
        w.u32(callbacks.cell_height);
        w.u8(match callbacks.color_scheme {
            None => 0,
            Some(crate::ghostty::ColorScheme::Light) => 1,
            Some(crate::ghostty::ColorScheme::Dark) => 2,
        });
        w.u16(callbacks.bell_count);
        for queue in [&callbacks.pwd_changes, &callbacks.clipboard_writes] {
            w.u64(queue.len() as u64);
            for item in queue {
                w.bytes(item);
            }
        }
        self.graphics_policy.encode_transfer(&mut w);
        let graphics = self
            .graphics
            .as_ref()
            .and_then(crate::ghostty::GraphicsSnapshot::transfer_bytes);
        match graphics {
            Some(bytes) => {
                w.u8(1);
                w.bytes(bytes);
            }
            None => w.u8(0),
        }
        for bytes in [
            &self.clipboard_write,
            &self.dnd,
            &self.handler,
            &self.osc_capture,
            &self.apc,
        ] {
            w.bytes(bytes);
        }
        w.u64(self.replies.len() as u64);
        for reply in &self.replies {
            w.bytes(reply);
        }
        TransferredDraft {
            bytes: w.finish(),
            graphics_dropped: self.graphics.is_some() && graphics.is_none(),
        }
    }

    /// Strictly decode [`Self::encode_transfer`] output. Budgets are enforced
    /// again when the draft is restored into a terminal.
    pub(crate) fn decode_transfer(bytes: &[u8], limits: DraftLimits) -> Result<Self, String> {
        use crate::ghostty::TransferReader;
        let err = |e: crate::ghostty::Error| format!("invalid transferred terminal state: {e}");
        let mut r = TransferReader::new(bytes);
        if r.bytes().map_err(err)? != TRANSFER_MAGIC {
            return Err("transferred terminal state has an unknown format".into());
        }
        let schema = r.u32().map_err(err)?;
        if schema != TERMINAL_STATE_SCHEMA {
            return Err(format!(
                "transferred terminal state schema {schema} is not {TERMINAL_STATE_SCHEMA}"
            ));
        }
        let native = r.owned_bytes().map_err(err)?;
        let caller = r.owned_bytes().map_err(err)?;
        let rows = r.u16().map_err(err)?;
        let columns = r.u16().map_err(err)?;
        let cell_width = r.u32().map_err(err)?;
        let cell_height = r.u32().map_err(err)?;
        let color_scheme = match r.u8().map_err(err)? {
            0 => None,
            1 => Some(crate::ghostty::ColorScheme::Light),
            2 => Some(crate::ghostty::ColorScheme::Dark),
            other => return Err(format!("invalid transferred color scheme {other}")),
        };
        let bell_count = r.u16().map_err(err)?;
        let queue = |r: &mut TransferReader<'_>| -> Result<Vec<Vec<u8>>, String> {
            let count = usize::try_from(r.u64().map_err(err)?).map_err(|e| e.to_string())?;
            // Each entry needs at least its eight-byte length prefix.
            if count > bytes.len() / 8 {
                return Err("invalid transferred callback queue".into());
            }
            (0..count).map(|_| r.owned_bytes().map_err(err)).collect()
        };
        let pwd_changes = queue(&mut r)?;
        let clipboard_writes = queue(&mut r)?;
        let graphics_policy = crate::ghostty::GraphicsPolicySnapshot::decode_transfer(
            &mut r,
            limits.graphics_policy_bytes,
        )
        .map_err(err)?;
        let graphics = match r.u8().map_err(err)? {
            0 => None,
            1 => Some(crate::ghostty::GraphicsSnapshot::from_transfer_bytes(
                r.owned_bytes().map_err(err)?,
            )),
            other => return Err(format!("invalid transferred graphics marker {other}")),
        };
        let clipboard_write = r.owned_bytes().map_err(err)?;
        let dnd = r.owned_bytes().map_err(err)?;
        let handler = r.owned_bytes().map_err(err)?;
        let osc_capture = r.owned_bytes().map_err(err)?;
        let apc = r.owned_bytes().map_err(err)?;
        let replies = queue(&mut r)?.into_iter().map(Bytes::from).collect();
        r.finish().map_err(err)?;
        Ok(Self {
            native,
            caller,
            callbacks: crate::ghostty::TerminalCallbackSnapshot {
                rows,
                columns,
                cell_width,
                cell_height,
                color_scheme,
                bell_count,
                pwd_changes,
                clipboard_writes,
            },
            graphics_policy,
            graphics,
            clipboard_write,
            dnd,
            handler,
            osc_capture,
            apc,
            replies,
        })
    }
}

#[cfg(unix)]
impl GhosttyPaneTerminal {
    /// Rebuild an unpublished pane terminal from a live-handoff record.
    pub(in crate::pane) fn restore_transferred_state(
        bytes: &[u8],
        writer: mpsc::Sender<Bytes>,
    ) -> Result<Self, String> {
        let limits = handoff_limits();
        Self::restore_state_draft(
            PaneStateDraft::decode_transfer(bytes, limits)?,
            limits,
            writer,
        )
    }
}

#[cfg(test)]
pub(crate) fn test_limits() -> DraftLimits {
    DraftLimits {
        native_bytes: 16 << 20,
        caller_bytes: 1 << 20,
        reply_bytes: 1 << 20,
        callback_bytes: 1 << 20,
        native_allocation_bytes: 64 << 20,
        continuation_bytes: 4096,
        graphics_policy_bytes: 16384,
        graphics: crate::ghostty::GraphicsSnapshotLimits {
            encoded_bytes: 16 << 20,
            backing_bytes: 64 << 20,
            images: 1000,
            placements: 1000,
            policy_bytes: 16384,
        },
        clipboard_write_bytes: 1 << 20,
        dnd_bytes: 1 << 20,
        handler_bytes: 1 << 20,
        osc_capture_bytes: 1 << 20,
        apc_bytes: 1 << 20,
    }
}

#[cfg(test)]
mod tests {
    use super::test_limits as limits;
    use super::*;

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
    fn pane_state_draft_preserves_osc_capture_and_budget() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = pane(&tx);
        feed(&source, &tx, b"\x1b]52;c;SGV");
        let restricted = DraftLimits {
            osc_capture_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert!(rx.try_recv().is_err());
        let expected = feed(&source, &tx, b"sbG8=\x07");
        assert_eq!(expected.clipboard_writes, vec![b"Hello".to_vec()]);
        assert_effects(expected, feed(&restored, &tx, b"sbG8=\x07"));
    }

    #[test]
    fn pane_state_draft_preserves_handler_continuation_and_budget() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = pane(&tx);
        feed(&source, &tx, b"\x1bP+q544e");
        let restricted = DraftLimits {
            handler_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert!(rx.try_recv().is_err());
        let expected = feed(&source, &tx, b"\x1b\\");
        assert!(!expected.terminal_responses.is_empty());
        assert_effects(expected, feed(&restored, &tx, b"\x1b\\"));
    }

    #[test]
    fn pane_state_draft_preserves_dnd_chunks_and_future_responses() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = pane(&tx);
        feed(&source, &tx, b"\x1b]72;t=a:i=42:m=1;text/\x1b\\");
        let restricted = DraftLimits {
            dnd_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert!(rx.try_recv().is_err());
        let suffix = b"\x1b]72;m=0;plain\x1b\\\x1b]72;t=r:x=1:i=7\x1b\\";
        let expected = feed(&source, &tx, suffix);
        assert!(!expected.terminal_responses.is_empty());
        assert_effects(expected, feed(&restored, &tx, suffix));
        assert_eq!(
            source
                .core
                .lock()
                .unwrap()
                .terminal
                .dnd_snapshot(4096)
                .unwrap(),
            restored
                .core
                .lock()
                .unwrap()
                .terminal
                .dnd_snapshot(4096)
                .unwrap()
        );
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
    fn pane_state_draft_apc_snapshot_preserves_without_capture_effects() {
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
            let draft = source.capture_state_draft(limits()).unwrap();
            let restored =
                GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
            assert_eq!(
                source
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .apc_snapshot(4096)
                    .unwrap(),
                restored
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .apc_snapshot(4096)
                    .unwrap()
            );
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
    fn pane_state_draft_apc_snapshot_budget_and_retained_graphics() {
        let (tx, _rx) = mpsc::channel(16);
        let source = pane(&tx);
        source
            .core
            .lock()
            .unwrap()
            .terminal
            .enable_kitty_graphics()
            .unwrap();
        feed(&source, &tx, b"\x1b_Ga=T,f=32,i=7,s=1,v=1;AAAA");
        let restricted = DraftLimits {
            apc_bytes: 0,
            ..limits()
        };
        assert!(source.capture_state_draft(restricted).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        assert!(GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err());
        let draft = source.capture_state_draft(limits()).unwrap();
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert_effects(
            feed(&source, &tx, b"AA==\x1b\\"),
            feed(&restored, &tx, b"AA==\x1b\\"),
        );
        for pane in [&source, &restored] {
            let draft = pane.capture_state_draft(limits()).unwrap();
            let again =
                GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
            assert_eq!(
                again
                    .core
                    .lock()
                    .unwrap()
                    .terminal
                    .kitty_image_placements()
                    .unwrap(),
                pane.core
                    .lock()
                    .unwrap()
                    .terminal
                    .kitty_image_placements()
                    .unwrap()
            );
        }
        assert_eq!(
            source
                .core
                .lock()
                .unwrap()
                .terminal
                .kitty_image_placements()
                .unwrap(),
            restored
                .core
                .lock()
                .unwrap()
                .terminal
                .kitty_image_placements()
                .unwrap()
        );
    }

    fn graphics(pane: &GhosttyPaneTerminal) -> Vec<crate::ghostty::KittyImagePlacement> {
        let mut values = pane
            .core
            .lock()
            .unwrap()
            .terminal
            .kitty_image_placements()
            .unwrap();
        values.sort_by_key(|p| (p.image_id, p.placement_id));
        values
    }

    fn graphics_pane(tx: &mpsc::Sender<Bytes>) -> GhosttyPaneTerminal {
        let pane = pane(tx);
        let mut core = pane.core.lock().unwrap();
        core.terminal.enable_kitty_graphics().unwrap();
        core.terminal.resize(40, 5, 8, 16).unwrap();
        drop(core);
        pane
    }

    #[test]
    fn pane_state_draft_graphics_frame_continuation_at_every_cut() {
        let (tx, mut rx) = mpsc::channel(16);
        let sequence = b"\x1b_Ga=f,f=32,s=1,v=1,i=1,m=1,q=2;AQI=\x1b\\\x1b_Gm=0;AwQ=\x1b\\\x1b_Ga=a,i=1,c=2,q=2\x1b\\";
        for alternate in [false, true] {
            for split in 0..=sequence.len() {
                let source = graphics_pane(&tx);
                if alternate {
                    feed(&source, &tx, b"\x1b[?1049h");
                }
                feed(
                    &source,
                    &tx,
                    b"\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;BAUGBw==\x1b\\",
                );
                feed(&source, &tx, &sequence[..split]);
                let draft = source.capture_state_draft(limits()).unwrap();
                let restored =
                    GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
                assert!(rx.try_recv().is_err(), "restore emitted output at {split}");
                assert_effects(
                    feed(&source, &tx, &sequence[split..]),
                    feed(&restored, &tx, &sequence[split..]),
                );
                assert_eq!(
                    graphics(&source),
                    graphics(&restored),
                    "alternate={alternate} split={split}"
                );
                assert_eq!(graphics(&restored)[0].data, [1, 2, 3, 4]);
            }
        }
    }

    #[test]
    fn pane_state_draft_graphics_both_screens_and_relative_placements_survive_source() {
        let (tx, mut rx) = mpsc::channel(16);
        let source = graphics_pane(&tx);
        feed(&source, &tx, b"primary\r\n\x1b_Ga=T,f=32,s=1,v=1,i=1,p=1,q=2;AQIDBA==\x1b\\\x1b_Ga=p,i=1,p=2,P=1,Q=1,H=1,q=2\x1b\\");
        let primary = graphics(&source);
        assert_eq!(primary.len(), 2);
        feed(
            &source,
            &tx,
            b"\x1b[?1049halternate\r\n\x1b_Ga=T,f=32,s=1,v=1,i=2,q=2;BAUGBw==\x1b\\",
        );
        let alternate = graphics(&source);
        let draft = source.capture_state_draft(limits()).unwrap();
        drop(source);
        let restored =
            GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
        assert_eq!(graphics(&restored), alternate);
        feed(&restored, &tx, b"\x1b[?1049l");
        assert_eq!(graphics(&restored), primary);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn pane_state_draft_graphics_limits_leave_source_unchanged() {
        let (tx, _rx) = mpsc::channel(16);
        let source = graphics_pane(&tx);
        feed(
            &source,
            &tx,
            b"\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;AQIDBA==\x1b\\",
        );
        let before = graphics(&source);
        for restricted_graphics in [
            crate::ghostty::GraphicsSnapshotLimits {
                encoded_bytes: 0,
                ..limits().graphics
            },
            crate::ghostty::GraphicsSnapshotLimits {
                backing_bytes: 0,
                ..limits().graphics
            },
            crate::ghostty::GraphicsSnapshotLimits {
                images: 0,
                ..limits().graphics
            },
            crate::ghostty::GraphicsSnapshotLimits {
                placements: 0,
                ..limits().graphics
            },
            crate::ghostty::GraphicsSnapshotLimits {
                policy_bytes: 0,
                ..limits().graphics
            },
        ] {
            let restricted = DraftLimits {
                graphics: restricted_graphics,
                ..limits()
            };
            assert!(source.capture_state_draft(restricted).is_err());
            let draft = source.capture_state_draft(limits()).unwrap();
            assert!(
                GhosttyPaneTerminal::restore_state_draft(draft, restricted, tx.clone()).is_err()
            );
            assert_eq!(graphics(&source), before);
        }
    }

    #[test]
    fn pane_state_draft_graphics_rejects_mixed_policy_and_apc_records() {
        let (tx, _rx) = mpsc::channel(16);
        let plain = pane(&tx);
        let configured = pane(&tx);
        {
            let mut core = configured.core.lock().unwrap();
            core.terminal.enable_kitty_graphics().unwrap();
            core.terminal.set_kitty_source_forwarding(false).unwrap();
        }
        let mut draft = plain.capture_state_draft(limits()).unwrap();
        let donor = configured.capture_state_draft(limits()).unwrap();
        draft.graphics = donor.graphics;
        let error = GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone())
            .err()
            .unwrap();
        assert!(
            error.contains("inconsistent graphics snapshot policy"),
            "{error}"
        );
        let mut draft = plain.capture_state_draft(limits()).unwrap();
        let donor = configured.capture_state_draft(limits()).unwrap();
        assert_ne!(draft.apc, donor.apc);
        draft.apc = donor.apc;
        let error = GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx)
            .err()
            .unwrap();
        assert!(
            error.contains("inconsistent graphics snapshot policy"),
            "{error}"
        );
    }

    #[test]
    fn pane_state_draft_graphics_domain_allowlist_rejects_glyphs_and_future_bits() {
        for supported in [0, 1, 2, 4, 8, 16, 64, 95] {
            check_graphics_domains(supported).unwrap();
            assert!(check_graphics_domains(
                supported | u64::from(crate::ghostty::ffi::GHOSTTY_SNAPSHOT_GRAPHICS_GLYPHS)
            )
            .is_err());
            assert!(check_graphics_domains(supported | (1 << 63)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn pane_state_draft_graphics_file_upload_survives_original_and_source() {
        use base64::Engine;
        let (tx, mut rx) = mpsc::channel(16);
        let source = graphics_pane(&tx);
        let store = crate::ghostty::pane_graphics_files::FileStore::default();
        let original = store.export(&[1, 2, 3, 4]).unwrap();
        let path = base64::engine::general_purpose::STANDARD
            .encode(original.path().as_os_str().as_encoded_bytes());
        feed(
            &source,
            &tx,
            format!("\x1b_Ga=T,t=f,f=32,s=1,v=1,i=7,q=2;{path}\x1b\\").as_bytes(),
        );
        let native_backed = graphics(&source)[0].source_file.is_some();
        let draft = source.capture_state_draft(limits()).unwrap();
        drop(original);
        drop(source);
        let restored = GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx).unwrap();
        let placements = graphics(&restored);
        assert_eq!(placements.len(), 1);
        assert_eq!(placements[0].source_file.is_some(), native_backed);
        if let Some(file) = &placements[0].source_file {
            assert_eq!(file.copy_rgba().unwrap(), [1, 2, 3, 4]);
        } else {
            // Unsupported CoW filesystems use the ordinary decoded fallback.
            assert_eq!(placements[0].data, [1, 2, 3, 4]);
        }
        assert!(rx.try_recv().is_err());
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
            b"\x1b_Ga=q,i=42,f=32,s=1,v=1;AAAAAA==\x1b\\",
            b"\x1b_25a1;s\x1b\\",
            b"\x1b_Xprivate\x18tail",
            b"\x1b_Ga=p,i=42\x9ctail",
        ] {
            for cut in 0..=sequence.len() {
                let source = pane(&tx);
                feed(&source, &tx, &sequence[..cut]);
                let draft = source.capture_state_draft(limits()).unwrap();
                let restored =
                    GhosttyPaneTerminal::restore_state_draft(draft, limits(), tx.clone()).unwrap();
                // The second hop crosses the byte encoding used by live handoff.
                let draft = transferred(restored.capture_state_draft(limits()).unwrap());
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
        let draft = transferred(source.capture_state_draft(limits()).unwrap());
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

    /// Cross the live-handoff byte encoding where it exists; Windows keeps the
    /// in-process draft because live handoff is Unix-only.
    fn transferred(draft: PaneStateDraft) -> PaneStateDraft {
        #[cfg(unix)]
        {
            let encoded = draft.encode_transfer();
            assert!(!encoded.graphics_dropped);
            PaneStateDraft::decode_transfer(&encoded.bytes, limits()).unwrap()
        }
        #[cfg(not(unix))]
        draft
    }

    #[cfg(unix)]
    #[test]
    fn transferred_draft_rejects_truncation_trailing_data_and_foreign_schemas() {
        let (tx, _rx) = mpsc::channel(16);
        let source = pane(&tx);
        feed(&source, &tx, b"retained\x1b[3");
        let bytes = source
            .capture_state_draft(limits())
            .unwrap()
            .encode_transfer()
            .bytes;
        assert!(PaneStateDraft::decode_transfer(&bytes, limits()).is_ok());
        for cut in [0, 1, 8, bytes.len() / 2, bytes.len() - 1] {
            assert!(PaneStateDraft::decode_transfer(&bytes[..cut], limits()).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(PaneStateDraft::decode_transfer(&trailing, limits()).is_err());
        // Layout: 8-byte magic length, magic, then the little-endian schema.
        let schema = 8 + TRANSFER_MAGIC.len();
        let mut future = bytes.clone();
        future[schema..schema + 4].copy_from_slice(&(TERMINAL_STATE_SCHEMA + 1).to_le_bytes());
        let error = PaneStateDraft::decode_transfer(&future, limits())
            .err()
            .unwrap();
        assert!(error.contains("schema"), "{error}");
        let mut foreign = bytes;
        foreign[8] ^= 0xff;
        assert!(PaneStateDraft::decode_transfer(&foreign, limits()).is_err());
        assert!(terminal_state_codec().starts_with(&format!(
            "herdr-pane-state-{TERMINAL_STATE_SCHEMA}+ghostty-"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn transferred_draft_keeps_inline_images_and_reports_dropped_file_images() {
        use base64::Engine;
        let (tx, _rx) = mpsc::channel(16);
        let inline = graphics_pane(&tx);
        feed(
            &inline,
            &tx,
            b"text\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;AQIDBA==\x1b\\",
        );
        let encoded = inline
            .capture_state_draft(limits())
            .unwrap()
            .encode_transfer();
        assert!(!encoded.graphics_dropped);
        let restored = GhosttyPaneTerminal::restore_state_draft(
            PaneStateDraft::decode_transfer(&encoded.bytes, limits()).unwrap(),
            limits(),
            tx.clone(),
        )
        .unwrap();
        assert_eq!(graphics(&restored)[0].data, [1, 2, 3, 4]);

        let files = graphics_pane(&tx);
        let store = crate::ghostty::pane_graphics_files::FileStore::default();
        let original = store.export(&[1, 2, 3, 4]).unwrap();
        let path = base64::engine::general_purpose::STANDARD
            .encode(original.path().as_os_str().as_encoded_bytes());
        feed(
            &files,
            &tx,
            format!("kept\x1b_Ga=T,t=f,f=32,s=1,v=1,i=7,q=2;{path}\x1b\\").as_bytes(),
        );
        if graphics(&files)[0].source_file.is_none() {
            // Filesystems without cloning decode the upload inline instead.
            return;
        }
        let encoded = files
            .capture_state_draft(limits())
            .unwrap()
            .encode_transfer();
        assert!(encoded.graphics_dropped);
        let restored = GhosttyPaneTerminal::restore_state_draft(
            PaneStateDraft::decode_transfer(&encoded.bytes, limits()).unwrap(),
            limits(),
            tx.clone(),
        )
        .unwrap();
        assert!(graphics(&restored).is_empty());
        assert!(restored.visible_text().contains("kept"));
    }
}
