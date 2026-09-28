//! Owned graphics policy, separate from native terminal payload snapshots.

use crate::{ffi, native_source, Error, GhosttyResultExt, Terminal};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScreenPolicy {
    flags: u32,
    storage_limit: u64,
    directory: Vec<u8>,
}

/// In-memory policy record, not a wire format or full snapshot eligibility.
/// Capture at the same exclusive cut as the native terminal. Partial APC and
/// retained graphics remain excluded until their own preservation is supported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsPolicySnapshot {
    features: u32,
    flags: u32,
    kitty_max_bytes: usize,
    glyph_max_bytes: usize,
    unknown_max_bytes: usize,
    screens: [ScreenPolicy; 2],
    png_forwarding: bool,
    source_forwarding: bool,
}

fn check_lengths(lengths: [usize; 2], limit: usize) -> Result<(), Error> {
    if lengths[0].checked_add(lengths[1]).is_none_or(|n| n > limit) {
        return Err(Error(ffi::GhosttyResult_GHOSTTY_LIMIT_EXCEEDED));
    }
    Ok(())
}

impl Terminal {
    /// Copy exact native policy and Rust forwarding intent. The limit bounds
    /// combined directory payload bytes, not fixed DTO or allocator overhead.
    pub fn graphics_policy_snapshot(
        &self,
        directory_limit: usize,
    ) -> Result<GraphicsPolicySnapshot, Error> {
        let mut native = ffi::GhosttySnapshotGraphicsPolicyV1 {
            size: std::mem::size_of::<ffi::GhosttySnapshotGraphicsPolicyV1>(),
            ..Default::default()
        };
        // SAFETY: live terminal, correctly sized output, and directory borrows
        // remain valid until copied because no terminal mutation occurs here.
        unsafe {
            ffi::ghostty_snapshot_graphics_policy_get(self.raw, &mut native).into_result()?;
        }
        check_lengths(native.screens.map(|s| s.directory.len), directory_limit)?;
        let mut screens = std::array::from_fn(|_| ScreenPolicy {
            flags: 0,
            storage_limit: 0,
            directory: Vec::new(),
        });
        for (dest, source) in screens.iter_mut().zip(native.screens) {
            dest.flags = source.flags;
            dest.storage_limit = source.storage_limit;
            if source.directory.len != 0 {
                if source.directory.ptr.is_null() || source.directory.len > isize::MAX as usize {
                    return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
                }
                dest.directory
                    .try_reserve_exact(source.directory.len)
                    .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
                // SAFETY: nonnull native-owned borrow with validated length,
                // protected against mutation for this entire capture.
                dest.directory.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(source.directory.ptr, source.directory.len)
                });
            }
        }
        Ok(GraphicsPolicySnapshot {
            features: native.features,
            flags: native.flags,
            kitty_max_bytes: native.kitty_max_bytes,
            glyph_max_bytes: native.glyph_max_bytes,
            unknown_max_bytes: native.unknown_max_bytes,
            screens,
            png_forwarding: self.kitty_png_forwarding,
            source_forwarding: self.kitty_source_forwarding,
        })
    }

    /// Apply to an unpublished, graphics-empty terminal after native decode.
    /// Validation and native allocation precede mutation. No environment paths,
    /// screen activation, eviction or callback emission are involved. Destination
    /// callbacks are rebound, never copied from the source. Consumers must use
    /// a fresh graphics cache namespace when publishing this terminal.
    pub fn restore_graphics_policy_snapshot(
        &mut self,
        policy: &GraphicsPolicySnapshot,
        directory_limit: usize,
    ) -> Result<(), Error> {
        check_lengths(
            policy.screens.each_ref().map(|s| s.directory.len()),
            directory_limit,
        )?;
        let native = ffi::GhosttySnapshotGraphicsPolicyV1 {
            size: std::mem::size_of::<ffi::GhosttySnapshotGraphicsPolicyV1>(),
            features: policy.features,
            flags: policy.flags,
            kitty_max_bytes: policy.kitty_max_bytes,
            glyph_max_bytes: policy.glyph_max_bytes,
            unknown_max_bytes: policy.unknown_max_bytes,
            screens: policy
                .screens
                .each_ref()
                .map(|s| ffi::GhosttySnapshotScreenPolicyV1 {
                    flags: s.flags,
                    storage_limit: s.storage_limit,
                    directory: ffi::GhosttyString {
                        ptr: s.directory.as_ptr(),
                        len: s.directory.len(),
                    },
                }),
        };
        // SAFETY: policy borrows outlive the call, the native function copies
        // directories before committing, and this terminal is exclusively held.
        unsafe {
            ffi::ghostty_snapshot_graphics_policy_set(
                self.raw,
                &native,
                native_source::forwarding_callback(policy.source_forwarding),
            )
            .into_result()?;
        }
        crate::install_png_decoder_once();
        self.kitty_png_forwarding = policy.png_forwarding;
        self.kitty_source_forwarding = policy.source_forwarding;
        self.kitty_empty_generation.set(None);
        // Poisoned presentation caches are disposable, not authoritative state.
        self.kitty_fingerprints
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal() -> Terminal {
        let mut terminal = Terminal::new_with_snapshot_tracking(20, 4, 100_000, 4096).unwrap();
        terminal.resize(20, 4, 8, 16).unwrap();
        terminal
    }

    #[test]
    fn graphics_policy_snapshot_restores_exact_policy_and_future_alt() {
        for forwarding in [false, true] {
            let mut source = terminal();
            source.enable_kitty_graphics().unwrap();
            source.set_kitty_source_forwarding(forwarding).unwrap();
            source.set_kitty_png_forwarding(forwarding).unwrap();
            let policy = source.graphics_policy_snapshot(16384).unwrap();
            let binary = source.snapshot_bytes().unwrap();
            let mut restored = Terminal::from_snapshot(&binary, 4096).unwrap();
            restored
                .restore_graphics_policy_snapshot(&policy, 16384)
                .unwrap();
            assert_eq!(restored.graphics_policy_snapshot(16384).unwrap(), policy);
            assert_eq!(restored.snapshot_bytes().unwrap(), binary);
            for suffix in [b"\x1b[?1049h".as_slice(), b"\x1b[?1049l", b"\x1b[?1049h"] {
                source.write(suffix);
                restored.write(suffix);
                assert_eq!(
                    restored.graphics_policy_snapshot(16384).unwrap(),
                    source.graphics_policy_snapshot(16384).unwrap()
                );
            }
            drop(source);
            restored.enable_kitty_graphics().unwrap();
            restored.graphics_policy_snapshot(16384).unwrap();
        }
    }

    #[test]
    fn graphics_policy_snapshot_preserves_future_graphics_and_apc_limits() {
        for limit in [None, Some(0), Some(1024)] {
            let mut source = terminal();
            source.enable_kitty_graphics().unwrap();
            let mut policy = source.graphics_policy_snapshot(16384).unwrap();
            policy.flags &= !4;
            policy.kitty_max_bytes = limit.unwrap_or(0);
            if limit.is_some() {
                policy.flags |= 4;
            }
            source
                .restore_graphics_policy_snapshot(&policy, 16384)
                .unwrap();
            let mut restored =
                Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
            restored
                .restore_graphics_policy_snapshot(&policy, 16384)
                .unwrap();
            let image = b"\x1b[?1049h\x1b_Ga=T,f=32,s=1,v=1,i=7,q=2;/wAA/w==\x1b\\";
            source.write(image);
            restored.write(image);
            let before = source.kitty_image_placements().unwrap();
            let after = restored.kitty_image_placements().unwrap();
            assert_eq!(before.len(), after.len());
            assert_eq!(
                before.len(),
                usize::from(limit != Some(0)),
                "limit {limit:?}"
            );
            if let Some(image) = before.first() {
                assert_eq!(after[0].data, image.data);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn graphics_policy_snapshot_preserves_future_file_permissions() {
        use base64::Engine as _;
        let store = crate::pane_graphics_files::FileStore::default();
        let image = store.export(&[17u8; 16]).unwrap();
        let command = format!(
            "\x1b_Ga=T,t=f,f=32,s=2,v=2,i=7,q=2;{}\x1b\\",
            base64::engine::general_purpose::STANDARD
                .encode(image.path().as_os_str().as_encoded_bytes())
        );
        for allowed in [false, true] {
            let mut source = terminal();
            source.enable_kitty_graphics().unwrap();
            source.set_kitty_source_forwarding(false).unwrap();
            let mut policy = source.graphics_policy_snapshot(16384).unwrap();
            policy.screens[0].flags &= !2;
            if allowed {
                policy.screens[0].flags |= 2;
            }
            source
                .restore_graphics_policy_snapshot(&policy, 16384)
                .unwrap();
            let mut restored =
                Terminal::from_snapshot(&source.snapshot_bytes().unwrap(), 4096).unwrap();
            restored
                .restore_graphics_policy_snapshot(&policy, 16384)
                .unwrap();
            source.write(command.as_bytes());
            assert_eq!(
                source.kitty_image_placements().unwrap().len(),
                usize::from(allowed),
                "source file policy"
            );
            drop(source);
            restored.write(command.as_bytes());
            let placements = restored.kitty_image_placements().unwrap();
            assert_eq!(placements.len(), usize::from(allowed));
            if allowed {
                assert_eq!(placements[0].data, [17u8; 16]);
            }
        }
    }

    #[test]
    fn graphics_policy_snapshot_rejects_invalid_input_without_mutation() {
        let mut source = terminal();
        source.enable_kitty_graphics().unwrap();
        let baseline = source.graphics_policy_snapshot(16384).unwrap();
        assert!(source.graphics_policy_snapshot(0).is_err());
        assert!(source
            .restore_graphics_policy_snapshot(&baseline, 0)
            .is_err());
        for variant in 0..5 {
            let mut invalid = baseline.clone();
            match variant {
                0 => invalid.flags |= 1 << 31,
                1 => invalid.features ^= 1,
                2 => invalid.screens[1].flags = 1,
                3 => invalid.screens[0].flags |= 1 << 31,
                _ => {
                    invalid.flags &= !4;
                    invalid.kitty_max_bytes = 1;
                }
            }
            assert!(source
                .restore_graphics_policy_snapshot(&invalid, 16384)
                .is_err());
            assert_eq!(source.graphics_policy_snapshot(16384).unwrap(), baseline);
        }
        source.write(b"\x1b_G");
        assert!(source
            .restore_graphics_policy_snapshot(&baseline, 16384)
            .is_err());
        assert_eq!(source.graphics_policy_snapshot(16384).unwrap(), baseline);
    }
}
