#[cfg(unix)]
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Child, Command};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tracing::{info, warn};

#[cfg(unix)]
const HANDOFF_VERSION: u32 = 1;
#[cfg(unix)]
const READY_TIMEOUT: Duration = Duration::from_secs(30);
// Covers the importer's bounded service-manager claim before it reports ownership.
#[cfg(unix)]
const OWNED_ACK_TIMEOUT: Duration = Duration::from_secs(10);
// Descriptors are transferred in batches of this size. A single SCM_RIGHTS
// control message caps out at 253 descriptors on Linux and 254 on macOS, so the
// batch stays well below both limits and the number of panes stays unbounded.
#[cfg(unix)]
const FDS_PER_MESSAGE: usize = 64;
#[cfg(unix)]
const MAX_HANDOFF_LINE_BYTES: usize = 16 * 1024 * 1024;
#[cfg(unix)]
pub(crate) const COMMIT_TIMEOUT: Duration = READY_TIMEOUT;
// One pane's exact terminal state, streamed after the manifest so retained
// history never counts against the manifest line budget.
#[cfg(unix)]
const MAX_TERMINAL_STATE_RECORD_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(unix)]
const TERMINAL_STATE_ACCEPTED: &str = "validated terminal-state ";
#[cfg(unix)]
const IMPORT_REJECTED: &str = "rejected ";

#[cfg(unix)]
#[derive(Serialize, Deserialize)]
pub(crate) struct HandoffManifest {
    pub version: u32,
    pub source_version: String,
    pub source_protocol: u32,
    pub expected_version: Option<String>,
    pub expected_protocol: Option<u32>,
    pub snapshot: crate::persist::SessionSnapshot,
    pub panes: Vec<crate::handoff_runtime::HandoffRuntimeState>,
    /// An outer window title set over the API outlives the server that took the
    /// call, so a handoff carries it rather than falling back to the config.
    /// Absent from manifests written before this field existed.
    #[serde(default)]
    pub api_window_title: Option<String>,
    /// The importer must restore every pane's exact terminal state or refuse
    /// before ownership moves. Older importers ignore this field, so exporters
    /// also require the importer to accept the terminal-state codec.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub require_lossless: bool,
}

/// Refuse oversized transfers before spawning the importer or releasing ownership.
/// The importer has always bounded its manifest line; retention must never be
/// reduced merely to fit that transport budget.
#[cfg(unix)]
pub(crate) fn validate_manifest_size(manifest: &HandoffManifest) -> io::Result<()> {
    struct SizeLimit(usize);
    impl Write for SizeLimit {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_HANDOFF_LINE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "handoff manifest exceeds the transport limit; original runtime retained",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(SizeLimit(0), manifest).map_err(io::Error::other)
}

#[cfg(unix)]
pub(crate) struct ReceivedHandoff {
    pub manifest: HandoffManifest,
    /// Exact terminal-state records aligned with `manifest.panes`.
    pub terminal_states: Vec<Option<Vec<u8>>>,
    pub fds: Vec<RawFd>,
    pub stream: UnixStream,
}

#[cfg(unix)]
pub(crate) fn handoff_socket_path() -> PathBuf {
    crate::session::data_dir().join(format!("herdr-handoff-{}.sock", std::process::id()))
}

#[cfg(unix)]
pub(crate) fn spawn_handoff_import(
    import_exe: Option<&Path>,
    socket_path: &Path,
    token: &str,
) -> io::Result<Child> {
    let fallback_exe;
    let exe = if let Some(import_exe) = import_exe {
        import_exe
    } else {
        fallback_exe = std::env::current_exe().map_err(|err| {
            io::Error::new(
                err.kind(),
                format!("failed to determine herdr executable path: {err}"),
            )
        })?;
        &fallback_exe
    };
    let mut command = Command::new(exe);
    command
        .arg("server")
        .arg("--handoff-import")
        .arg(socket_path)
        .arg(token)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if crate::session::explicit_session_requested() {
        // The import child no longer has the original `--session` argument, so
        // stale socket overrides must not mask the inherited HERDR_SESSION.
        command
            .env_remove(crate::api::SOCKET_PATH_ENV_VAR)
            .env_remove(crate::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR);
    }
    // The runtime removed the notify socket from its own environment so panes
    // never inherit it; only the importer that may claim the service gets it.
    if let Some((key, value)) = crate::platform::capture_service_supervisor().importer_env() {
        command.env(key, value);
    }
    crate::platform::detach_server_daemon_command(&mut command);
    command.spawn().map_err(|err| {
        io::Error::new(
            err.kind(),
            format!(
                "failed to spawn handoff import server at {}: {err}",
                exe.display()
            ),
        )
    })
}

#[cfg(unix)]
pub(crate) fn cleanup_failed_import_child(child: &mut Child) {
    let pid = child.id();
    match child.try_wait() {
        Ok(Some(status)) => {
            info!(pid, status = %status, "handoff import server exited during rollback");
            return;
        }
        Ok(None) => {}
        Err(err) => {
            warn!(pid, err = %err, "failed to inspect handoff import server before rollback");
        }
    }

    if let Err(err) = child.kill() {
        warn!(pid, err = %err, "failed to kill handoff import server during rollback");
    }
    match child.wait() {
        Ok(status) => {
            info!(pid, status = %status, "handoff import server reaped during rollback");
        }
        Err(err) => {
            warn!(pid, err = %err, "failed to reap handoff import server during rollback");
        }
    }
}

#[cfg(unix)]
pub(crate) fn bind_listener(socket_path: &Path) -> io::Result<UnixListener> {
    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path)?;
    listener.set_nonblocking(true)?;
    restrict_socket_permissions(socket_path)?;
    Ok(listener)
}

#[cfg(unix)]
pub(crate) fn accept_and_validate_on(
    listener: UnixListener,
    socket_path: &Path,
    token: &str,
    manifest: &HandoffManifest,
    terminal_states: &[Option<Vec<u8>>],
) -> io::Result<UnixStream> {
    let (mut stream, _) = accept_with_timeout(&listener, READY_TIMEOUT)?;
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(READY_TIMEOUT))?;
    stream.set_write_timeout(Some(READY_TIMEOUT))?;
    let token_line = read_line_unbuffered(&mut stream)?;
    if token_line.trim_end() != token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "handoff import token mismatch",
        ));
    }

    serde_json::to_writer(&mut stream, manifest).map_err(io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    stream.set_read_timeout(Some(READY_TIMEOUT))?;
    let validated = read_line_unbuffered(&mut stream)?;
    let validated = validated.trim_end();
    if let Some(reason) = validated.strip_prefix(IMPORT_REJECTED) {
        return Err(io::Error::other(format!(
            "replacement server refused the handoff: {reason}"
        )));
    }
    if let Some(codec) = validated.strip_prefix(TERMINAL_STATE_ACCEPTED) {
        let own = crate::pane::terminal_state_codec();
        if codec != own {
            return Err(io::Error::other(format!(
                "replacement server accepted terminal-state codec {codec}, but this server offered {own}"
            )));
        }
        send_terminal_states(&mut stream, manifest, terminal_states)?;
    } else if validated != "validated" {
        return Err(io::Error::other("handoff import did not validate manifest"));
    } else if manifest.require_lossless {
        return Err(io::Error::other(
            "replacement server cannot restore exact terminal state; this server kept ownership",
        ));
    }
    let _ = std::fs::remove_file(socket_path);
    Ok(stream)
}

/// Stream each offered record in manifest pane order, prefixed by its length.
#[cfg(unix)]
fn send_terminal_states(
    stream: &mut UnixStream,
    manifest: &HandoffManifest,
    terminal_states: &[Option<Vec<u8>>],
) -> io::Result<()> {
    if terminal_states.len() != manifest.panes.len() {
        return Err(io::Error::other(
            "terminal-state records do not match panes",
        ));
    }
    for (pane, state) in manifest.panes.iter().zip(terminal_states) {
        match (&pane.terminal_state, state) {
            (Some(offer), Some(bytes)) if offer.bytes == bytes.len() as u64 => {
                stream.write_all(&offer.bytes.to_le_bytes())?;
                stream.write_all(bytes)?;
            }
            (None, None) => {}
            _ => {
                return Err(io::Error::other(
                    "terminal-state offer does not match its record",
                ))
            }
        }
    }
    stream.flush()
}

/// Codec this importer accepts. Debug builds allow tests to simulate an
/// incompatible replacement binary without building a second one.
#[cfg(unix)]
fn importer_terminal_state_codec() -> String {
    if cfg!(debug_assertions) {
        if let Ok(codec) = std::env::var("HERDR_TEST_HANDOFF_TERMINAL_STATE_CODEC") {
            return codec;
        }
    }
    crate::pane::terminal_state_codec()
}

/// Decide whether exact state can be accepted, or why a lossless handoff must fail.
#[cfg(unix)]
fn terminal_state_acceptance(manifest: &HandoffManifest, codec: &str) -> Result<bool, String> {
    let offers: Vec<_> = manifest
        .panes
        .iter()
        .map(|pane| pane.terminal_state.as_ref())
        .collect();
    let accept = offers.iter().any(Option::is_some)
        && offers.iter().flatten().all(|offer| offer.codec == codec);
    if !manifest.require_lossless {
        return Ok(accept);
    }
    if let Some(offer) = offers.iter().flatten().find(|offer| offer.codec != codec) {
        return Err(format!(
            "terminal-state codec {} is not this server's {codec}",
            offer.codec
        ));
    }
    if let Some(pane) = manifest.panes.iter().find(|pane| {
        pane.terminal_state
            .as_ref()
            .is_none_or(|offer| offer.graphics_dropped)
    }) {
        return Err(format!(
            "pane {} has no complete exact terminal state",
            pane.pane_id
        ));
    }
    Ok(accept || manifest.panes.is_empty())
}

#[cfg(unix)]
fn receive_terminal_states(
    stream: &mut UnixStream,
    manifest: &HandoffManifest,
) -> io::Result<Vec<Option<Vec<u8>>>> {
    manifest
        .panes
        .iter()
        .map(|pane| {
            let Some(offer) = &pane.terminal_state else {
                return Ok(None);
            };
            let mut len = [0u8; 8];
            stream.read_exact(&mut len)?;
            let len = u64::from_le_bytes(len);
            if len != offer.bytes || len > MAX_TERMINAL_STATE_RECORD_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "terminal-state record length does not match its offer",
                ));
            }
            let len = usize::try_from(len).map_err(io::Error::other)?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(len).map_err(io::Error::other)?;
            bytes.resize(len, 0);
            stream.read_exact(&mut bytes)?;
            Ok(Some(bytes))
        })
        .collect()
}

#[cfg(unix)]
pub(crate) fn send_fds_and_wait_restored(stream: &mut UnixStream, fds: &[RawFd]) -> io::Result<()> {
    send_fds(stream, fds)?;

    stream.set_read_timeout(Some(READY_TIMEOUT))?;
    let restored = read_line_unbuffered(&mut *stream)?;
    if restored.trim_end() != "restored" {
        return Err(io::Error::other(
            "handoff import did not report restored runtimes",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn wait_ready(stream: &mut UnixStream) -> io::Result<()> {
    stream.set_read_timeout(Some(READY_TIMEOUT))?;
    let ready = read_line_unbuffered(&mut *stream)?;
    if ready.trim_end() != "ready" {
        return Err(io::Error::other("handoff import did not report ready"));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn report_committed(stream: &mut UnixStream) -> io::Result<()> {
    stream.write_all(b"committed\n")?;
    stream.flush()
}

#[cfg(unix)]
pub(crate) fn wait_owned_ack(stream: &mut UnixStream) {
    if let Err(err) = stream.set_read_timeout(Some(OWNED_ACK_TIMEOUT)) {
        warn!(err = %err, "failed to set handoff ownership ack timeout");
        return;
    }
    match read_line_unbuffered(&mut *stream) {
        Ok(owned) if owned.trim_end() == "owned" => {}
        Ok(other) => {
            warn!(
                response = %other.trim_end(),
                "handoff import sent unexpected ownership ack after commit"
            );
        }
        Err(err) => {
            warn!(err = %err, "handoff import ownership ack was not received after commit");
        }
    }
}

#[cfg(unix)]
pub(crate) fn receive(socket_path: &Path, token: &str) -> io::Result<ReceivedHandoff> {
    let mut stream = UnixStream::connect(socket_path)?;
    stream.write_all(token.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let manifest_line = read_line_unbuffered(&mut stream)?;
    let manifest: HandoffManifest =
        serde_json::from_str(&manifest_line).map_err(io::Error::other)?;
    if manifest.version != HANDOFF_VERSION {
        return Err(io::Error::other(format!(
            "unsupported handoff version {}",
            manifest.version
        )));
    }
    if manifest
        .expected_protocol
        .is_some_and(|protocol| protocol != crate::protocol::PROTOCOL_VERSION)
    {
        return Err(io::Error::other(format!(
            "handoff expected protocol {}, but this server speaks protocol {}",
            manifest.expected_protocol.unwrap_or_default(),
            crate::protocol::PROTOCOL_VERSION
        )));
    }
    if manifest
        .expected_version
        .as_deref()
        .is_some_and(|version| version != crate::build_info::version())
    {
        return Err(io::Error::other(format!(
            "handoff expected herdr v{}, but this server is v{}",
            manifest.expected_version.as_deref().unwrap_or("unknown"),
            crate::build_info::version()
        )));
    }
    let codec = importer_terminal_state_codec();
    let accepted = match terminal_state_acceptance(&manifest, &codec) {
        Ok(accepted) => accepted,
        Err(reason) => {
            // Refuse before any descriptor moves; the exporter keeps ownership.
            let _ = writeln!(stream, "{IMPORT_REJECTED}{reason}");
            let _ = stream.flush();
            return Err(io::Error::other(format!(
                "lossless handoff refused: {reason}"
            )));
        }
    };
    let terminal_states = if accepted {
        writeln!(stream, "{TERMINAL_STATE_ACCEPTED}{codec}")?;
        stream.flush()?;
        receive_terminal_states(&mut stream, &manifest)?
    } else {
        stream.write_all(b"validated\n")?;
        stream.flush()?;
        vec![None; manifest.panes.len()]
    };
    let fds = recv_fds(&stream, manifest.panes.len())?;
    Ok(ReceivedHandoff {
        manifest,
        terminal_states,
        fds,
        stream,
    })
}

#[cfg(unix)]
pub(crate) fn report_restored(stream: &mut UnixStream) -> io::Result<()> {
    stream.write_all(b"restored\n")?;
    stream.flush()
}

#[cfg(unix)]
pub(crate) fn report_ready(stream: &mut UnixStream) -> io::Result<()> {
    stream.write_all(b"ready\n")?;
    stream.flush()
}

#[cfg(unix)]
pub(crate) fn wait_committed(stream: &mut UnixStream) -> io::Result<()> {
    stream.set_read_timeout(Some(READY_TIMEOUT))?;
    let committed = read_line_unbuffered(&mut *stream)?;
    if committed.trim_end() != "committed" {
        return Err(io::Error::other("handoff source did not commit"));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn report_owned(stream: &mut UnixStream) -> io::Result<()> {
    stream.write_all(b"owned\n")?;
    stream.flush()
}

#[cfg(unix)]
pub(crate) fn manifest_for(
    snapshot: crate::persist::SessionSnapshot,
    panes: Vec<crate::handoff_runtime::HandoffRuntimeState>,
    expected_protocol: Option<u32>,
    expected_version: Option<String>,
    api_window_title: Option<String>,
) -> HandoffManifest {
    HandoffManifest {
        version: HANDOFF_VERSION,
        source_version: crate::build_info::version(),
        source_protocol: crate::protocol::PROTOCOL_VERSION,
        expected_version,
        expected_protocol,
        snapshot,
        panes,
        api_window_title,
        require_lossless: false,
    }
}

#[cfg(unix)]
fn restrict_socket_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(unix)]
fn accept_with_timeout(
    listener: &UnixListener,
    timeout: Duration,
) -> io::Result<(UnixStream, std::os::unix::net::SocketAddr)> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok(accepted) => return Ok(accepted),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out waiting for handoff import connection",
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
}

#[cfg(unix)]
fn read_line_unbuffered(stream: &mut UnixStream) -> io::Result<String> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "handoff stream closed while reading line",
            ));
        }
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            return String::from_utf8(bytes)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err));
        }
        if bytes.len() > MAX_HANDOFF_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "handoff line exceeded maximum size",
            ));
        }
    }
}

#[cfg(unix)]
fn send_fds(stream: &UnixStream, fds: &[RawFd]) -> io::Result<()> {
    for batch in fds.chunks(FDS_PER_MESSAGE) {
        send_fd_batch(stream, batch)?;
    }
    Ok(())
}

#[cfg(unix)]
fn send_fd_batch(stream: &UnixStream, fds: &[RawFd]) -> io::Result<()> {
    if fds.is_empty() {
        return Ok(());
    }
    let byte = [b'F'];
    let iov = [libc::iovec {
        iov_base: byte.as_ptr() as *mut libc::c_void,
        iov_len: byte.len(),
    }];
    let fd_bytes = std::mem::size_of_val(fds);
    let mut control = vec![0u8; unsafe { libc::CMSG_SPACE(fd_bytes as u32) as usize }];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = iov.as_ptr() as *mut libc::iovec;
    msg.msg_iovlen = iov.len() as _;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = control.len() as _;

    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        if cmsg.is_null() {
            return Err(io::Error::other("failed to allocate fd control message"));
        }
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(fd_bytes as u32) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr() as *const u8, libc::CMSG_DATA(cmsg), fd_bytes);
        if libc::sendmsg(stream.as_raw_fd(), &msg, 0) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn close_raw_fds(fds: &[RawFd]) {
    for fd in fds {
        let _ = unsafe { libc::close(*fd) };
    }
}

#[cfg(unix)]
fn recv_fds(stream: &UnixStream, expected: usize) -> io::Result<Vec<RawFd>> {
    let mut out: Vec<RawFd> = Vec::with_capacity(expected);
    while out.len() < expected {
        let wanted = (expected - out.len()).min(FDS_PER_MESSAGE);
        let batch = match recv_fd_batch(stream, wanted) {
            Ok(batch) => batch,
            Err(err) => {
                close_raw_fds(&out);
                return Err(err);
            }
        };
        if batch.is_empty() {
            let received = out.len();
            close_raw_fds(&out);
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!(
                    "handoff stream closed after {received} of {expected} pane file descriptors"
                ),
            ));
        }
        out.extend(batch);
    }
    Ok(out)
}

#[cfg(unix)]
fn recv_fd_batch(stream: &UnixStream, wanted: usize) -> io::Result<Vec<RawFd>> {
    let mut byte = [0u8; 1];
    let mut iov = [libc::iovec {
        iov_base: byte.as_mut_ptr() as *mut libc::c_void,
        iov_len: byte.len(),
    }];
    let fd_bytes = wanted * std::mem::size_of::<RawFd>();
    let mut control = vec![0u8; unsafe { libc::CMSG_SPACE(fd_bytes as u32) as usize }];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = iov.as_mut_ptr();
    msg.msg_iovlen = iov.len() as _;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = control.len() as _;

    let read = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut msg, 0) };
    if read < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut out = Vec::new();
    unsafe {
        let control_end = control.as_ptr() as usize + msg.msg_controllen as usize;
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsg);
                // Bound the payload by both the header's own length and the
                // bytes the kernel wrote into `control`, so the read below can
                // never run past the buffer.
                let available = control_end.saturating_sub(data as usize);
                let data_len = ((*cmsg).cmsg_len as usize)
                    .saturating_sub(libc::CMSG_LEN(0) as usize)
                    .min(available);
                let count = data_len / std::mem::size_of::<RawFd>();
                let data = data as *const RawFd;
                for idx in 0..count {
                    out.push(*data.add(idx));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }

    // Truncation means the kernel closed the descriptors that did not fit, so
    // the batch is unrecoverable rather than merely short.
    if msg.msg_flags & libc::MSG_CTRUNC != 0 {
        close_raw_fds(&out);
        return Err(io::Error::other("handoff fd control message was truncated"));
    }
    if read == 0 {
        close_raw_fds(&out);
        return Ok(Vec::new());
    }
    if out.len() > wanted {
        let received = out.len();
        close_raw_fds(&out);
        return Err(io::Error::other(format!(
            "handoff fd message carried {received} descriptors, expected at most {wanted}"
        )));
    }
    if out.is_empty() {
        return Err(io::Error::other("handoff fd message missing SCM_RIGHTS"));
    }
    Ok(out)
}

#[cfg(unix)]
pub(crate) fn log_import_result(panes: usize) {
    info!(panes, "handoff import ready");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn empty_snapshot() -> crate::persist::SessionSnapshot {
        crate::persist::SessionSnapshot {
            version: 0,
            workspaces: Vec::new(),
            active: None,
            selected: 0,
            sidebar_width: None,
            sidebar_section_split: None,
            collapsed_space_keys: Default::default(),
        }
    }

    #[test]
    fn manifest_budget_counts_encoded_bytes_and_rejects_without_truncation() {
        let mut manifest = manifest_for(
            empty_snapshot(),
            Vec::new(),
            None,
            None,
            Some(String::new()),
        );
        let overhead = serde_json::to_vec(&manifest).unwrap().len();
        manifest.api_window_title = Some("x".repeat(MAX_HANDOFF_LINE_BYTES - overhead));
        assert!(validate_manifest_size(&manifest).is_ok());
        manifest.api_window_title.as_mut().unwrap().push('x');
        assert!(validate_manifest_size(&manifest).is_err());
        // JSON escapes consume budget too, even when the source string fits.
        manifest.api_window_title = Some("\n".repeat(MAX_HANDOFF_LINE_BYTES / 2));
        assert!(validate_manifest_size(&manifest).is_err());
        assert_eq!(
            manifest.api_window_title.as_ref().unwrap().len(),
            MAX_HANDOFF_LINE_BYTES / 2
        );
    }

    #[test]
    fn a_handoff_carries_an_api_set_window_title() {
        let manifest = manifest_for(
            empty_snapshot(),
            Vec::new(),
            None,
            None,
            Some("deploying".to_string()),
        );

        assert_eq!(manifest.api_window_title.as_deref(), Some("deploying"));
    }

    #[test]
    fn a_manifest_written_before_the_title_field_still_loads() {
        let manifest = manifest_for(
            empty_snapshot(),
            Vec::new(),
            None,
            None,
            Some("deploying".to_string()),
        );
        let mut value = serde_json::to_value(&manifest).expect("manifest should serialize");
        value
            .as_object_mut()
            .expect("manifest should be a json object")
            .remove("api_window_title");

        let older: HandoffManifest =
            serde_json::from_value(value).expect("an older manifest should still load");

        assert!(older.api_window_title.is_none());
    }

    fn pane(offer: Option<(&str, bool)>) -> crate::handoff_runtime::HandoffRuntimeState {
        serde_json::from_value::<crate::handoff_runtime::HandoffRuntimeState>(serde_json::json!({
            "pane_id": 1, "child_pid": 2, "rows": 24, "cols": 80,
            "cell_width_px": 0, "cell_height_px": 0,
        }))
        .map(|mut state| {
            state.terminal_state = offer.map(|(codec, graphics_dropped)| {
                crate::handoff_runtime::HandoffTerminalStateOffer {
                    codec: codec.into(),
                    bytes: 4,
                    graphics_dropped,
                }
            });
            state
        })
        .unwrap()
    }

    fn manifest(
        panes: Vec<crate::handoff_runtime::HandoffRuntimeState>,
        lossless: bool,
    ) -> HandoffManifest {
        let mut manifest = manifest_for(empty_snapshot(), panes, None, None, None);
        manifest.require_lossless = lossless;
        manifest
    }

    #[test]
    fn importers_accept_exact_state_only_for_their_codec() {
        let accept =
            |panes, lossless| terminal_state_acceptance(&manifest(panes, lossless), "ours");
        assert_eq!(accept(vec![pane(None)], false), Ok(false));
        assert_eq!(
            accept(vec![pane(Some(("ours", false))), pane(None)], false),
            Ok(true)
        );
        assert_eq!(
            accept(vec![pane(Some(("theirs", false)))], false),
            Ok(false)
        );
        assert_eq!(accept(vec![pane(Some(("ours", true)))], false), Ok(true));
        assert_eq!(accept(Vec::new(), true), Ok(true));
        assert_eq!(accept(vec![pane(Some(("ours", false)))], true), Ok(true));
        for panes in [
            vec![pane(Some(("theirs", false)))],
            vec![pane(Some(("ours", false))), pane(None)],
            vec![pane(Some(("ours", true)))],
        ] {
            assert!(accept(panes, true).is_err());
        }
    }

    #[test]
    fn manifests_without_terminal_state_fields_still_load_and_omit_them() {
        let value = serde_json::to_value(manifest(vec![pane(None)], false)).unwrap();
        assert!(value.get("require_lossless").is_none());
        assert!(value["panes"][0].get("terminal_state").is_none());
        let older: HandoffManifest = serde_json::from_value(value).unwrap();
        assert!(!older.require_lossless);
        assert!(older.panes[0].terminal_state.is_none());
        let offered =
            serde_json::to_value(manifest(vec![pane(Some(("ours", false)))], true)).unwrap();
        assert_eq!(offered["require_lossless"], true);
        assert_eq!(offered["panes"][0]["terminal_state"]["codec"], "ours");
    }

    #[test]
    fn terminal_state_records_stream_in_pane_order_and_reject_mismatched_offers() {
        let (mut exporter, mut importer) = UnixStream::pair().unwrap();
        let mut offered = manifest(
            vec![
                pane(Some(("ours", false))),
                pane(None),
                pane(Some(("ours", false))),
            ],
            false,
        );
        send_terminal_states(
            &mut exporter,
            &offered,
            &[Some(b"abcd".to_vec()), None, Some(b"wxyz".to_vec())],
        )
        .unwrap();
        assert_eq!(
            receive_terminal_states(&mut importer, &offered).unwrap(),
            vec![Some(b"abcd".to_vec()), None, Some(b"wxyz".to_vec())]
        );
        assert!(send_terminal_states(
            &mut exporter,
            &offered,
            &[Some(b"abc".to_vec()), None, None]
        )
        .is_err());
        assert!(send_terminal_states(&mut exporter, &offered, &[None]).is_err());
        // A record whose length disagrees with its offer is rejected by the importer.
        offered.panes.truncate(1);
        exporter.write_all(&5u64.to_le_bytes()).unwrap();
        exporter.write_all(b"abcde").unwrap();
        assert!(receive_terminal_states(&mut importer, &offered).is_err());
    }
}
