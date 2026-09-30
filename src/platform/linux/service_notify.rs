//! systemd service notification protocol (`sd_notify(3)`), without libsystemd.
//!
//! A supervised runtime reports readiness after binding its sockets. A live
//! handoff importer claims the service's main process before the exporter exits,
//! and waits on a barrier so systemd has processed that claim first; otherwise
//! the exporter's exit could stop the service and its whole control group.

use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{SocketAddr, UnixDatagram};
use std::time::{Duration, Instant};

pub(crate) const NOTIFY_SOCKET_ENV_VAR: &str = "NOTIFY_SOCKET";

fn socket_address(socket: &OsStr) -> io::Result<SocketAddr> {
    let bytes = socket.as_bytes();
    match bytes.first() {
        Some(b'/') => SocketAddr::from_pathname(socket),
        // A leading '@' names a socket in the abstract namespace.
        Some(b'@') => SocketAddr::from_abstract_name(&bytes[1..]),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NOTIFY_SOCKET is neither an absolute path nor an abstract socket",
        )),
    }
}

/// Send one state datagram, optionally carrying one descriptor.
fn send(socket: &OsStr, state: &str, fd: Option<&OwnedFd>) -> io::Result<()> {
    let address = socket_address(socket)?;
    let sender = UnixDatagram::unbound()?;
    let Some(fd) = fd else {
        let written = sender.send_to_addr(state.as_bytes(), &address)?;
        return if written == state.len() {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "short notify datagram",
            ))
        };
    };
    // Rust's standard library cannot attach SCM_RIGHTS to an addressed datagram.
    sender.connect_addr(&address)?;
    let mut iov = libc::iovec {
        iov_base: state.as_ptr() as *mut libc::c_void,
        iov_len: state.len(),
    };
    let raw = fd.as_raw_fd();
    // SAFETY: CMSG_SPACE is a pure size computation for one descriptor.
    let space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<libc::c_int>() as u32) } as usize;
    let mut control = vec![0u8; space];
    // SAFETY: zeroed msghdr is a valid initial value; every pointer below
    // references a live local buffer for the duration of sendmsg.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = space as _;
    // SAFETY: the control buffer has room for exactly one header and descriptor.
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null() {
            return Err(io::Error::other("missing notify control header"));
        }
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<libc::c_int>() as u32) as _;
        std::ptr::copy_nonoverlapping(
            (&raw as *const libc::c_int).cast::<u8>(),
            libc::CMSG_DATA(header),
            std::mem::size_of::<libc::c_int>(),
        );
    }
    // SAFETY: the socket and message buffers are valid for this call.
    let written = unsafe { libc::sendmsg(sender.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    if written as usize != state.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "short notify datagram",
        ));
    }
    Ok(())
}

pub(crate) fn notify(socket: &OsStr, state: &str) -> io::Result<()> {
    send(socket, state, None)
}

/// Wait until the service manager has processed every earlier notification.
///
/// systemd closes the passed pipe end after handling all messages received
/// before it, so hang-up on the read end proves ordering (`sd_notify_barrier`).
pub(crate) fn barrier(socket: &OsStr, timeout: Duration) -> io::Result<()> {
    let mut fds = [0; 2];
    // SAFETY: fds is a valid two-element output array.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: pipe2 returned two new descriptors owned by this function.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    send(socket, "BARRIER=1", Some(&write))?;
    drop(write);
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "service manager did not acknowledge the notify barrier",
            ));
        }
        let mut poll = libc::pollfd {
            fd: read.as_raw_fd(),
            events: 0,
            revents: 0,
        };
        let millis = remaining.as_millis().min(libc::c_int::MAX as u128) as libc::c_int;
        // SAFETY: poll receives one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, millis) };
        if ready < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if poll.revents & (libc::POLLHUP | libc::POLLERR) != 0 {
            return Ok(());
        }
    }
}

/// Remove the notify socket from this process environment.
///
/// Call before spawning threads or children so pane shells never inherit the
/// ability to report service state. The value is passed explicitly to a
/// handoff importer instead.
pub(crate) fn take_notify_socket() -> Option<OsString> {
    let value = std::env::var_os(NOTIFY_SOCKET_ENV_VAR)?;
    std::env::remove_var(NOTIFY_SOCKET_ENV_VAR);
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::RawFd;

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn listener() -> (TempDir, UnixDatagram, OsString) {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("herdr-notify-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("temp dir");
        let path = directory.join("notify.sock");
        let socket = UnixDatagram::bind(&path).expect("bind notify socket");
        (TempDir(directory), socket, path.into_os_string())
    }

    /// Receive one datagram and any single SCM_RIGHTS descriptor.
    fn receive(socket: &UnixDatagram) -> (String, Option<OwnedFd>) {
        let mut data = [0u8; 256];
        let mut iov = libc::iovec {
            iov_base: data.as_mut_ptr().cast(),
            iov_len: data.len(),
        };
        let space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as usize;
        let mut control = vec![0u8; space];
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = space as _;
        let read = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, 0) };
        assert!(read >= 0, "recvmsg failed: {}", io::Error::last_os_error());
        let text = String::from_utf8(data[..read as usize].to_vec()).expect("utf-8 state");
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        let fd = (!header.is_null()).then(|| unsafe {
            let mut raw: RawFd = -1;
            std::ptr::copy_nonoverlapping(
                libc::CMSG_DATA(header),
                (&mut raw as *mut RawFd).cast::<u8>(),
                std::mem::size_of::<RawFd>(),
            );
            OwnedFd::from_raw_fd(raw)
        });
        (text, fd)
    }

    #[test]
    fn notify_sends_state_to_a_path_socket() {
        let (_directory, socket, path) = listener();
        notify(&path, "READY=1\nMAINPID=42").expect("notify");
        assert_eq!(receive(&socket).0, "READY=1\nMAINPID=42");
    }

    #[test]
    fn notify_supports_abstract_sockets() {
        let name = format!("herdr-notify-test-{}", std::process::id());
        let address = SocketAddr::from_abstract_name(name.as_bytes()).expect("abstract name");
        let socket = UnixDatagram::bind_addr(&address).expect("bind abstract socket");
        notify(OsStr::new(&format!("@{name}")), "READY=1").expect("notify");
        assert_eq!(receive(&socket).0, "READY=1");
    }

    #[test]
    fn barrier_waits_until_the_manager_closes_its_descriptor() {
        let (_directory, socket, path) = listener();
        let manager = std::thread::spawn(move || {
            let (state, fd) = receive(&socket);
            assert_eq!(state, "BARRIER=1");
            std::thread::sleep(Duration::from_millis(100));
            drop(fd.expect("barrier descriptor"));
        });
        let started = Instant::now();
        barrier(&path, Duration::from_secs(5)).expect("barrier");
        assert!(started.elapsed() >= Duration::from_millis(100));
        manager.join().expect("manager thread");
    }

    #[test]
    fn barrier_times_out_when_the_manager_retains_its_descriptor() {
        let (_directory, socket, path) = listener();
        let held = std::thread::spawn(move || {
            let (_, fd) = receive(&socket);
            std::thread::sleep(Duration::from_millis(400));
            drop(fd);
        });
        let err = barrier(&path, Duration::from_millis(100)).expect_err("timeout");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        held.join().expect("manager thread");
    }

    #[test]
    fn invalid_notify_socket_values_are_rejected() {
        assert_eq!(
            notify(OsStr::new("relative.sock"), "READY=1")
                .expect_err("relative")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
