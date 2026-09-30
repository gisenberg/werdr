//! Owned in-process graphics records and immutable file attachments.
//! Not a process-transfer envelope, producer fence or full terminal snapshot.
use crate::{
    ffi, native_source, pane_graphics_files::OwnedExport, Error, GhosttyResultExt, Terminal,
};
use std::{collections::HashMap, ffi::c_void, panic::AssertUnwindSafe, ptr, sync::Arc};

#[derive(Debug, Clone, Copy)]
pub struct GraphicsSnapshotLimits {
    pub encoded_bytes: usize,
    pub backing_bytes: usize,
    pub images: usize,
    pub placements: usize,
    pub policy_bytes: usize,
}

impl GraphicsSnapshotLimits {
    fn native(self) -> ffi::GhosttyGraphicsSnapshotLimitsV1 {
        ffi::GhosttyGraphicsSnapshotLimitsV1 {
            size: std::mem::size_of::<ffi::GhosttyGraphicsSnapshotLimitsV1>(),
            encoded_bytes: self.encoded_bytes,
            backing_bytes: self.backing_bytes,
            images: self.images,
            placements: self.placements,
            policy_bytes: self.policy_bytes,
        }
    }
}

/// Keeps native-file attachments alive independently of the source terminal.
/// Private bytes cannot be detached and mistaken for a cross-process snapshot.
pub struct GraphicsSnapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) attachments: HashMap<u64, Arc<OwnedExport>>,
}

impl GraphicsSnapshot {
    /// Logical retained payload, including immutable file attachments once per
    /// identity. This does not measure allocator or filesystem block overhead.
    pub fn retained_payload_bytes(&self) -> Option<usize> {
        self.attachments
            .values()
            .try_fold(self.bytes.len(), |total, attachment| {
                total.checked_add(attachment.len())
            })
    }
}

impl std::fmt::Debug for GraphicsSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GraphicsSnapshot")
            .field("encoded_bytes", &self.bytes.len())
            .field("attachments", &self.attachments.len())
            .finish_non_exhaustive()
    }
}

struct Encoded {
    ptr: *mut u8,
    len: usize,
}
impl Drop for Encoded {
    fn drop(&mut self) {
        // SAFETY: native capture uses the default allocator and this sole owner.
        unsafe { ffi::ghostty_free(ptr::null(), self.ptr.cast(), self.len) };
    }
}

fn invalid() -> Error {
    Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE)
}
fn out_of_memory() -> Error {
    Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY)
}

struct Capture {
    attachments: HashMap<u64, Arc<OwnedExport>>,
    error: Option<Error>,
}

impl Capture {
    unsafe fn retain(&mut self, backing: &ffi::GhosttyKittyImageFileBacking) -> Result<(), Error> {
        if let Some(error) = self.error {
            return Err(error);
        }
        // SAFETY: private Terminal handles admit only our OwnedExport producers;
        // the synchronous C callback borrows the live source image's reference.
        let source = unsafe { native_source::retain_backing(backing)? };
        if let Some(existing) = self.attachments.get(&backing.identity) {
            // FileStore counters are local, so equal IDs alone prove nothing.
            if !Arc::ptr_eq(existing, &source) {
                return Err(invalid());
            }
        } else {
            self.attachments
                .try_reserve(1)
                .map_err(|_| out_of_memory())?;
            self.attachments.insert(backing.identity, source);
        }
        Ok(())
    }
}

unsafe extern "C" fn retain(
    context: *mut c_void,
    backing: *const ffi::GhosttyKittyImageFileBacking,
) -> bool {
    if context.is_null() || backing.is_null() {
        return false;
    }
    // SAFETY: capture provides this live, exclusive context for the call.
    let capture = unsafe { &mut *context.cast::<Capture>() };
    let result =
        std::panic::catch_unwind(AssertUnwindSafe(|| unsafe { capture.retain(&*backing) }))
            .unwrap_or_else(|_| Err(invalid()));
    match result {
        Ok(()) => true,
        Err(error) => {
            capture.error = Some(error);
            false
        }
    }
}

struct Restore<'a> {
    attachments: &'a HashMap<u64, Arc<OwnedExport>>,
    error: Option<Error>,
}

unsafe extern "C" fn resolve(
    context: *mut c_void,
    identity: u64,
    len: usize,
    out: *mut ffi::GhosttyKittyImageFileBacking,
) -> bool {
    if context.is_null() || out.is_null() {
        return false;
    }
    // SAFETY: restore provides this exclusive stack context for the call.
    let restore = unsafe { &mut *context.cast::<Restore<'_>>() };
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let source = restore.attachments.get(&identity).ok_or_else(invalid)?;
        if source.fingerprint() != identity || source.len() != len {
            return Err(invalid());
        }
        let backing = native_source::export_backing(Arc::clone(source));
        // SAFETY: C supplies a writable exact-sized output, and no fallible work
        // remains after creating the transferred reference.
        unsafe { out.write(backing) };
        Ok(())
    }))
    .unwrap_or_else(|_| Err(invalid()));
    match result {
        Ok(()) => true,
        Err(error) => {
            restore.error = Some(error);
            false
        }
    }
}

impl Terminal {
    /// Capture under the same exclusive runtime cut as core/parser/policy data.
    /// No screen activation, file reads, PNG decode or historical effects occur.
    /// Limits bound logical backing and record counts, not total process RSS.
    pub fn graphics_snapshot(
        &self,
        limits: GraphicsSnapshotLimits,
    ) -> Result<GraphicsSnapshot, Error> {
        let mut capture = Capture {
            attachments: HashMap::new(),
            error: None,
        };
        let mut bytes = Encoded {
            ptr: ptr::null_mut(),
            len: 0,
        };
        // SAFETY: handle and outputs are live; callback context and all source
        // references remain valid through synchronous native capture.
        let result = unsafe {
            ffi::ghostty_graphics_snapshot_encode_alloc(
                self.raw,
                ptr::null(),
                &limits.native(),
                Some(retain),
                (&mut capture as *mut Capture).cast(),
                &mut bytes.ptr,
                &mut bytes.len,
            )
        };
        if let Some(error) = capture.error {
            return Err(error);
        }
        result.into_result()?;
        if bytes.ptr.is_null() || bytes.len > isize::MAX as usize {
            return Err(invalid());
        }
        let mut encoded = Vec::new();
        encoded
            .try_reserve_exact(bytes.len)
            .map_err(|_| out_of_memory())?;
        // SAFETY: success returned an owned valid byte allocation, checked above.
        encoded.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes.ptr, bytes.len) });
        Ok(GraphicsSnapshot {
            bytes: encoded,
            attachments: capture.attachments,
        })
    }

    /// Restore into an unpublished terminal after matching core reconstruction
    /// and graphics policy/forwarding restoration. Both screens and all loading
    /// generation references rebind together. No producer authority is inferred.
    /// C has no animation ticker, so raw nullable timestamps remain unchanged.
    pub fn restore_graphics_snapshot(
        &mut self,
        snapshot: &GraphicsSnapshot,
        limits: GraphicsSnapshotLimits,
    ) -> Result<(), Error> {
        let mut context = Restore {
            attachments: &snapshot.attachments,
            error: None,
        };
        // SAFETY: input and attachment owners outlive synchronous restore; the
        // exclusively held destination receives its own cloned host references.
        let result = unsafe {
            ffi::ghostty_graphics_snapshot_restore(
                self.raw,
                snapshot.bytes.as_ptr(),
                snapshot.bytes.len(),
                &limits.native(),
                Some(resolve),
                (&mut context as *mut Restore<'_>).cast(),
            )
        };
        if let Some(error) = context.error {
            return Err(error);
        }
        result.into_result()?;
        self.kitty_fingerprints
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.kitty_empty_generation.set(None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane_graphics_files::FileStore;

    const LIMITS: GraphicsSnapshotLimits = GraphicsSnapshotLimits {
        encoded_bytes: 1 << 20,
        backing_bytes: 1 << 20,
        images: 100,
        placements: 100,
        policy_bytes: 4096,
    };

    fn terminal() -> Terminal {
        let mut t = Terminal::new(20, 4, 100_000).unwrap();
        t.enable_kitty_graphics().unwrap();
        t.resize(20, 4, 8, 16).unwrap();
        t
    }

    #[test]
    fn graphics_snapshot_both_screens_survive_source_and_record_destruction() {
        let mut source = terminal();
        source.write(b"\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;AQIDBA==\x1b\\");
        source.write(b"\x1b[?1049h\x1b_Ga=T,f=32,s=1,v=1,i=2,q=2;BAUGBw==\x1b\\");
        source.write(b"\x1b_Ga=t,f=32,s=1,v=1,i=3,m=1,q=2;AQI=\x1b\\");
        let core = source.snapshot_bytes().unwrap();
        let policy = source.graphics_policy_snapshot(4096).unwrap();
        let graphics = source.graphics_snapshot(LIMITS).unwrap();
        assert!(graphics.attachments.is_empty());
        drop(source);
        let mut dest = Terminal::from_snapshot(&core, 4096).unwrap();
        dest.restore_graphics_policy_snapshot(&policy, 4096)
            .unwrap();
        dest.restore_graphics_snapshot(&graphics, LIMITS).unwrap();
        dest.restore_graphics_snapshot(&graphics, LIMITS).unwrap();
        drop(graphics);
        assert_eq!(dest.kitty_image_placements().unwrap()[0].data, [4, 5, 6, 7]);
        dest.write(b"\x1b_Gm=0;AwQ=\x1b\\\x1b_Ga=p,i=3,p=3,q=2\x1b\\");
        assert!(dest
            .kitty_image_placements()
            .unwrap()
            .iter()
            .any(|p| p.data == [1, 2, 3, 4]));
        dest.write(b"\x1b[?1049l");
        assert_eq!(dest.kitty_image_placements().unwrap()[0].data, [1, 2, 3, 4]);
    }

    #[test]
    fn graphics_snapshot_limits_preserve_target_and_cached_state() {
        let mut source = terminal();
        source.write(b"\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;AQIDBA==\x1b\\");
        let graphics = source.graphics_snapshot(LIMITS).unwrap();
        let before = source.kitty_image_placements().unwrap();
        source.kitty_empty_generation.set(Some(123));
        let short = GraphicsSnapshotLimits {
            encoded_bytes: graphics.bytes.len() - 1,
            ..LIMITS
        };
        assert!(source.restore_graphics_snapshot(&graphics, short).is_err());
        assert_eq!(source.kitty_empty_generation.get(), Some(123));
        assert_eq!(
            source.kitty_image_placements().unwrap()[0].data,
            before[0].data
        );
        assert!(source.graphics_snapshot(short).is_err());
        source.restore_graphics_snapshot(&graphics, LIMITS).unwrap();
        assert_eq!(source.kitty_empty_generation.get(), None);
        assert!(source.kitty_fingerprints.lock().unwrap().is_empty());
    }

    // FileStore's secure file-backed exports are currently Unix-only.
    #[cfg(unix)]
    #[test]
    fn graphics_snapshot_attachment_collision_cleanup() {
        let first = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let second = Arc::new(FileStore::default().export(&[4, 3, 2, 1]).unwrap());
        assert_eq!(first.fingerprint(), second.fingerprint());
        let a = native_source::export_backing(Arc::clone(&first));
        let b = native_source::export_backing(Arc::clone(&second));
        let mut capture = Capture {
            attachments: HashMap::new(),
            error: None,
        };
        let ctx = (&mut capture as *mut Capture).cast();
        unsafe {
            assert!(retain(ctx, &a));
            assert!(retain(ctx, &a));
            assert!(!retain(ctx, &b));
        }
        assert_eq!(capture.attachments.len(), 1);
        assert_eq!(Arc::strong_count(&first), 3);
        assert_eq!(Arc::strong_count(&second), 2);
        drop(capture);
        unsafe {
            a.release.unwrap()(a.context);
            b.release.unwrap()(b.context);
        }
        assert_eq!(Arc::strong_count(&first), 1);
        assert_eq!(Arc::strong_count(&second), 1);
    }

    #[test]
    fn graphics_snapshot_rejects_foreign_provenance_and_missing_attachments() {
        let bad = ffi::GhosttyKittyImageFileBacking {
            context: std::ptr::dangling_mut(),
            ..Default::default()
        };
        // Rejected before the deliberately invalid foreign context is read.
        assert!(unsafe { native_source::retain_backing(&bad) }.is_err());
        let mut capture = Capture {
            attachments: HashMap::new(),
            error: None,
        };
        assert!(!unsafe { retain((&mut capture as *mut Capture).cast(), &bad) });
        assert!(capture.attachments.is_empty());
        assert!(capture.error.is_some());

        let attachments = HashMap::new();
        let mut context = Restore {
            attachments: &attachments,
            error: None,
        };
        let mut out = ffi::GhosttyKittyImageFileBacking::default();
        assert!(!unsafe { resolve((&mut context as *mut Restore<'_>).cast(), 1, 4, &mut out) });
        assert!(out.context.is_null());
        assert!(context.error.is_some());
    }

    // Successful reference transfer requires a real Unix OwnedExport.
    #[cfg(unix)]
    #[test]
    fn graphics_snapshot_resolver_checks_identity_length_and_transfers_one_reference() {
        let source = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let attachments = HashMap::from([(source.fingerprint(), Arc::clone(&source))]);
        let mut context = Restore {
            attachments: &attachments,
            error: None,
        };
        let ctx = (&mut context as *mut Restore<'_>).cast();
        let mut out = ffi::GhosttyKittyImageFileBacking::default();
        unsafe {
            assert!(!resolve(ctx, source.fingerprint(), 3, &mut out));
            assert!(!resolve(ctx, source.fingerprint() + 1, 4, &mut out));
            assert!(out.context.is_null());
            assert_eq!(Arc::strong_count(&source), 2);
            assert!(resolve(ctx, source.fingerprint(), 4, &mut out));
            assert_eq!(Arc::strong_count(&source), 3);
            out.release.unwrap()(out.context);
        }
        assert_eq!(Arc::strong_count(&source), 2);
    }

    #[cfg(not(unix))]
    #[test]
    fn graphics_snapshot_file_export_is_explicitly_unsupported() {
        let result = FileStore::default().export(&[1, 2, 3, 4]);
        assert!(matches!(result, Err(error) if error.kind() == std::io::ErrorKind::Unsupported));
    }

    #[cfg(target_os = "linux")]
    thread_local! {
        static FILE_SOURCE: std::cell::RefCell<Option<Arc<OwnedExport>>> = const { std::cell::RefCell::new(None) };
    }

    #[cfg(target_os = "linux")]
    unsafe extern "C" fn fixture_file(
        _: ffi::GhosttyTerminal,
        _: *mut c_void,
        _: *const ffi::GhosttyKittyImageSnapshotFileRequest,
        out: *mut ffi::GhosttyKittyImageFileBacking,
    ) -> bool {
        FILE_SOURCE.with(|slot| {
            let source = slot.borrow();
            let Some(source) = source.as_ref() else {
                return false;
            };
            unsafe { out.write(native_source::export_backing(Arc::clone(source))) };
            true
        })
    }

    #[cfg(target_os = "linux")]
    fn upload_file(t: &mut Terminal, source: &Arc<OwnedExport>, id: u32) {
        use base64::Engine;
        struct Clear;
        impl Drop for Clear {
            fn drop(&mut self) {
                FILE_SOURCE.with(|v| *v.borrow_mut() = None);
            }
        }
        FILE_SOURCE.with(|v| *v.borrow_mut() = Some(Arc::clone(source)));
        let _clear = Clear;
        unsafe {
            ffi::ghostty_terminal_set(
                t.raw,
                ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_SNAPSHOT_FILE,
                (fixture_file as *const ()).cast(),
            )
            .into_result()
            .unwrap();
        }
        let path = base64::engine::general_purpose::STANDARD
            .encode(source.path().as_os_str().as_encoded_bytes());
        t.write(format!("\x1b_Ga=T,t=f,f=32,s=1,v=1,i={id},q=2;{path}\x1b\\").as_bytes());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn file_backed_graphics_are_not_offered_for_byte_transfer() {
        let file = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let mut source = terminal();
        upload_file(&mut source, &file, 1);
        let snapshot = source.graphics_snapshot(LIMITS).unwrap();
        assert_eq!(snapshot.attachments.len(), 1);
        assert!(snapshot.transfer_bytes().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn graphics_snapshot_shared_files_keep_host_provenance_without_source() {
        let file = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let mut source = terminal();
        upload_file(&mut source, &file, 1);
        source.write(b"\x1b[?1049h");
        upload_file(&mut source, &file, 2);
        let core = source.snapshot_bytes().unwrap();
        let policy = source.graphics_policy_snapshot(4096).unwrap();
        let snapshot = source.graphics_snapshot(LIMITS).unwrap();
        assert_eq!(snapshot.attachments.len(), 1);
        assert_eq!(Arc::strong_count(&file), 4);
        drop(source);
        assert_eq!(Arc::strong_count(&file), 2);
        let mut dest = Terminal::from_snapshot(&core, 4096).unwrap();
        dest.restore_graphics_policy_snapshot(&policy, 4096)
            .unwrap();
        dest.restore_graphics_snapshot(&snapshot, LIMITS).unwrap();
        assert_eq!(Arc::strong_count(&file), 4);
        dest.restore_graphics_snapshot(&snapshot, LIMITS).unwrap();
        assert_eq!(Arc::strong_count(&file), 4);
        drop(snapshot);
        assert_eq!(Arc::strong_count(&file), 3);
        for switch in [b"".as_slice(), b"\x1b[?1049l".as_slice()] {
            dest.write(switch);
            let placements = dest
                .kitty_image_placements_with_data_filter(|_| false)
                .unwrap();
            assert!(Arc::ptr_eq(
                placements[0].source_file.as_ref().unwrap(),
                &file
            ));
            assert!(placements[0].data.is_empty());
        }
        drop(dest);
        assert_eq!(Arc::strong_count(&file), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn graphics_snapshot_partial_capture_collision_releases_prior_retains() {
        let first = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let second = Arc::new(FileStore::default().export(&[4, 3, 2, 1]).unwrap());
        let mut source = terminal();
        upload_file(&mut source, &first, 1);
        source.write(b"\x1b[?1049h");
        upload_file(&mut source, &second, 2);
        assert!(source.graphics_snapshot(LIMITS).is_err());
        assert_eq!(Arc::strong_count(&first), 2);
        assert_eq!(Arc::strong_count(&second), 2);
        drop(source);
        assert_eq!(Arc::strong_count(&first), 1);
        assert_eq!(Arc::strong_count(&second), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn graphics_snapshot_missing_second_attachment_rolls_back_first_resolution() {
        let store = FileStore::default();
        let first = Arc::new(store.export(&[1, 2, 3, 4]).unwrap());
        let second = Arc::new(store.export(&[4, 3, 2, 1]).unwrap());
        let mut source = terminal();
        upload_file(&mut source, &first, 1);
        source.write(b"\x1b[?1049h");
        upload_file(&mut source, &second, 2);
        let core = source.snapshot_bytes().unwrap();
        let policy = source.graphics_policy_snapshot(4096).unwrap();
        let mut snapshot = source.graphics_snapshot(LIMITS).unwrap();
        snapshot.attachments.remove(&second.fingerprint());
        drop(source);
        let mut dest = Terminal::from_snapshot(&core, 4096).unwrap();
        dest.restore_graphics_policy_snapshot(&policy, 4096)
            .unwrap();
        let before = dest.graphics_snapshot(LIMITS).unwrap();
        assert!(dest.restore_graphics_snapshot(&snapshot, LIMITS).is_err());
        assert_eq!(dest.graphics_snapshot(LIMITS).unwrap().bytes, before.bytes);
        assert_eq!(Arc::strong_count(&first), 2);
        assert_eq!(Arc::strong_count(&second), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn graphics_snapshot_defers_missing_file_read_without_materialization() {
        let file = Arc::new(FileStore::default().export(&[1, 2, 3, 4]).unwrap());
        let mut source = terminal();
        upload_file(&mut source, &file, 1);
        let core = source.snapshot_bytes().unwrap();
        let policy = source.graphics_policy_snapshot(4096).unwrap();
        // This path belongs only to this test's newly created export.
        std::fs::remove_file(file.path()).unwrap();
        let snapshot = source.graphics_snapshot(LIMITS).unwrap();
        drop(source);
        let mut dest = Terminal::from_snapshot(&core, 4096).unwrap();
        dest.restore_graphics_policy_snapshot(&policy, 4096)
            .unwrap();
        dest.restore_graphics_snapshot(&snapshot, LIMITS).unwrap();
        drop(snapshot);
        let placements = dest
            .kitty_image_placements_with_data_filter(|_| false)
            .unwrap();
        let restored = placements[0].source_file.as_ref().unwrap();
        assert!(Arc::ptr_eq(restored, &file));
        assert!(restored.copy_rgba().is_err());
        assert!(placements[0].data.is_empty());
    }
}
