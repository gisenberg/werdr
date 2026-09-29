use super::*;
use crate::terminal::{TerminalId, TerminalRuntime};
use std::io::Read;

fn fixture() -> (HeadlessServer, TerminalId, crate::layout::PaneId) {
    let mut server = test_headless_server();
    let workspace = crate::workspace::Workspace::test_new("handoff-topology");
    let pane_id = workspace.tabs[0].root_pane;
    let terminal_id = workspace.terminal_id(pane_id).unwrap().clone();
    server.app.state.workspaces = vec![workspace];
    server.app.state.ensure_test_terminals();
    server.app.state.active = Some(0);
    server.app.state.selected = 0;
    (server, terminal_id, pane_id)
}

#[tokio::test]
async fn legacy_handoff_rejects_detached_actor_before_disconnecting_or_pausing() {
    let (mut server, terminal_id, pane_id) = fixture();
    let (writer, control, _render) = test_client_writer();
    server.handle_server_event(ServerEvent::ClientShellConnected {
        surface_reuse: false,
        surface_delta: false,
        surface_scroll: false,
        client_id: 6,
        surface_cols: 80,
        surface_rows: 23,
        cell_width_px: 0,
        cell_height_px: 0,
        pixel_mouse: false,
        direct_graphics: false,
        endpoint_keybindings: false,
        mouse_capture: false,
        surface_active: true,
        writer,
    });
    while control.try_recv().is_ok() {}
    let (runtime, actor, mut peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    let identity = runtime.capture_identity();
    let detached_id = TerminalId::alloc();
    server
        .app
        .terminal_runtimes
        .insert(detached_id.clone(), runtime);
    let socket_identity = socket_file_identity(&server.client_socket_path).unwrap();
    let params = api::schema::ServerLiveHandoffParams {
        import_exe: Some("/nonexistent/handoff-importer-must-not-run".into()),
        ..Default::default()
    };
    let error = server.perform_live_handoff(params).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    assert!(error.to_string().contains("detached terminal runtime"));
    assert!(!server.handoff_in_progress);
    assert!(!server.shutting_down);
    assert!(server.clients.contains_key(&6));
    assert!(control.try_recv().is_err());
    assert_eq!(
        socket_file_identity(&server.client_socket_path).unwrap(),
        socket_identity
    );
    assert!(server
        .app
        .terminal_runtimes
        .get(&detached_id)
        .unwrap()
        .matches_capture_identity(&identity));
    actor
        .try_write_user_input(bytes::Bytes::from_static(b"still-owned"))
        .unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut received = [0; 11];
    peer.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"still-owned");
    // Reattach this exact actor. Its original producer pane is not the export
    // identity: the current owner attachment determines that identity.
    let runtime = server.app.terminal_runtimes.remove(&detached_id).unwrap();
    server
        .app
        .terminal_runtimes
        .insert(terminal_id.clone(), runtime);
    assert_eq!(
        server.legacy_handoff_topology().unwrap()[&terminal_id],
        pane_id.raw()
    );
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn legacy_handoff_topology_accepts_empty_and_ordinary_state() {
    assert!(test_headless_server()
        .legacy_handoff_topology()
        .unwrap()
        .is_empty());
    let (mut server, terminal_id, pane_id) = fixture();
    server.app.terminal_runtimes.insert(
        terminal_id.clone(),
        TerminalRuntime::test_for_draft_capture(b"kept"),
    );
    assert_eq!(
        server.legacy_handoff_topology().unwrap(),
        HashMap::from([(terminal_id, pane_id.raw())])
    );
    // Metadata without a process is not a live runtime that commit would drop.
    let metadata_id = TerminalId::alloc();
    server.app.state.terminals.insert(
        metadata_id.clone(),
        crate::terminal::TerminalState::new(metadata_id, std::env::temp_dir()),
    );
    assert!(server.legacy_handoff_topology().is_ok());
}

#[tokio::test]
async fn legacy_handoff_topology_rejects_popup_without_removing_it() {
    let (mut server, underlying_id, _) = fixture();
    let terminal_id = TerminalId::alloc();
    let pane_id = crate::layout::PaneId::alloc();
    for id in [&underlying_id, &terminal_id] {
        server
            .app
            .terminal_runtimes
            .insert(id.clone(), TerminalRuntime::test_for_draft_capture(b"kept"));
    }
    server.app.state.popup_pane = Some(crate::app::state::PopupPaneState {
        owner_tab_id: server.app.public_tab_id(0, 0).unwrap(),
        pane_id,
        terminal_id,
        width: None,
        height: None,
    });
    let before = server.app.state.popup_pane.clone();
    let error = server.perform_live_handoff(Default::default()).unwrap_err();
    assert!(error.to_string().contains("popup ownership"));
    assert_eq!(server.app.state.popup_pane, before);
    assert_eq!(server.app.terminal_runtimes.len(), 2);
    assert_eq!(server.app.state.workspaces[0].tabs[0].panes.len(), 1);
    assert!(!server.handoff_in_progress);
}

#[test]
fn legacy_handoff_topology_rejects_aliased_terminals_and_duplicate_panes() {
    let (mut server, terminal_id, _) = fixture();
    let mut second = crate::workspace::Workspace::test_new("second");
    second.tabs[0]
        .panes
        .values_mut()
        .next()
        .unwrap()
        .attached_terminal_id = terminal_id;
    server.app.state.workspaces.push(second);
    assert!(server
        .legacy_handoff_topology()
        .unwrap_err()
        .to_string()
        .contains("multiple attachments"));
    server.app.state.workspaces.pop();
    let mut duplicate = crate::workspace::Workspace::test_new("duplicate");
    let duplicated_id = server.app.state.workspaces[0].tabs[0].root_pane;
    duplicate.tabs[0].layout = crate::layout::TileLayout::from_saved(
        crate::layout::Node::Pane(duplicated_id),
        duplicated_id,
    );
    server.app.state.workspaces.push(duplicate);
    assert!(server
        .legacy_handoff_topology()
        .unwrap_err()
        .to_string()
        .contains("duplicate pane identities"));
}

#[test]
fn legacy_handoff_topology_rejects_missing_layout_records_and_metadata() {
    let (mut server, terminal_id, pane_id) = fixture();
    let pane = server.app.state.workspaces[0].tabs[0]
        .panes
        .remove(&pane_id)
        .unwrap();
    assert!(server
        .legacy_handoff_topology()
        .unwrap_err()
        .to_string()
        .contains("layout/pane-map mismatch"));
    let other_id = crate::layout::PaneId::alloc();
    server.app.state.workspaces[0].tabs[0]
        .panes
        .insert(other_id, pane);
    assert!(server
        .legacy_handoff_topology()
        .unwrap_err()
        .to_string()
        .contains("layout leaf without a pane"));
    let pane = server.app.state.workspaces[0].tabs[0]
        .panes
        .remove(&other_id)
        .unwrap();
    server.app.state.workspaces[0].tabs[0]
        .panes
        .insert(pane_id, pane);
    server.app.state.terminals.remove(&terminal_id);
    assert!(server
        .legacy_handoff_topology()
        .unwrap_err()
        .to_string()
        .contains("without terminal metadata"));
}
