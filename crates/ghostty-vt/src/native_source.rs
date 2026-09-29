//! Host-owned immutable file snapshots retained by the native image lifetime.
use super::{ffi, Error, GhosttyResultExt};
use crate::pane_graphics_files::{FileStore, OwnedExport};
use std::ffi::c_void;
use std::ptr;
use std::sync::{Arc, OnceLock};

static SOURCES: OnceLock<FileStore> = OnceLock::new();

/// Retain a borrowed backing produced by this wrapper.
///
/// SAFETY: the native handle is private and every admitted file producer owns
/// an Arc<OwnedExport>. Callback checks are defensive, not validation of an
/// arbitrary foreign context pointer. The borrow must protect its live Arc.
pub(super) unsafe fn retain_backing(
    backing: &ffi::GhosttyKittyImageFileBacking,
) -> Result<Arc<OwnedExport>, Error> {
    let known_read = backing.read.is_some_and(|callback| {
        std::ptr::fn_addr_eq(
            callback,
            read as unsafe extern "C" fn(*mut c_void, *mut u8, usize) -> bool,
        )
    });
    let known_release = backing.release.is_some_and(|callback| {
        std::ptr::fn_addr_eq(callback, release as unsafe extern "C" fn(*mut c_void))
    });
    if backing.context.is_null() || !known_read || !known_release {
        return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
    }
    let ptr = backing.context.cast::<OwnedExport>();
    // SAFETY: caller supplies a protected live reference of this exact type.
    let source = unsafe {
        Arc::increment_strong_count(ptr);
        Arc::from_raw(ptr)
    };
    if source.fingerprint() != backing.identity || source.len() != backing.len {
        return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
    }
    Ok(source)
}

/// Transfer exactly one host-owned reference. Nothing fallible follows into_raw.
pub(super) fn export_backing(source: Arc<OwnedExport>) -> ffi::GhosttyKittyImageFileBacking {
    ffi::GhosttyKittyImageFileBacking {
        identity: source.fingerprint(),
        len: source.len(),
        context: Arc::into_raw(source).cast_mut().cast(),
        read: Some(read),
        release: Some(release),
    }
}

// These getters never materialize native pixels. The image borrow protects the
// host's strong reference until we have acquired our own.
pub(super) fn image_source(
    image: ffi::GhosttyKittyGraphicsImage,
) -> Result<Option<Arc<OwnedExport>>, Error> {
    let mut context: *mut c_void = ptr::null_mut();
    let result = unsafe {
        ffi::ghostty_kitty_graphics_image_get(
            image,
            ffi::GhosttyKittyGraphicsImageData_GHOSTTY_KITTY_IMAGE_DATA_FILE_CONTEXT,
            (&mut context as *mut *mut c_void).cast(),
        )
    };
    if result == ffi::GhosttyResult_GHOSTTY_NO_VALUE {
        return Ok(None);
    }
    result.into_result()?;
    if context.is_null() {
        return Ok(None);
    }
    let mut identity = 0u64;
    unsafe {
        ffi::ghostty_kitty_graphics_image_get(
            image,
            ffi::GhosttyKittyGraphicsImageData_GHOSTTY_KITTY_IMAGE_DATA_FILE_IDENTITY,
            (&mut identity as *mut u64).cast(),
        )
        .into_result()?;
        let source = context.cast::<OwnedExport>();
        // All terminal snapshot callbacks in this wrapper produce this type.
        // Identity is immutable and does not depend on decoded pixel storage.
        if (*source).fingerprint() != identity {
            return Err(Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE));
        }
        Arc::increment_strong_count(source);
        Ok(Some(Arc::from_raw(source)))
    }
}

pub(super) fn forwarding_callback(enabled: bool) -> ffi::GhosttyKittyImageSnapshotFileFn {
    if enabled && cfg!(target_os = "linux") {
        Some(snapshot)
    } else {
        None
    }
}

pub(super) fn set_forwarding(terminal: ffi::GhosttyTerminal, enabled: bool) -> Result<(), Error> {
    let callback =
        forwarding_callback(enabled).map_or(ptr::null(), |callback| (callback as *const ()).cast());
    unsafe {
        ffi::ghostty_terminal_set(
            terminal,
            ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_SNAPSHOT_FILE,
            callback,
        )
        .into_result()
    }
}

unsafe extern "C" fn snapshot(
    _terminal: ffi::GhosttyTerminal,
    _userdata: *mut c_void,
    request: *const ffi::GhosttyKittyImageSnapshotFileRequest,
    out: *mut ffi::GhosttyKittyImageFileBacking,
) -> bool {
    std::panic::catch_unwind(|| {
        if request.is_null() || out.is_null() || !cfg!(target_os = "linux") {
            return false;
        }
        let request = unsafe { &*request };
        if request.size != std::mem::size_of::<ffi::GhosttyKittyImageSnapshotFileRequest>() {
            return false;
        }
        let Ok(len) = usize::try_from(request.expected_len) else {
            return false;
        };
        let Ok(source) = SOURCES
            .get_or_init(FileStore::native_sources)
            .snapshot(request.fd, len)
        else {
            return false;
        };
        let backing = export_backing(Arc::new(source));
        unsafe {
            out.write(backing);
        }
        true
    })
    .unwrap_or(false)
}

unsafe extern "C" fn read(context: *mut c_void, dest: *mut u8, len: usize) -> bool {
    std::panic::catch_unwind(|| {
        if context.is_null() || dest.is_null() {
            return false;
        }
        let source = unsafe { &*context.cast::<OwnedExport>() };
        if len != source.len() || len > isize::MAX as usize {
            return false;
        }
        source
            .read_into(unsafe { std::slice::from_raw_parts_mut(dest, len) })
            .is_ok()
    })
    .unwrap_or(false)
}

unsafe extern "C" fn release(context: *mut c_void) {
    let _ = std::panic::catch_unwind(|| {
        if !context.is_null() {
            drop(unsafe { Arc::from_raw(context.cast::<OwnedExport>()) });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_requests_decline_without_transferring_ownership() {
        let mut out = ffi::GhosttyKittyImageFileBacking::default();
        let mut request = ffi::GhosttyKittyImageSnapshotFileRequest {
            size: std::mem::size_of::<ffi::GhosttyKittyImageSnapshotFileRequest>(),
            fd: -1,
            expected_len: 4,
        };
        unsafe {
            assert!(!snapshot(
                ptr::null_mut(),
                ptr::null_mut(),
                &request,
                &mut out
            ));
            assert!(out.context.is_null());
            request.size = 0;
            assert!(!snapshot(
                ptr::null_mut(),
                ptr::null_mut(),
                &request,
                &mut out
            ));
            assert!(!snapshot(
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
                &mut out
            ));
            assert!(out.context.is_null());
            release(ptr::null_mut());
        }
    }
}
