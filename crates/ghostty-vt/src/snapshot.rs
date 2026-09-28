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
    /// Create a terminal with bounded continuation tracking before any input.
    /// Overflow makes snapshot export unavailable until parser recovery; it
    /// never silently truncates a partial sequence. Production constructors
    /// retain their existing policy until runtime handoff integration is ready.
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
