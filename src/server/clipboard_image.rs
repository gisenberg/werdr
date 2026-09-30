use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const STAGED_CLIPBOARD_IMAGE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Browser controllers reconnect after network changes and phone backgrounding.
/// A pasted path may still be unread by the pane's application, so a
/// disconnected client's images outlive it by this reconnect window.
const RETIRED_CLIPBOARD_IMAGE_GRACE: Duration = Duration::from_secs(10 * 60);

/// Staged images whose client disconnected, deleted once their grace expires.
#[derive(Debug, Default)]
pub(crate) struct RetiredClipboardImages {
    files: Vec<(PathBuf, Instant)>,
}

impl RetiredClipboardImages {
    pub(crate) fn retire(&mut self, paths: Vec<PathBuf>, now: Instant) {
        let deadline = now + RETIRED_CLIPBOARD_IMAGE_GRACE;
        self.files
            .extend(paths.into_iter().map(|path| (path, deadline)));
    }

    pub(crate) fn take_expired(&mut self, now: Instant) -> Vec<PathBuf> {
        let (expired, retained) = std::mem::take(&mut self.files)
            .into_iter()
            .partition::<Vec<_>, _>(|(_, deadline)| *deadline <= now);
        self.files = retained;
        expired.into_iter().map(|(path, _)| path).collect()
    }

    pub(crate) fn take_all(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.files)
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    }
}

pub(crate) struct StagedClipboardImage {
    pub(crate) path: PathBuf,
    pub(crate) paste_text: String,
}

pub(crate) fn stage(
    client_id: u64,
    extension: &str,
    data: &[u8],
) -> io::Result<StagedClipboardImage> {
    let extension = sanitize_extension(extension);
    let dir = ensure_staging_dir()?;
    cleanup_stale(&dir);

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    for attempt in 0..100 {
        let path = dir.join(format!(
            "client-{client_id}-clipboard-{unique}-{attempt}.{extension}"
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        restrict_file_options(&mut options);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        };
        file.write_all(data)?;
        return Ok(StagedClipboardImage {
            paste_text: path.to_string_lossy().into_owned(),
            path,
        });
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate unique clipboard image staging path",
    ))
}

pub(crate) fn remove_files(paths: Vec<PathBuf>) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn sanitize_extension(extension: &str) -> &'static str {
    if extension.eq_ignore_ascii_case("png") {
        "png"
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        "jpg"
    } else if extension.eq_ignore_ascii_case("gif") {
        "gif"
    } else if extension.eq_ignore_ascii_case("webp") {
        "webp"
    } else if extension.eq_ignore_ascii_case("bmp") {
        "bmp"
    } else {
        "png"
    }
}

fn staging_dir() -> PathBuf {
    #[cfg(unix)]
    let user_id = unsafe { libc::geteuid() };
    #[cfg(windows)]
    let user_id = std::process::id();
    std::env::temp_dir().join(format!("herdr-clipboard-images-{user_id}"))
}

fn ensure_staging_dir() -> io::Result<PathBuf> {
    let dir = staging_dir();
    fs::create_dir_all(&dir)?;
    let metadata = fs::metadata(&dir)?;
    if !metadata.is_dir() {
        return Err(io::Error::other(format!(
            "clipboard image staging path is not a directory: {}",
            dir.display()
        )));
    }
    restrict_dir_permissions(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn restrict_file_options(options: &mut fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(windows)]
fn restrict_file_options(_options: &mut fs::OpenOptions) {}

#[cfg(unix)]
fn restrict_dir_permissions(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
fn restrict_dir_permissions(_dir: &Path) -> io::Result<()> {
    Ok(())
}

fn cleanup_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified.elapsed().unwrap_or_default() > STAGED_CLIPBOARD_IMAGE_MAX_AGE {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_images_expire_only_after_the_reconnect_grace() {
        let start = Instant::now();
        let mut retired = RetiredClipboardImages::default();
        retired.retire(vec![PathBuf::from("a.png")], start);
        retired.retire(
            vec![PathBuf::from("b.png")],
            start + Duration::from_secs(60),
        );
        assert!(retired.take_expired(start).is_empty());
        assert!(retired
            .take_expired(start + RETIRED_CLIPBOARD_IMAGE_GRACE - Duration::from_millis(1))
            .is_empty());
        assert_eq!(
            retired.take_expired(start + RETIRED_CLIPBOARD_IMAGE_GRACE),
            vec![PathBuf::from("a.png")]
        );
        assert_eq!(retired.take_all(), vec![PathBuf::from("b.png")]);
        assert!(retired.take_all().is_empty());
    }

    #[test]
    fn sanitize_extension_accepts_known_image_extensions() {
        assert_eq!(sanitize_extension("PNG"), "png");
        assert_eq!(sanitize_extension("jpeg"), "jpg");
        assert_eq!(sanitize_extension("webp"), "webp");
        assert_eq!(sanitize_extension("sh"), "png");
    }
}
