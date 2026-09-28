//! Caller-owned Windows recent-output observer, not arbitrary native references.

use crate::{ffi, ghostty_screen_point, ActiveScreen, Error, GhosttyResultExt, Terminal};
use std::ptr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackedRowSnapshot {
    pub screen: ActiveScreen,
    pub x: u16,
    pub y: u32,
}

impl Terminal {
    /// Capture at the same exclusive cut as the native terminal snapshot.
    /// Stale/garbage observers are equivalent to absent for track_row: its next
    /// call reports no previous row and replaces the reference in either case.
    pub fn tracked_row_snapshot(&self) -> Result<Option<TrackedRowSnapshot>, Error> {
        if self.tracked_row.is_null() {
            return Ok(None);
        }
        let mut screen = ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_PRIMARY;
        let mut point = ffi::GhosttyPointCoordinate::default();
        // SAFETY: owned reference and correctly typed outputs; no mutation.
        let result = unsafe {
            ffi::ghostty_tracked_grid_ref_screen_point(self.tracked_row, &mut screen, &mut point)
        };
        if result == ffi::GhosttyResult_GHOSTTY_NO_VALUE {
            return Ok(None);
        }
        result.into_result()?;
        let screen = match screen {
            ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_PRIMARY => ActiveScreen::Primary,
            ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_ALTERNATE => ActiveScreen::Alternate,
            _ => return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE)),
        };
        Ok(Some(TrackedRowSnapshot {
            screen,
            x: point.x,
            y: point.y,
        }))
    }

    /// Install after full native decoding and before any resumed output.
    /// Does not initialize or activate screens. Failure leaves the old observer
    /// intact; success replaces it without querying or moving the viewport.
    pub fn restore_tracked_row_snapshot(
        &mut self,
        snapshot: Option<TrackedRowSnapshot>,
    ) -> Result<(), Error> {
        let mut replacement = ptr::null_mut();
        if let Some(snapshot) = snapshot {
            let screen = match snapshot.screen {
                ActiveScreen::Primary => ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_PRIMARY,
                ActiveScreen::Alternate => {
                    ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_ALTERNATE
                }
            };
            // SAFETY: live terminal and exclusive access, output is a newly owned reference.
            unsafe {
                ffi::ghostty_terminal_grid_ref_track_screen(
                    self.raw,
                    screen,
                    ghostty_screen_point(snapshot.x, snapshot.y),
                    &mut replacement,
                )
                .into_result()?;
            }
        }
        let previous = std::mem::replace(&mut self.tracked_row, replacement);
        // SAFETY: ownership of previous was removed above; null is permitted.
        unsafe { ffi::ghostty_tracked_grid_ref_free(previous) };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal() -> Terminal {
        Terminal::new_with_snapshot_tracking(20, 4, 100_000, 4096).unwrap()
    }

    #[test]
    fn tracked_row_snapshot_restores_inactive_primary_without_side_effects() {
        let mut source = terminal();
        source.write(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        assert_eq!(source.track_row(3), None);
        source.write(b"\x1b[?1049hALT\x1b[>3u\x1b[2;3H");
        let observer = source.tracked_row_snapshot().unwrap();
        assert_eq!(observer.unwrap().screen, ActiveScreen::Primary);
        let bytes = source.snapshot_bytes().unwrap();
        let mut restored = Terminal::from_snapshot(&bytes, 4096).unwrap();
        let before = restored.snapshot_bytes().unwrap();
        let callbacks = restored.callback_snapshot(4096).unwrap();
        restored.restore_tracked_row_snapshot(observer).unwrap();
        assert_eq!(restored.snapshot_bytes().unwrap(), before);
        assert_eq!(restored.callback_snapshot(4096).unwrap(), callbacks);
        assert_eq!(restored.active_screen().unwrap(), ActiveScreen::Alternate);
        assert_eq!(restored.tracked_row_snapshot().unwrap(), observer);
        for output in [
            b"\x1b[?1049l".as_slice(),
            b"\r\nsix\r\nseven",
            b"\x1b[2Jrepaint",
        ] {
            source.write(output);
            restored.write(output);
            assert_eq!(
                source.tracked_row_snapshot().unwrap(),
                restored.tracked_row_snapshot().unwrap()
            );
            assert_eq!(source.track_row(3), restored.track_row(3));
            // Continued allocation can produce different page chunking in the
            // binary stream. Compare both complete screen exports instead.
            for screen in [ActiveScreen::Primary, ActiveScreen::Alternate] {
                assert_eq!(
                    source.screen_vt(screen).unwrap(),
                    restored.screen_vt(screen).unwrap()
                );
            }
        }
    }

    #[test]
    fn tracked_row_snapshot_rejection_keeps_existing_observer_and_screens() {
        let mut source = terminal();
        source.track_row(2);
        let original = source.tracked_row_snapshot().unwrap();
        let before = source.snapshot_bytes().unwrap();
        for invalid in [
            TrackedRowSnapshot {
                screen: ActiveScreen::Alternate,
                x: 0,
                y: 0,
            },
            TrackedRowSnapshot {
                screen: ActiveScreen::Primary,
                x: 20,
                y: 0,
            },
            TrackedRowSnapshot {
                screen: ActiveScreen::Primary,
                x: 0,
                y: u32::MAX,
            },
        ] {
            assert!(source.restore_tracked_row_snapshot(Some(invalid)).is_err());
            assert_eq!(source.tracked_row_snapshot().unwrap(), original);
            assert_eq!(source.snapshot_bytes().unwrap(), before);
        }
        source.restore_tracked_row_snapshot(None).unwrap();
        assert_eq!(source.tracked_row_snapshot().unwrap(), None);
    }

    #[test]
    fn tracked_row_snapshot_preserves_nonzero_column_and_budgeted_lifetime() {
        let mut source = terminal();
        source.write(b"abcdefghijklmnop");
        let observer = Some(TrackedRowSnapshot {
            screen: ActiveScreen::Primary,
            x: 13,
            y: 0,
        });
        source.restore_tracked_row_snapshot(observer).unwrap();
        let mut restored =
            Terminal::from_snapshot_with_budget(&source.snapshot_bytes().unwrap(), 4096, 1 << 24)
                .unwrap();
        restored.restore_tracked_row_snapshot(observer).unwrap();
        assert_eq!(restored.tracked_row_snapshot().unwrap(), observer);
        // Raw native resize deliberately retains the pin to exercise reflow.
        // The Windows wrapper normally clears its read observer before resize.
        unsafe {
            ffi::ghostty_terminal_resize(source.raw, 8, 4, 1, 1)
                .into_result()
                .unwrap();
            ffi::ghostty_terminal_resize(restored.raw, 8, 4, 1, 1)
                .into_result()
                .unwrap();
        }
        assert_eq!(
            source.tracked_row_snapshot().unwrap(),
            restored.tracked_row_snapshot().unwrap()
        );
        assert_eq!(source.tracked_row_snapshot().unwrap().unwrap().x, 5);
        let reference = std::mem::replace(&mut restored.tracked_row, ptr::null_mut());
        drop(restored);
        // SAFETY: the detached reference retains its own allocator owner.
        unsafe {
            assert!(!ffi::ghostty_tracked_grid_ref_has_value(reference));
            ffi::ghostty_tracked_grid_ref_free(reference);
        }
    }

    #[test]
    fn tracked_row_snapshot_invalid_observer_is_equivalent_to_absent() {
        let mut source = terminal();
        source.track_row(0);
        source.write(b"\x1bc");
        assert_eq!(source.tracked_row_snapshot().unwrap(), None);
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        restored.restore_tracked_row_snapshot(None).unwrap();
        assert_eq!(source.track_row(2), restored.track_row(2));
        assert_eq!(
            source.tracked_row_snapshot().unwrap(),
            restored.tracked_row_snapshot().unwrap()
        );
    }

    #[test]
    fn tracked_row_snapshot_pruned_observer_continues_through_output() {
        let mut source = Terminal::new_with_snapshot_tracking(20, 4, 0, 4096).unwrap();
        source.track_row(0);
        for _ in 0..1000 {
            source.write(b"line\r\n");
        }
        // With no history, native scrolling can retarget the observer to the
        // surviving top row rather than marking it garbage. Preserve that fact.
        let observer = source.tracked_row_snapshot().unwrap();
        let mut restored =
            Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
        restored.restore_tracked_row_snapshot(observer).unwrap();
        for output in [b"later\r\n".as_slice(), b"\x1b[?1049hALT\x1b[?1049l"] {
            source.write(output);
            restored.write(output);
            assert_eq!(
                source.tracked_row_snapshot().unwrap(),
                restored.tracked_row_snapshot().unwrap()
            );
        }
        assert_eq!(source.track_row(3), restored.track_row(3));
    }
}
