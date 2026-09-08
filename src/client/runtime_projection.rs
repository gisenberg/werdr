//! Read-only endpoint metadata projection with explicit passive attachment guarantees.
//! This client never activates a surface or sends pane input.
use std::io::{self, Read as _, Write as _};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use interprocess::local_socket::traits::Stream as _;
use serde::Serialize;

use crate::protocol::endpoint::{ENDPOINT_SNAPSHOT_KIND, PASSIVE_METADATA_CAPABILITY};
use crate::protocol::{self, ClientShellSnapshot, ClientSurfaceSize, ServerMessage};
use crate::server::socket_paths::{client_socket_path, derive_client_socket_from_api_socket};

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Projection {
    boot_id: String,
    agent_view_label: Option<String>,
    agent_order: Vec<String>,
    tabs: Vec<Tab>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Tab {
    tab_id: String,
    workspace_id: String,
    custom_label: bool,
}

impl From<ClientShellSnapshot> for Projection {
    fn from(snapshot: ClientShellSnapshot) -> Self {
        Self {
            boot_id: snapshot.boot_id,
            agent_view_label: snapshot.agent_view_label,
            agent_order: snapshot.agent_order,
            tabs: snapshot
                .tabs
                .into_iter()
                .map(|tab| Tab {
                    tab_id: tab.tab_id,
                    workspace_id: tab.workspace_id,
                    custom_label: tab.custom_label,
                })
                .collect(),
        }
    }
}

fn validate_target(api: &Path, client: &Path, surface_interest: bool) -> io::Result<()> {
    if client != derive_client_socket_from_api_socket(api) {
        return Err(io::Error::other(
            "API and client sockets select different runtimes",
        ));
    }
    if !surface_interest {
        return Err(io::Error::other(
            "runtime does not advertise passive surface support",
        ));
    }
    Ok(())
}

/// Print a bounded JSON projection, or stream replacements until stdin closes.
pub fn run_runtime_projection(watch: bool) -> io::Result<()> {
    let api_path = crate::api::socket_path();
    let client_path = client_socket_path();
    // Reject ambiguous overrides before contacting either runtime.
    validate_target(&api_path, &client_path, true)?;
    let status = crate::api::read_runtime_status_at(&api_path, Duration::from_secs(5))?;
    let passive = status
        .and_then(|status| status.capabilities)
        .is_some_and(|capabilities| capabilities.passive_metadata);
    validate_target(&api_path, &client_path, passive)?;
    let mut stream = crate::ipc::connect_local_stream(&client_path)?;
    let handshake = super::do_handshake(
        &mut stream,
        80,
        24,
        0,
        0,
        false,
        Some(ClientSurfaceSize { cols: 80, rows: 24 }),
        false,
        false,
        false,
    )
    .map_err(io::Error::other)?;
    if !handshake
        .endpoint_capabilities
        .as_ref()
        .is_some_and(|capabilities| {
            capabilities
                .iter()
                .any(|capability| capability == PASSIVE_METADATA_CAPABILITY)
        })
    {
        return Err(io::Error::other(
            "endpoint does not advertise passive surface support",
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if watch {
        let cancelled = cancelled.clone();
        std::thread::spawn(move || {
            let _ = io::stdin().read(&mut [0_u8]);
            cancelled.store(true, Ordering::Release);
        });
    }
    stream.set_nonblocking(true)?;
    let mut reader = ProjectionReader {
        stream,
        cancelled: cancelled.clone(),
        deadline: Some(Instant::now() + Duration::from_secs(5)),
    };
    let mut previous = None;
    let mut last_revision = None;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        match protocol::read_message(&mut reader, protocol::MAX_FRAME_SIZE) {
            Ok(ServerMessage::EndpointControl { kind, data }) if kind == ENDPOINT_SNAPSHOT_KIND => {
                let snapshot: ClientShellSnapshot = serde_json::from_str(&data)?;
                reader.deadline = None;
                if let Some((boot_id, revision)) = &last_revision {
                    if boot_id != &snapshot.boot_id {
                        return Err(io::Error::other(
                            "runtime identity changed during observation",
                        ));
                    }
                    if snapshot.revision <= *revision {
                        continue;
                    }
                }
                last_revision = Some((snapshot.boot_id.clone(), snapshot.revision));
                let revision = snapshot.revision;
                let projection = Projection::from(snapshot);
                if previous.as_ref() != Some(&projection) {
                    serde_json::to_writer(
                        &mut output,
                        &serde_json::json!({
                            "type": "runtime.projection", "revision": revision, "projection": projection,
                        }),
                    )?;
                    output.write_all(b"\n")?;
                    output.flush()?;
                    previous = Some(projection);
                }
                if !watch {
                    return Ok(());
                }
            }
            Ok(ServerMessage::EndpointControl { kind, .. })
                if kind.starts_with("shell.snapshot.") =>
            {
                return Err(io::Error::other(format!(
                    "unsupported projection codec {kind}"
                )));
            }
            Ok(ServerMessage::ServerShutdown { .. })
            | Err(protocol::FramingError::UnexpectedEof) => {
                return if previous.is_some() {
                    Ok(())
                } else {
                    Err(io::Error::other(
                        "runtime closed before providing a projection",
                    ))
                };
            }
            Ok(_) => {}
            Err(_) if cancelled.load(Ordering::Acquire) => return Ok(()),
            Err(error) => return Err(io::Error::other(error.to_string())),
        }
    }
}

struct ProjectionReader {
    stream: crate::ipc::LocalStream,
    cancelled: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl io::Read for ProjectionReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "observation cancelled",
                ));
            }
            if self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "projection deadline exceeded",
                ));
            }
            match crate::ipc::poll_local_stream_read_count(&mut self.stream, buffer)? {
                crate::ipc::LocalStreamReadCount::Data(count) => return Ok(count),
                crate::ipc::LocalStreamReadCount::Closed => return Ok(0),
                crate::ipc::LocalStreamReadCount::Pending => {
                    std::thread::sleep(Duration::from_millis(10))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_read_deadline_and_cancellation_do_not_require_peer_cooperation() {
        use interprocess::local_socket::traits::Listener as _;
        let path = std::env::temp_dir().join(format!(
            "projection-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let listener = crate::ipc::bind_local_listener(&path).unwrap();
        let peer = std::thread::spawn(move || listener.accept().unwrap());
        let stream = crate::ipc::connect_local_stream(&path).unwrap();
        let _peer = peer.join().unwrap();
        stream.set_nonblocking(true).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut reader = ProjectionReader {
            stream,
            cancelled: cancelled.clone(),
            deadline: Some(Instant::now()),
        };
        assert_eq!(
            reader.read(&mut [0_u8; 4]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        reader.deadline = None;
        cancelled.store(true, Ordering::Release);
        assert_eq!(
            reader.read(&mut [0_u8; 4]).unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        drop(reader);
        drop(_peer);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn projection_requires_matching_sockets_and_explicit_passive_support() {
        let api = Path::new("/sessions/one/api.sock");
        let client = derive_client_socket_from_api_socket(api);
        assert!(validate_target(api, &client, true).is_ok());
        assert!(validate_target(api, &client, false).is_err());
        assert!(validate_target(api, Path::new("/sessions/two/client.sock"), true).is_err());
    }

    #[test]
    fn projection_preserves_native_order_and_omits_unrelated_endpoint_settings() {
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        snapshot.agent_order = vec!["pane:second".into(), "pane:first".into()];
        snapshot.agent_view_label = Some("Review".into());
        let projection = Projection::from(snapshot.clone());
        let value = serde_json::to_value(&projection).unwrap();
        assert_eq!(
            value["agent_order"],
            serde_json::json!(["pane:second", "pane:first"])
        );
        assert_eq!(value["agent_view_label"], "Review");
        assert!(value.get("server_keybindings_toml").is_none());
        assert!(value.get("worktree_directory").is_none());
        snapshot.revision += 1;
        snapshot.config_diagnostic = Some("unrelated".into());
        assert_eq!(projection, Projection::from(snapshot));
    }
}
