//! Owning wrappers for the vendored binary terminal codec.
//!
//! This codec does not preserve Kitty image data or glyph registrations, nor
//! caller-owned protocol trackers and pending replies. It is not by itself a
//! lossless Herdr runtime handoff format.

use super::{ffi, Error, GhosttyResultExt, Terminal};
use std::{ptr, slice};

struct Decoder(ffi::GhosttySnapshotDecoder);
impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: this guard uniquely owns the decoder, not its returned terminal.
        unsafe { ffi::ghostty_snapshot_decoder_free(self.0) };
    }
}

struct EncodedBytes {
    ptr: *mut u8,
    len: usize,
}
impl Drop for EncodedBytes {
    fn drop(&mut self) {
        // SAFETY: allocation and deallocation use the same default allocator.
        unsafe { ffi::ghostty_free(ptr::null(), self.ptr.cast(), self.len) };
    }
}

impl Terminal {
    /// Capture quiescent APC state without executing commands or callbacks.
    /// Contains private payload data; retained graphics are not included.
    /// Limit bounds encoded bytes, not allocator overhead or retained capacities.
    pub fn apc_snapshot(&self, limit: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: live handle and exact output types; guard owns native allocation.
        unsafe {
            ffi::ghostty_snapshot_apc_encode_alloc(
                self.raw,
                ptr::null(),
                limit,
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Apply authoritative APC state after matching outer parser reconstruction.
    /// Validation/allocation precede replacement; no historical effects execute.
    pub fn restore_apc_snapshot(&mut self, bytes: &[u8], limit: usize) -> Result<(), Error> {
        // SAFETY: input borrow outlives synchronous decode; handle exclusively held.
        unsafe {
            ffi::ghostty_snapshot_apc_restore(self.raw, bytes.as_ptr(), bytes.len(), limit)
                .into_result()
        }
    }

    /// Capture quiescent OSC parser state, limits and initialized capture data.
    /// May contain private command data. Not a full snapshot.
    /// Limit bounds encoded bytes, not allocator overhead or retained capacity.
    pub fn osc_capture_snapshot(&self, limit: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: live handle, exact output types, native allocation owned by guard.
        unsafe {
            ffi::ghostty_snapshot_osc_capture_encode_alloc(
                self.raw,
                ptr::null(),
                limit,
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Replace OSC state after matching outer parser continuation reconstruction.
    /// The native decoder validates before allocation and commits only on success.
    /// Restores discarded commands and fixed-buffer fallback without callbacks.
    /// Limit bounds encoded bytes, not allocator overhead or retained capacity.
    pub fn restore_osc_capture_snapshot(
        &mut self,
        bytes: &[u8],
        limit: usize,
    ) -> Result<(), Error> {
        // SAFETY: input borrow outlives synchronous decode, handle exclusively held.
        unsafe {
            ffi::ghostty_snapshot_osc_capture_restore(self.raw, bytes.as_ptr(), bytes.len(), limit)
                .into_result()
        }
    }

    /// Capture handler policy, ordered grants and authoritative DCS state.
    /// Contains sensitive grant passwords. Not a full snapshot.
    /// Limit bounds encoded bytes and grant backing plus nested DCS bytes.
    pub fn handler_snapshot(&self, limit: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: live handle, exact output types, native allocation owned by guard.
        unsafe {
            ffi::ghostty_snapshot_handler_encode_alloc(
                self.raw,
                ptr::null(),
                limit,
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Replace an unpublished terminal's handler state without historical effects.
    /// The native decoder validates before allocation and commits only on success.
    /// Apply after matching outer continuation. Unfinished OSC state is separate.
    /// Limit bounds encoded bytes and logical backing, not allocator overhead.
    pub fn restore_handler_snapshot(&mut self, bytes: &[u8], limit: usize) -> Result<(), Error> {
        // SAFETY: input borrow outlives synchronous decode, handle exclusively held.
        unsafe {
            ffi::ghostty_snapshot_handler_restore(self.raw, bytes.as_ptr(), bytes.len(), limit)
                .into_result()
        }
    }

    /// Capture owned DND registration, chunking and dropped data.
    /// Empty bytes mean no state. Sensitive payload, not a full snapshot.
    /// Limit bounds encoded bytes and logical backing, not allocator overhead.
    pub fn dnd_snapshot(&self, limit: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: live handle, exact output types, native allocation owned by guard.
        unsafe {
            ffi::ghostty_snapshot_dnd_encode_alloc(
                self.raw,
                ptr::null(),
                limit,
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Replace an unpublished terminal's DND state without historical effects.
    /// The native decoder validates before allocation and commits only on success.
    /// This does not transfer ownership of an external native drag session.
    /// Limit bounds encoded bytes and logical backing, not allocator overhead.
    pub fn restore_dnd_snapshot(&mut self, bytes: &[u8], limit: usize) -> Result<(), Error> {
        // SAFETY: input borrow outlives synchronous decode, handle exclusively held.
        unsafe {
            ffi::ghostty_snapshot_dnd_restore(self.raw, bytes.as_ptr(), bytes.len(), limit)
                .into_result()
        }
    }

    /// Capture the active OSC 5522 transaction, including partial base64 carry.
    /// Empty bytes mean no transaction. Sensitive payload, not a full snapshot.
    pub fn clipboard_write_snapshot(&self, limit: usize) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: live handle, exact output types, native allocation owned by guard.
        unsafe {
            ffi::ghostty_snapshot_clipboard_write_encode_alloc(
                self.raw,
                ptr::null(),
                limit,
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Replace an unpublished terminal's transaction without historical effects.
    /// The native decoder validates before allocation and commits only on success.
    /// Clipboard grants and future-write policy require independent preservation.
    pub fn restore_clipboard_write_snapshot(
        &mut self,
        bytes: &[u8],
        limit: usize,
    ) -> Result<(), Error> {
        // SAFETY: input borrow outlives synchronous decode, handle exclusively held.
        unsafe {
            ffi::ghostty_snapshot_clipboard_write_restore(
                self.raw,
                bytes.as_ptr(),
                bytes.len(),
                limit,
            )
            .into_result()
        }
    }

    /// Query graphics/glyph state that the native snapshot cannot preserve.
    ///
    /// Returns a reason mask, including unknown future bits, without allocating,
    /// changing screens or emitting callbacks. A nonzero value rejects core-only
    /// preservation. APC requires its authoritative snapshot alongside the core.
    /// Unknown bits still reject capture. Zero is not complete eligibility: graphics
    /// policy and caller-owned state still need independent preservation.
    pub fn snapshot_graphics_exclusions(&self) -> Result<u64, Error> {
        let mut flags = 0;
        // SAFETY: live terminal and correctly typed, exclusive output pointer.
        unsafe {
            ffi::ghostty_snapshot_graphics_exclusions(self.raw, &mut flags).into_result()?;
        }
        Ok(flags)
    }

    /// Create a terminal with bounded continuation tracking before any input.
    /// Overflow makes snapshot export unavailable until parser recovery; it
    /// never silently truncates a partial sequence. The caller chooses the
    /// retention bound independently from snapshot transport/allocation limits.
    pub fn new_with_snapshot_tracking(
        cols: u16,
        rows: u16,
        max_scrollback: usize,
        continuation_limit: usize,
    ) -> Result<Self, Error> {
        if continuation_limit == 0 {
            return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
        }
        let terminal = Self::new(cols, rows, max_scrollback)?;
        // SAFETY: uniquely owned live handle and correctly typed option value.
        unsafe {
            ffi::ghostty_terminal_set(
                terminal.raw,
                ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES,
                (&continuation_limit as *const usize).cast(),
            )
            .into_result()?;
        }
        Ok(terminal)
    }

    /// Capture the state supported by the vendored binary codec.
    ///
    /// Includes both screens, retained history, saved cursors, modes and
    /// tracked parser continuation. Excludes Kitty images, glyph registrations,
    /// presentation state and caller-owned protocol state. An unavailable
    /// continuation returns an error instead of falling back to ANSI replay.
    pub fn snapshot_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut bytes = EncodedBytes {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: terminal is live and output pointers belong to the guard.
        unsafe {
            ffi::ghostty_snapshot_encode_alloc(
                self.raw,
                ptr::null(),
                &mut bytes.ptr,
                &mut bytes.len,
            )
            .into_result()?;
            if bytes.len == 0 {
                return Ok(Vec::new());
            }
            let mut result = Vec::new();
            result
                .try_reserve_exact(bytes.len)
                .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
            result.extend_from_slice(slice::from_raw_parts(bytes.ptr, bytes.len));
            Ok(result)
        }
    }

    /// Restore one complete binary snapshot, rejecting trailing data.
    ///
    /// History must reach FINISH before returning. The returned terminal keeps
    /// bounded continuation tracking enabled for subsequent snapshots. Caller
    /// callbacks are installed only after restoration, so decoding emits no
    /// caller output. Reattach the PTY sink, color scheme and graphics policy
    /// before further input; notification queues start empty.
    /// Size replies derive cell dimensions from the captured core geometry;
    /// caller overrides (including an intentionally unknown size) are not
    /// encoded here. Host color-scheme callbacks also require caller rebinding.
    ///
    /// Accept only trusted codec input. `continuation_limit` is not a total
    /// allocation budget: dimensions and page hints can allocate before full
    /// validation. Untrusted transport needs an independent native allocation
    /// budget, not merely a bound on encoded input length.
    pub fn from_snapshot(bytes: &[u8], continuation_limit: usize) -> Result<Self, Error> {
        Self::decode_snapshot(bytes, continuation_limit, None)
    }

    /// Restore with a limit on decoded heap and native page backing storage.
    ///
    /// Counts requested heap bytes and page-rounded native backing allocations.
    /// The input slice, fixed wrappers and allocator/OS bookkeeping are excluded.
    /// Allocation failure rejects the snapshot transactionally.
    /// After successful decoding, normal terminal allocation policy resumes.
    /// This does not add preservation for the state excluded by `from_snapshot`.
    pub fn from_snapshot_with_budget(
        bytes: &[u8],
        continuation_limit: usize,
        allocation_limit: usize,
    ) -> Result<Self, Error> {
        Self::decode_snapshot(bytes, continuation_limit, Some(allocation_limit))
    }

    fn decode_snapshot(
        bytes: &[u8],
        continuation_limit: usize,
        allocation_limit: Option<usize>,
    ) -> Result<Self, Error> {
        if continuation_limit == 0 {
            return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
        }
        let mut decoder = Decoder(ptr::null_mut());
        // SAFETY: bytes outlives the decoder and all values match their C types.
        unsafe {
            ffi::ghostty_snapshot_decoder_new_buf(
                ptr::null(),
                &mut decoder.0,
                bytes.as_ptr(),
                bytes.len(),
            )
            .into_result()?;
            if let Some(limit) = allocation_limit {
                ffi::ghostty_snapshot_decoder_set(
                    decoder.0,
                    ffi::GhosttySnapshotDecoderOption_GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_ALLOCATION_BYTES,
                    (&limit as *const usize).cast(),
                )
                .into_result()?;
            }
            ffi::ghostty_snapshot_decoder_set(
                decoder.0,
                ffi::GhosttySnapshotDecoderOption_GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_CONTINUATION_BYTES,
                (&continuation_limit as *const usize).cast(),
            )
            .into_result()?;
            let retain = true;
            ffi::ghostty_snapshot_decoder_set(
                decoder.0,
                ffi::GhosttySnapshotDecoderOption_GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION,
                (&retain as *const bool).cast(),
            )
            .into_result()?;
            let mut raw = ptr::null_mut();
            ffi::ghostty_snapshot_decoder_decode(decoder.0, &mut raw).into_result()?;
            let mut terminal = Self::own_raw(raw);
            let mut consumed = 0usize;
            ffi::ghostty_snapshot_decoder_get(
                decoder.0,
                ffi::GhosttySnapshotDecoderData_GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET,
                (&mut consumed as *mut usize).cast(),
            )
            .into_result()?;
            if consumed != bytes.len() {
                return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
            }
            terminal.bind_callbacks()?;
            // Restore size-report context without resizing the decoded core:
            // resize can alter terminal state and emit protocol responses.
            let columns = u32::from(terminal.callback_state.size_report.columns);
            let rows = u32::from(terminal.callback_state.size_report.rows);
            terminal.callback_state.size_report.cell_width =
                terminal.width_px()?.checked_div(columns).unwrap_or(0);
            terminal.callback_state.size_report.cell_height =
                terminal.height_px()?.checked_div(rows).unwrap_or(0);
            Ok(terminal)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ActiveScreen;

    fn terminal() -> Terminal {
        Terminal::new_with_snapshot_tracking(40, 5, 1_000_000, 4096).unwrap()
    }

    #[test]
    fn apc_snapshot_every_cut_preserves_future_replies_and_graphics() {
        use std::sync::{Arc, Mutex};
        for sequence in [
            b"\x1b_Ga=q,i=42,f=32,s=1,v=1;AAAAAA==\x1b\\".as_slice(),
            b"\x1b_Ga=T,f=32,i=7,p=3,s=1,v=1;AAAAAA==\x1b\\",
            b"\x1b_Ga=p,i=42,H=-12\x9c",
            b"\x1b_25a1;s\x1b\\",
            b"\x1b_Ga=q,i=42\x18tail",
            b"\x1b_Ga=q,i=42\x1atail",
        ] {
            for cut in 0..=sequence.len() {
                let mut source = terminal();
                source.enable_kitty_graphics().unwrap();
                // Do not run the completed image command before the cut: retained
                // images are a separate, still unsupported snapshot domain.
                source.write(&sequence[..cut]);
                if source.snapshot_graphics_exclusions().unwrap()
                    & !u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_APC)
                    != 0
                {
                    continue;
                }
                let policy = source.graphics_policy_snapshot(16384).unwrap();
                let apc = source.apc_snapshot(4096).unwrap();
                let mut restored =
                    Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
                let a = Arc::new(Mutex::new(Vec::new()));
                let b = Arc::new(Mutex::new(Vec::new()));
                for (t, output) in [(&mut source, a.clone()), (&mut restored, b.clone())] {
                    t.set_write_pty_callback(move |bytes| {
                        output.lock().unwrap().extend_from_slice(bytes)
                    })
                    .unwrap();
                }
                restored
                    .restore_graphics_policy_snapshot(&policy, 16384)
                    .unwrap();
                restored.restore_apc_snapshot(&apc, 4096).unwrap();
                restored.restore_apc_snapshot(&apc, 4096).unwrap();
                assert!(b.lock().unwrap().is_empty());
                source.write(&sequence[cut..]);
                restored.write(&sequence[cut..]);
                assert_eq!(*a.lock().unwrap(), *b.lock().unwrap(), "cut {cut}");
                assert_eq!(
                    source.apc_snapshot(4096).unwrap(),
                    restored.apc_snapshot(4096).unwrap()
                );
                assert_eq!(
                    source.kitty_image_placements().unwrap(),
                    restored.kitty_image_placements().unwrap()
                );
                source.write(b"\x1b_Ga=q,i=99,f=32,s=1,v=1;AAAAAA==\x1b\\tail");
                restored.write(b"\x1b_Ga=q,i=99,f=32,s=1,v=1;AAAAAA==\x1b\\tail");
                assert_eq!(*a.lock().unwrap(), *b.lock().unwrap());
                assert_eq!(
                    source.screen_vt(ActiveScreen::Primary).unwrap(),
                    restored.screen_vt(ActiveScreen::Primary).unwrap()
                );
            }
        }
    }

    #[test]
    fn apc_snapshot_rejects_malformed_and_mismatched_outer_without_mutation() {
        let mut source = terminal();
        source.write(b"\x1b_Ga=q,i=42");
        let bytes = source.apc_snapshot(4096).unwrap();
        for cut in 0..bytes.len() {
            assert!(source.restore_apc_snapshot(&bytes[..cut], 4096).is_err());
            assert_eq!(source.apc_snapshot(4096).unwrap(), bytes);
        }
        assert!(source.apc_snapshot(bytes.len() - 1).is_err());
        assert!(source
            .restore_apc_snapshot(&bytes, bytes.len() - 1)
            .is_err());
        let mut inactive = terminal();
        let empty = inactive.apc_snapshot(4096).unwrap();
        assert!(inactive.restore_apc_snapshot(&bytes, 4096).is_err());
        assert!(source.restore_apc_snapshot(&empty, 4096).is_err());
        assert_eq!(source.apc_snapshot(4096).unwrap(), bytes);
    }

    #[test]
    fn osc_capture_snapshot_continues_every_cut_without_replaying_effects() {
        use std::sync::{Arc, Mutex};
        for sequence in [
            b"\x1b]2;private title\x1b\\".as_slice(),
            b"\x1b]52;c;SGVsbG8=\x07",
            b"\x1b]4;1;?\x07",
        ] {
            for cut in 0..=sequence.len() {
                let mut source = terminal();
                source.write(&sequence[..cut]);
                let capture = source.osc_capture_snapshot(4096).unwrap();
                let callbacks = source.callback_snapshot(4096).unwrap();
                let mut restored =
                    Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
                let a = Arc::new(Mutex::new(Vec::new()));
                let b = Arc::new(Mutex::new(Vec::new()));
                for (terminal, output) in [(&mut source, a.clone()), (&mut restored, b.clone())] {
                    terminal
                        .set_write_pty_callback(move |bytes| {
                            output.lock().unwrap().extend_from_slice(bytes)
                        })
                        .unwrap();
                }
                restored
                    .restore_osc_capture_snapshot(&capture, 4096)
                    .unwrap();
                restored
                    .restore_osc_capture_snapshot(&capture, 4096)
                    .unwrap();
                restored.restore_callback_snapshot(callbacks, 4096).unwrap();
                assert!(b.lock().unwrap().is_empty());
                source.write(&sequence[cut..]);
                restored.write(&sequence[cut..]);
                assert_eq!(*a.lock().unwrap(), *b.lock().unwrap(), "cut {cut}");
                assert_eq!(
                    source.take_clipboard_writes(),
                    restored.take_clipboard_writes()
                );
                assert_eq!(
                    source.osc_capture_snapshot(4096).unwrap(),
                    restored.osc_capture_snapshot(4096).unwrap()
                );
                source.write(b"\x1b]2;next\x07tail");
                restored.write(b"\x1b]2;next\x07tail");
                assert_eq!(
                    source.screen_vt(ActiveScreen::Primary).unwrap(),
                    restored.screen_vt(ActiveScreen::Primary).unwrap()
                );
            }
        }
    }

    #[test]
    fn osc_capture_snapshot_rejects_partial_records_without_changing_state() {
        let mut source = terminal();
        source.write(b"\x1b]52;c;SGV");
        let bytes = source.osc_capture_snapshot(4096).unwrap();
        for cut in 0..bytes.len() {
            assert!(source
                .restore_osc_capture_snapshot(&bytes[..cut], 4096)
                .is_err());
            assert_eq!(source.osc_capture_snapshot(4096).unwrap(), bytes);
        }
        assert!(source.osc_capture_snapshot(bytes.len() - 1).is_err());
        assert!(source
            .restore_osc_capture_snapshot(&bytes, bytes.len() - 1)
            .is_err());
        source.write(b"sbG8=\x07");
        assert_eq!(source.take_clipboard_writes(), vec![b"Hello".to_vec()]);
    }

    #[test]
    fn handler_snapshot_continues_every_dcs_cut_and_preserves_reply_policy() {
        use std::sync::{Arc, Mutex};
        let sequence = b"\x1bP+q544e;436f\x1b\\\x1bP$q q\x1b\\";
        for cut in 0..=sequence.len() {
            let mut source = terminal();
            let enabled = true;
            let name = ffi::GhosttyString {
                ptr: b"custom".as_ptr().cast(),
                len: 6,
            };
            // SAFETY: live exclusive handle and correctly typed synchronous options.
            unsafe {
                ffi::ghostty_terminal_set(
                    source.raw,
                    ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_TITLE_REPORT,
                    (&enabled as *const bool).cast(),
                )
                .into_result()
                .unwrap();
                ffi::ghostty_terminal_set(
                    source.raw,
                    ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_TERMINFO_NAME,
                    (&name as *const ffi::GhosttyString).cast(),
                )
                .into_result()
                .unwrap();
            }
            source.write(b"\x1b]2;title\x1b\\");
            source.write(&sequence[..cut]);
            let handler = source.handler_snapshot(4096).unwrap();
            let mut restored =
                Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
            let a = Arc::new(Mutex::new(Vec::new()));
            let b = Arc::new(Mutex::new(Vec::new()));
            for (terminal, output) in [(&mut source, a.clone()), (&mut restored, b.clone())] {
                terminal
                    .set_write_pty_callback(move |bytes| {
                        output.lock().unwrap().extend_from_slice(bytes)
                    })
                    .unwrap();
            }
            restored.restore_handler_snapshot(&handler, 4096).unwrap();
            restored.restore_handler_snapshot(&handler, 4096).unwrap();
            assert!(b.lock().unwrap().is_empty());
            source.write(&sequence[cut..]);
            restored.write(&sequence[cut..]);
            for suffix in [
                b"\x1b[21t".as_slice(),
                b"\x1bP+q544e\x1b\\",
                b"\x1bc",
                b"\x1bP+q544e\x1b\\",
            ] {
                source.write(suffix);
                restored.write(suffix);
                assert_eq!(*a.lock().unwrap(), *b.lock().unwrap(), "cut {cut}");
                assert_eq!(
                    source.handler_snapshot(4096).unwrap(),
                    restored.handler_snapshot(4096).unwrap()
                );
            }
            assert!(b.lock().unwrap().windows(5).any(|bytes| bytes == b"title"));
            assert!(b
                .lock()
                .unwrap()
                .windows(12)
                .any(|bytes| bytes == b"637573746F6D"));
        }
    }

    #[test]
    fn handler_snapshot_preserves_future_limit_separately_from_active_write() {
        let mut source = terminal();
        let set_limit = |terminal: &mut Terminal, limit: usize| {
            // SAFETY: the option reads a size_t synchronously from this borrow.
            unsafe {
                ffi::ghostty_terminal_set(
                    terminal.raw,
                    ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE_MAX_BYTES,
                    (&limit as *const usize).cast(),
                )
                .into_result()
                .unwrap();
            }
        };
        set_limit(&mut source, 17);
        source.write(b"\x1b]5522;type=write:id=old\x1b\\");
        set_limit(&mut source, 3);
        let handler = source.handler_snapshot(4096).unwrap();
        let transaction = source.clipboard_write_snapshot(4096).unwrap();
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        restored.restore_handler_snapshot(&handler, 4096).unwrap();
        restored
            .restore_clipboard_write_snapshot(&transaction, 4096)
            .unwrap();
        let payload =
            b"\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;SGVsbG8h\x1b\\\x1b]5522;type=wdata\x1b\\";
        for terminal in [&mut source, &mut restored] {
            terminal.write(payload);
            assert_eq!(terminal.take_clipboard_writes(), vec![b"Hello!".to_vec()]);
            terminal.write(b"\x1b]5522;type=write:id=new\x1b\\");
            terminal.write(payload);
            assert!(terminal.take_clipboard_writes().is_empty());
        }
        assert_eq!(
            source.handler_snapshot(4096).unwrap(),
            restored.handler_snapshot(4096).unwrap()
        );
    }

    #[test]
    fn dnd_snapshot_continues_every_cut_and_preserves_future_replies() {
        use std::sync::{Arc, Mutex};
        let sequence = b"\x1b]72;t=a:i=42:m=1;text/\x1b\\\x1b]72;m=0;plain\x1b\\\x1b]72;t=m:o=2:m=1;text/\x1b\\\x1b]72;m=0;plain\x1b\\";
        for cut in 0..=sequence.len() {
            let mut source = terminal();
            source.write(&sequence[..cut]);
            let core = source.snapshot_bytes().unwrap();
            let dnd = source.dnd_snapshot(4096).unwrap();
            let mut restored = Terminal::from_snapshot(&core, 4096).unwrap();
            let a = Arc::new(Mutex::new(Vec::new()));
            let b = Arc::new(Mutex::new(Vec::new()));
            for (terminal, output) in [(&mut source, a.clone()), (&mut restored, b.clone())] {
                terminal
                    .set_write_pty_callback(move |bytes| {
                        output.lock().unwrap().extend_from_slice(bytes)
                    })
                    .unwrap();
            }
            let callbacks = restored.callback_snapshot(4096).unwrap();
            restored.restore_dnd_snapshot(&dnd, 4096).unwrap();
            let repeated = restored.dnd_snapshot(4096).unwrap();
            restored.restore_dnd_snapshot(&repeated, 4096).unwrap();
            assert_eq!(dnd, repeated);
            assert_eq!(restored.callback_snapshot(4096).unwrap(), callbacks);
            assert!(b.lock().unwrap().is_empty());
            source.write(&sequence[cut..]);
            restored.write(&sequence[cut..]);
            assert_eq!(
                source.dnd_snapshot(4096).unwrap(),
                restored.dnd_snapshot(4096).unwrap(),
                "cut {cut}"
            );
            for suffix in [
                b"\x1b]72;t=r:x=1:i=7\x1b\\".as_slice(),
                b"\x1bc",
                b"\x1b]72;t=r:x=1\x1b\\",
                b"\x1b]72;t=A\x1b\\",
            ] {
                source.write(suffix);
                restored.write(suffix);
                assert_eq!(*a.lock().unwrap(), *b.lock().unwrap(), "cut {cut}");
                assert_eq!(
                    source.dnd_snapshot(4096).unwrap(),
                    restored.dnd_snapshot(4096).unwrap()
                );
            }
            assert!(b.lock().unwrap().windows(4).any(|bytes| bytes == b"i=42"));
            assert!(restored.dnd_snapshot(0).unwrap().is_empty());
        }
    }

    #[test]
    fn dnd_snapshot_rejects_corruption_atomically_and_clears_explicitly() {
        let mut source = terminal();
        assert!(source.dnd_snapshot(0).unwrap().is_empty());
        source.write(b"\x1b]72;t=a:i=42;text/plain\x1b\\");
        let before = source.dnd_snapshot(4096).unwrap();
        assert!(source.dnd_snapshot(before.len() - 1).is_err());
        assert!(source
            .restore_dnd_snapshot(&before, before.len() - 1)
            .is_err());
        for cut in 1..before.len() {
            assert!(source.restore_dnd_snapshot(&before[..cut], 4096).is_err());
            assert_eq!(source.dnd_snapshot(4096).unwrap(), before);
        }
        source.restore_dnd_snapshot(&[], 0).unwrap();
        assert!(source.dnd_snapshot(0).unwrap().is_empty());
    }

    #[test]
    fn clipboard_write_snapshot_continues_every_cut_without_emitting_history() {
        let sequence = b"\x1b]5522;type=write:id=c1\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;SGV\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;sbG8=\x1b\\";
        let commit =
            b"\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;V29ybGQ=\x1b\\\x1b]5522;type=wdata\x1b\\";
        for cut in 0..=sequence.len() {
            let mut source = terminal();
            source.write(&sequence[..cut]);
            let core = source.snapshot_bytes().unwrap();
            let transaction = source.clipboard_write_snapshot(1 << 20).unwrap();
            let mut restored = Terminal::from_snapshot(&core, 4096).unwrap();
            let callbacks = restored.callback_snapshot(4096).unwrap();
            restored
                .restore_clipboard_write_snapshot(&transaction, 1 << 20)
                .unwrap();
            assert_eq!(restored.callback_snapshot(4096).unwrap(), callbacks);
            assert_eq!(
                source.clipboard_write_snapshot(1 << 20).unwrap(),
                transaction
            );
            let repeated = restored.clipboard_write_snapshot(1 << 20).unwrap();
            restored
                .restore_clipboard_write_snapshot(&repeated, 1 << 20)
                .unwrap();
            source.write(&sequence[cut..]);
            restored.write(&sequence[cut..]);
            source.write(commit);
            restored.write(commit);
            assert_eq!(
                source.take_clipboard_writes(),
                vec![b"HelloWorld".to_vec()],
                "cut {cut}"
            );
            assert_eq!(
                restored.take_clipboard_writes(),
                vec![b"HelloWorld".to_vec()],
                "cut {cut}"
            );
            assert!(restored.clipboard_write_snapshot(0).unwrap().is_empty());
        }
    }

    #[test]
    fn clipboard_write_snapshot_rejects_bad_input_atomically_and_clears_explicitly() {
        let mut source = terminal();
        assert!(source.clipboard_write_snapshot(0).unwrap().is_empty());
        source.write(
            b"\x1b]5522;type=write:id=c1\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;SGV\x1b\\",
        );
        let before = source.clipboard_write_snapshot(4096).unwrap();
        assert!(!before.is_empty());
        assert!(source.clipboard_write_snapshot(before.len() - 1).is_err());
        assert!(source
            .restore_clipboard_write_snapshot(&before, before.len() - 1)
            .is_err());
        for cut in 1..before.len() {
            assert!(source
                .restore_clipboard_write_snapshot(&before[..cut], 4096)
                .is_err());
            assert_eq!(source.clipboard_write_snapshot(4096).unwrap(), before);
        }
        source.restore_clipboard_write_snapshot(&[], 0).unwrap();
        assert!(source.clipboard_write_snapshot(0).unwrap().is_empty());
        assert!(source.take_clipboard_writes().is_empty());
    }

    #[test]
    fn snapshot_graphics_exclusions_cover_both_screens_and_loading() {
        let image = b"\x1b_Ga=T,f=32,t=d,i=7,p=3,s=1,v=1,c=1,r=1,q=2;/wAA/w==\x1b\\";
        for alternate in [false, true] {
            let mut source = terminal();
            source.enable_kitty_graphics().unwrap();
            // Empty configured storage is deliberately not an exclusion. Its
            // policy still needs preservation outside this payload-only query.
            assert_eq!(source.snapshot_graphics_exclusions().unwrap(), 0);
            if alternate {
                source.write(b"\x1b[?1049h");
            }
            source.write(image);
            let expected = u64::from(
                ffi::GHOSTTY_SNAPSHOT_GRAPHICS_IMAGES
                    | ffi::GHOSTTY_SNAPSHOT_GRAPHICS_PLACEMENTS
                    | ffi::GHOSTTY_SNAPSHOT_GRAPHICS_BYTES,
            );
            assert_eq!(
                source.snapshot_graphics_exclusions().unwrap() & expected,
                expected
            );
            source.write(if alternate {
                b"\x1b[?1049l"
            } else {
                b"\x1b[?1049h"
            });
            let before = source.snapshot_bytes().unwrap();
            let flags = source.snapshot_graphics_exclusions().unwrap();
            assert_eq!(flags & expected, expected);
            assert_eq!(source.snapshot_graphics_exclusions().unwrap(), flags);
            assert_eq!(source.snapshot_bytes().unwrap(), before);
        }
        let mut source = terminal();
        source.enable_kitty_graphics().unwrap();
        source.write(b"\x1b_Ga=t,f=32,s=1,v=1,m=1,q=2;/wAA\x1b\\");
        assert_ne!(
            source.snapshot_graphics_exclusions().unwrap()
                & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_LOADING),
            0
        );
    }

    #[test]
    fn snapshot_graphics_exclusions_cover_unplaced_virtual_and_deleted_images() {
        for action in ["a=t", "a=T,U=1"] {
            let mut source = terminal();
            source.enable_kitty_graphics().unwrap();
            source.write(format!("\x1b_G{action},f=32,s=1,v=1,q=2;/wAA/w==\x1b\\").as_bytes());
            let flags = source.snapshot_graphics_exclusions().unwrap();
            assert_ne!(flags & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_IMAGES), 0);
            assert_ne!(
                flags & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_AUTO_IDS),
                0
            );
            if action == "a=t" {
                assert_eq!(
                    flags & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_PLACEMENTS),
                    0
                );
            } else {
                assert_ne!(
                    flags & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_PLACEMENTS),
                    0
                );
            }
            source.write(b"\x1b_Ga=d,d=A,q=2\x1b\\");
            // Delete-all only deletes placed images. Address the automatic ID
            // explicitly as well to clear an unplaced transmission.
            source.write(b"\x1b_Ga=d,d=I,i=2147483647,q=2\x1b\\");
            assert_eq!(
                source.snapshot_graphics_exclusions().unwrap(),
                u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_AUTO_IDS)
            );
        }
    }

    #[test]
    fn snapshot_graphics_exclusions_reject_active_apc_not_other_continuations() {
        for prefix in [
            b"\x1b_".as_slice(),
            b"\x1b_G",
            b"\x1b_unknown;",
            b"\x1b_25a1;r;",
        ] {
            let mut source = terminal();
            source.write(prefix);
            assert_ne!(
                source.snapshot_graphics_exclusions().unwrap()
                    & u64::from(ffi::GHOSTTY_SNAPSHOT_GRAPHICS_APC),
                0,
                "{prefix:?}"
            );
            source.write(b"\x1b\\");
            assert_eq!(source.snapshot_graphics_exclusions().unwrap(), 0);
        }
        for prefix in [b"\x1b".as_slice(), b"\x1b[31", b"\x1b]2;title", b"\xe7\x95"] {
            let mut source = terminal();
            source.write(prefix);
            assert_eq!(source.snapshot_graphics_exclusions().unwrap(), 0);
        }
    }

    #[test]
    fn binary_snapshot_restores_history_both_screens_and_saved_cursors() {
        let mut source = terminal();
        for row in 0..400 {
            source.write(format!("primary-{row:04} retained history\r\n").as_bytes());
        }
        source.write(b"\x1b[2;3H\x1b7\x1b[?1049hSECOND\x1b[3;5H\x1b7\x1b[1;1H");
        let bytes = source.snapshot_bytes().unwrap();
        let mut restored = Terminal::from_snapshot(&bytes, 4096).unwrap();
        assert_eq!(restored.max_scrollback, source.max_scrollback);
        for suffix in [b"\x1b8X".as_slice(), b"\x1b[?1049l\x1b8Y"] {
            source.write(suffix);
            restored.write(suffix);
            for screen in [ActiveScreen::Primary, ActiveScreen::Alternate] {
                assert_eq!(
                    restored.screen_vt(screen).unwrap(),
                    source.screen_vt(screen).unwrap()
                );
            }
        }
        assert!(restored
            .screen_vt(ActiveScreen::Primary)
            .unwrap()
            .contains("primary-0000"));
    }

    #[test]
    fn binary_snapshot_continues_every_cut_and_repeated_restore() {
        for sequence in [
            "界é".as_bytes(),
            b"\x1b[31mRED",
            b"\x1b]2;title\x07",
            b"\x1bP$qm\x1b\\",
            b"\x1b_ignored\x1b\\",
            b"\x1b*A\x1bN##",
        ] {
            for cut in 0..=sequence.len() {
                let mut source = terminal();
                source.write(&sequence[..cut]);
                let mut restored =
                    Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
                restored =
                    Terminal::from_snapshot(&restored.snapshot_bytes().unwrap(), 4096).unwrap();
                source.write(&sequence[cut..]);
                restored.write(&sequence[cut..]);
                source.write(b"tail");
                restored.write(b"tail");
                assert_eq!(
                    restored.screen_vt(ActiveScreen::Primary).unwrap(),
                    source.screen_vt(ActiveScreen::Primary).unwrap(),
                    "sequence={sequence:?} cut={cut}"
                );
            }
        }
    }

    #[test]
    fn binary_snapshot_rejects_truncation_and_trailing_bytes() {
        let bytes = terminal().snapshot_bytes().unwrap();
        for end in 0..bytes.len() {
            assert!(
                Terminal::from_snapshot(&bytes[..end], 4096).is_err(),
                "accepted prefix {end}"
            );
        }
        let mut trailing = bytes;
        trailing.push(0);
        assert!(Terminal::from_snapshot(&trailing, 4096).is_err());
        assert!(Terminal::from_snapshot(&trailing, 0).is_err());
    }

    #[test]
    fn binary_snapshot_restores_size_report_callback_geometry() {
        use std::sync::{Arc, Mutex};
        let mut source = terminal();
        source.resize(40, 5, 9, 18).unwrap();
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        let mut replies = Vec::new();
        for terminal in [&mut source, &mut restored] {
            let output = Arc::new(Mutex::new(Vec::new()));
            let sink = output.clone();
            terminal
                .set_write_pty_callback(move |bytes| sink.lock().unwrap().extend_from_slice(bytes))
                .unwrap();
            terminal.write(b"\x1b[14t\x1b[16t\x1b[18t\x1b[?2048h");
            replies.push(output.lock().unwrap().clone());
        }
        assert!(!replies[0].is_empty());
        assert_eq!(replies[1], replies[0]);
    }

    #[test]
    fn binary_snapshot_decode_budget_rejects_and_retains_terminal_ownership() {
        let mut source = terminal();
        for row in 0..2000 {
            source.write(format!("history-{row:04}\r\n").as_bytes());
        }
        source.write(b"retained\r\n\x1b[?1049halternate\x1b[31");
        let bytes = source.snapshot_bytes().unwrap();
        let mut accepted = false;
        for limit in std::iter::once(0).chain((0..=24).map(|power| 1usize << power)) {
            let result = Terminal::from_snapshot_with_budget(&bytes, 4096, limit);
            if let Ok(restored) = result {
                accepted = true;
                assert_eq!(
                    restored.screen_vt(ActiveScreen::Primary).unwrap(),
                    source.screen_vt(ActiveScreen::Primary).unwrap()
                );
                assert_eq!(
                    restored.screen_vt(ActiveScreen::Alternate).unwrap(),
                    source.screen_vt(ActiveScreen::Alternate).unwrap()
                );
                drop(restored);
            } else {
                assert_eq!(
                    result.err().unwrap().0,
                    ffi::GhosttyResult_GHOSTTY_LIMIT_EXCEEDED
                );
            }
        }
        assert!(accepted);
        assert!(Terminal::from_snapshot_with_budget(&bytes, 4096, 0).is_err());
        let mut restored = Terminal::from_snapshot_with_budget(&bytes, 4096, 1 << 24).unwrap();
        std::thread::spawn(move || {
            restored.write(b"mRESUMED");
            restored.resize(120, 40, 9, 18).unwrap();
            assert!(!restored.snapshot_bytes().unwrap().is_empty());
        })
        .join()
        .unwrap();
    }

    #[test]
    fn binary_snapshot_decode_budgets_are_independent_across_threads() {
        let mut source = terminal();
        for row in 0..2000 {
            source.write(format!("concurrent-{row:04}\r\n").as_bytes());
        }
        let bytes = source.snapshot_bytes().unwrap();
        let expected = source.screen_vt(ActiveScreen::Primary).unwrap();
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for worker in 0..4 {
                let (bytes, expected, barrier) = (&bytes, &expected, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..8 {
                        let limit = if worker % 2 == 0 { 0 } else { 1 << 24 };
                        let restored = Terminal::from_snapshot_with_budget(bytes, 4096, limit);
                        if limit == 0 {
                            assert_eq!(
                                restored.err().unwrap().0,
                                ffi::GhosttyResult_GHOSTTY_LIMIT_EXCEEDED
                            );
                        } else {
                            assert_eq!(
                                &restored.unwrap().screen_vt(ActiveScreen::Primary).unwrap(),
                                expected
                            );
                        }
                    }
                });
            }
        });
    }

    #[test]
    fn binary_snapshot_continues_query_replies_at_every_cut() {
        use std::sync::{Arc, Mutex};
        for query in [b"\x1b[6n".as_slice(), b"\x1bP$qm\x1b\\", b"\x1b[?u"] {
            for cut in 0..=query.len() {
                let mut source = terminal();
                source.write(b"\x1b[31m\x1b[3;7H\x1b[>3u");
                source.write(&query[..cut]);
                let mut restored =
                    Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
                let mut replies = Vec::new();
                for terminal in [&mut source, &mut restored] {
                    let output = Arc::new(Mutex::new(Vec::new()));
                    let sink = output.clone();
                    terminal
                        .set_write_pty_callback(move |bytes| {
                            sink.lock().unwrap().extend_from_slice(bytes)
                        })
                        .unwrap();
                    terminal.write(&query[cut..]);
                    replies.push(output.lock().unwrap().clone());
                }
                if cut == 0 {
                    assert!(!replies[0].is_empty(), "query={query:?}");
                }
                assert_eq!(replies[1], replies[0], "query={query:?} cut={cut}");
            }
        }
    }

    #[test]
    fn binary_snapshot_preserves_saved_modes_and_reset_defaults() {
        let mut source = terminal();
        let default = ffi::GhosttyTerminalModeConfig {
            mode: crate::MODE_GRAPHEME_CLUSTER,
            value: false,
        };
        // SAFETY: the live handle and option value have the C API's exact types.
        unsafe {
            ffi::ghostty_terminal_set(
                source.raw,
                ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_MODE_DEFAULT,
                (&default as *const ffi::GhosttyTerminalModeConfig).cast(),
            )
            .into_result()
            .unwrap();
        }
        source.write(b"\x1b[?7l\x1b[?7s\x1b[?7h");
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        for terminal in [&mut source, &mut restored] {
            assert!(terminal.mode_get(7).unwrap());
            terminal.write(b"\x1b[?7r");
            assert!(!terminal.mode_get(7).unwrap());
            terminal.write(b"\x1bc");
            assert!(terminal.mode_get(7).unwrap());
            assert!(!terminal.mode_get(crate::MODE_GRAPHEME_CLUSTER).unwrap());
        }
    }

    #[test]
    fn binary_snapshot_preserves_each_screen_keyboard_stack() {
        let mut source = terminal();
        source.write(b"\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>4u\x1b[>8u");
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        for terminal in [&mut source, &mut restored] {
            assert_eq!(terminal.kitty_keyboard_flags().unwrap(), 8);
            terminal.write(b"\x1b[<u");
            assert_eq!(terminal.kitty_keyboard_flags().unwrap(), 4);
            terminal.write(b"\x1b[?1049l");
            assert_eq!(terminal.kitty_keyboard_flags().unwrap(), 3);
            terminal.write(b"\x1b[<u");
            assert_eq!(terminal.kitty_keyboard_flags().unwrap(), 1);
            terminal.write(b"\x1b[<u");
            assert_eq!(terminal.kitty_keyboard_flags().unwrap(), 0);
        }
    }

    #[test]
    fn binary_snapshot_bounds_continuation_without_losing_source_input() {
        let mut source = Terminal::new_with_snapshot_tracking(40, 5, 4096, 16).unwrap();
        source.write(b"\x1b]2;abcdefghijklmnopqrstuvwxyz");
        assert!(source.snapshot_bytes().is_err());
        source.write(b"\x07recovered");
        let restored = Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 16).unwrap();
        assert_eq!(
            restored.screen_vt(ActiveScreen::Primary).unwrap(),
            source.screen_vt(ActiveScreen::Primary).unwrap()
        );
        source.write(b"\x1b[12345");
        let partial = source.snapshot_bytes().unwrap();
        assert!(Terminal::from_snapshot(&partial, 2).is_err());
        assert!(Terminal::from_snapshot(&partial, 16).is_ok());
    }

    #[test]
    fn binary_snapshot_restores_modes_and_rebinds_callbacks_without_replaying_them() {
        let mut source = terminal();
        source.write(b"\x07\x1b[?7l\x1b[2;4r\x1b[?6h\x1b[31m\x1b[2;3H\x1bH");
        assert_eq!(source.take_bell_count(), 1);
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        assert_eq!(restored.take_bell_count(), 0);
        for suffix in [
            b"\tX\x07".as_slice(),
            b"01234567890123456789012345678901234567890123456789",
            b"\r\n\n\nY",
        ] {
            source.write(suffix);
            restored.write(suffix);
            assert_eq!(
                restored.screen_vt(ActiveScreen::Primary).unwrap(),
                source.screen_vt(ActiveScreen::Primary).unwrap()
            );
        }
        assert_eq!(restored.take_bell_count(), source.take_bell_count());
        let mut corrupt = source.snapshot_bytes().unwrap();
        let midpoint = corrupt.len() / 2;
        corrupt[midpoint] ^= 0x80;
        assert!(Terminal::from_snapshot(&corrupt, 4096).is_err());
    }
}
