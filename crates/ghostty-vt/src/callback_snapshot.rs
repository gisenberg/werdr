//! Caller context omitted by the native snapshot codec.

use crate::{ffi, ColorScheme, Error, Terminal};

/// Owned callback data for an enclosing, versioned runtime snapshot.
///
/// This is not a wire codec or a complete terminal snapshot. Capture it at the
/// same exclusive cut as the native snapshot. The PTY callback closure and
/// replies already delivered to that closure belong to the caller and must be
/// preserved separately. No notification is drained during capture or emitted
/// during restoration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCallbackSnapshot {
    pub rows: u16,
    pub columns: u16,
    pub cell_width: u32,
    pub cell_height: u32,
    pub color_scheme: Option<ColorScheme>,
    pub bell_count: u16,
    pub pwd_changes: Vec<Vec<u8>>,
    pub clipboard_writes: Vec<Vec<u8>>,
}

fn queue_storage(queue: &[Vec<u8>]) -> Option<usize> {
    queue.iter().try_fold(
        queue.len().checked_mul(std::mem::size_of::<Vec<u8>>())?,
        |total, item| total.checked_add(item.len()),
    )
}

fn check_budget(pwd: &[Vec<u8>], clipboard: &[Vec<u8>], limit: usize) -> Result<(), Error> {
    let storage = queue_storage(pwd)
        .and_then(|pwd| queue_storage(clipboard).and_then(|clipboard| pwd.checked_add(clipboard)));
    match storage {
        Some(storage) if storage <= limit => Ok(()),
        _ => Err(Error(ffi::GhosttyResult_GHOSTTY_LIMIT_EXCEEDED)),
    }
}

fn copy_queue(source: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, Error> {
    let oom = |_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY);
    let mut result = Vec::new();
    result.try_reserve_exact(source.len()).map_err(oom)?;
    for item in source {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(item.len()).map_err(oom)?;
        bytes.extend_from_slice(item);
        result.push(bytes);
    }
    Ok(result)
}

impl Terminal {
    /// Copy callback context with a separate queue-storage limit.
    ///
    /// The limit counts payload lengths and vector-entry storage, not allocator
    /// bookkeeping or the fixed snapshot structure. It is checked before any
    /// queue copy. An enclosing decoder must also bound allocations while
    /// parsing its serialized representation. Retained vector capacities are
    /// not counted, so this is not a resident-memory bound on caller-built DTOs.
    pub fn callback_snapshot(
        &self,
        queue_storage_limit: usize,
    ) -> Result<TerminalCallbackSnapshot, Error> {
        let state = &self.callback_state;
        check_budget(
            &state.pwd_changes,
            &state.clipboard_writes,
            queue_storage_limit,
        )?;
        Ok(TerminalCallbackSnapshot {
            rows: state.size_report.rows,
            columns: state.size_report.columns,
            cell_width: state.size_report.cell_width,
            cell_height: state.size_report.cell_height,
            color_scheme: state.color_scheme,
            bell_count: state.bell_count,
            pwd_changes: copy_queue(&state.pwd_changes)?,
            clipboard_writes: copy_queue(&state.clipboard_writes)?,
        })
    }

    /// Restore context on an unpublished terminal after native decoding.
    ///
    /// Validation precedes mutation. Geometry must match the decoded grid, but
    /// zero cell dimensions are preserved exactly as intentional unknown sizes.
    /// This neither resizes the native terminal nor replaces its PTY sink.
    /// Existing queued notifications are replaced, so do not call on a live
    /// terminal with unconsumed events.
    pub fn restore_callback_snapshot(
        &mut self,
        snapshot: TerminalCallbackSnapshot,
        queue_storage_limit: usize,
    ) -> Result<(), Error> {
        check_budget(
            &snapshot.pwd_changes,
            &snapshot.clipboard_writes,
            queue_storage_limit,
        )?;
        if snapshot
            .clipboard_writes
            .iter()
            .any(|bytes| bytes.is_empty() || bytes.len() > crate::MAX_CLIPBOARD_BYTES)
        {
            return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
        }
        if snapshot.rows != self.rows()? || snapshot.columns != self.cols()? {
            return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
        }
        let state = &mut self.callback_state;
        state.size_report = ffi::GhosttySizeReportSize {
            rows: snapshot.rows,
            columns: snapshot.columns,
            cell_width: snapshot.cell_width,
            cell_height: snapshot.cell_height,
        };
        state.color_scheme = snapshot.color_scheme;
        state.bell_count = snapshot.bell_count;
        state.pwd_changes = snapshot.pwd_changes;
        state.clipboard_writes = snapshot.clipboard_writes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn callback_snapshot_preserves_exact_context_without_replaying_events() {
        let mut source = Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap();
        source.resize(40, 5, 0, 0).unwrap();
        source.set_color_scheme(Some(ColorScheme::Light));
        source.write(b"\x07\x07\x1b]7;file:///tmp/retained\x07\x1b]52;c;aGVsbG8=\x07");
        source.write(b"\x1b]7;file:///tmp/second\x07\x1b]52;c;d29ybGQ=\x07");
        let context = source.callback_snapshot(4096).unwrap();
        assert_eq!(context.bell_count, 2);
        assert_eq!(
            context.pwd_changes,
            [
                b"file:///tmp/retained".to_vec(),
                b"file:///tmp/second".to_vec()
            ]
        );
        assert_eq!(
            context.clipboard_writes,
            [b"hello".to_vec(), b"world".to_vec()]
        );
        let mut restored =
            Terminal::from_snapshot_with_budget(&source.snapshot_bytes().unwrap(), 4096, 1 << 24)
                .unwrap();
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        restored
            .set_write_pty_callback(move |bytes| sink.lock().unwrap().extend_from_slice(bytes))
            .unwrap();
        restored
            .restore_callback_snapshot(context.clone(), 4096)
            .unwrap();
        assert!(output.lock().unwrap().is_empty());
        assert_eq!(restored.callback_snapshot(4096).unwrap(), context);
        assert_eq!(source.callback_snapshot(4096).unwrap(), context);
        assert_eq!(restored.take_bell_count(), 2);
        assert_eq!(restored.take_bell_count(), 0);
        assert_eq!(restored.take_pwd_changes(), context.pwd_changes);
        assert!(restored.take_pwd_changes().is_empty());
        assert_eq!(restored.take_clipboard_writes(), context.clipboard_writes);
        assert!(restored.take_clipboard_writes().is_empty());

        let source_output = Arc::new(Mutex::new(Vec::new()));
        let sink = source_output.clone();
        source
            .set_write_pty_callback(move |bytes| sink.lock().unwrap().extend_from_slice(bytes))
            .unwrap();
        source.write(b"\x1b[14t\x1b[16t");
        restored.write(b"\x1b[14t\x1b[16t");
        assert!(output.lock().unwrap().is_empty());
        assert!(source_output.lock().unwrap().is_empty());
        source.write(b"\x1b[?996n");
        restored.write(b"\x1b[?996n");
        assert_eq!(output.lock().unwrap().as_slice(), b"\x1b[?997;2n");
        assert_eq!(*output.lock().unwrap(), *source_output.lock().unwrap());
    }

    #[test]
    fn callback_snapshot_continues_notifications_after_repeated_restore_at_every_cut() {
        for sequence in [
            b"\x1b]52;c;aGVsbG8=\x1b\\".as_slice(),
            b"\x1b]7;file:///tmp/next\x07".as_slice(),
            b"\x07\x07".as_slice(),
        ] {
            for cut in 0..=sequence.len() {
                let mut source =
                    Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap();
                source.write(b"\x07\x1b]7;file:///tmp/before\x07");
                source.write(&sequence[..cut]);
                let mut restored = Terminal::from_snapshot_with_budget(
                    &source.snapshot_bytes().unwrap(),
                    4096,
                    1 << 24,
                )
                .unwrap();
                restored
                    .restore_callback_snapshot(source.callback_snapshot(4096).unwrap(), 4096)
                    .unwrap();
                let context = restored.callback_snapshot(4096).unwrap();
                let mut repeated = Terminal::from_snapshot_with_budget(
                    &restored.snapshot_bytes().unwrap(),
                    4096,
                    1 << 24,
                )
                .unwrap();
                repeated.restore_callback_snapshot(context, 4096).unwrap();
                source.write(&sequence[cut..]);
                repeated.write(&sequence[cut..]);
                assert_eq!(
                    source.callback_snapshot(4096).unwrap(),
                    repeated.callback_snapshot(4096).unwrap(),
                    "sequence={sequence:?} cut={cut}"
                );
            }
        }
    }

    #[test]
    fn callback_snapshot_rejects_limits_and_geometry_without_mutation() {
        let mut terminal = Terminal::new_with_snapshot_tracking(40, 5, 100_000, 4096).unwrap();
        terminal.write(b"\x07\x1b]7;file:///retained\x07");
        let baseline = terminal.callback_snapshot(4096).unwrap();
        let required = queue_storage(&baseline.pwd_changes).unwrap();
        assert!(terminal.callback_snapshot(required - 1).is_err());
        assert_eq!(terminal.callback_snapshot(required).unwrap(), baseline);
        assert!(terminal
            .restore_callback_snapshot(baseline.clone(), required - 1)
            .is_err());
        let mut invalid = baseline.clone();
        invalid.columns += 1;
        assert!(terminal.restore_callback_snapshot(invalid, 4096).is_err());
        for bytes in [Vec::new(), vec![b'x'; crate::MAX_CLIPBOARD_BYTES + 1]] {
            let mut invalid = baseline.clone();
            invalid.clipboard_writes.push(bytes);
            assert!(terminal
                .restore_callback_snapshot(invalid, usize::MAX)
                .is_err());
        }
        assert_eq!(terminal.callback_snapshot(4096).unwrap(), baseline);
        let mut empty = baseline;
        empty.bell_count = 0;
        empty.pwd_changes.clear();
        empty.clipboard_writes.clear();
        terminal
            .restore_callback_snapshot(empty.clone(), 0)
            .unwrap();
        assert_eq!(terminal.callback_snapshot(0).unwrap(), empty);
    }
}
