use super::*;
use crate::{pane::ExitRecord, platform::ChildExitReason, terminal::TerminalRuntime};

fn fixture() -> (
    HeadlessServer,
    crate::layout::PaneId,
    crate::terminal::TerminalId,
    ExitRecord,
) {
    let mut server = test_headless_server();
    let workspace = crate::workspace::Workspace::test_new("exit-identity");
    let pane = workspace.tabs[0].root_pane;
    let terminal = workspace.terminal_id(pane).unwrap().clone();
    server.app.state.workspaces = vec![workspace];
    server.app.state.ensure_test_terminals();
    server.app.state.active = Some(0);
    let (runtime, _) = TerminalRuntime::test_with_channel(40, 5);
    let record = runtime.exit_record();
    server
        .app
        .terminal_runtimes
        .insert(terminal.clone(), runtime);
    (server, pane, terminal, record)
}

#[tokio::test]
async fn detached_exit_closes_only_exact_terminal_attach_and_observe_streams() {
    let (mut server, pane, old_terminal, record) = fixture();
    let mut controls = Vec::new();
    for client_id in [7, 8, 9] {
        let (writer, control, _) = test_client_writer();
        server.handle_server_event(ServerEvent::ClientConnected {
            client_id,
            cols: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            pixel_mouse: false,
            writer,
        });
        controls.push(control);
    }
    server.handle_server_event(ServerEvent::ClientAttachTerminal {
        client_id: 7,
        terminal_id: old_terminal.to_string(),
        takeover: false,
    });
    server.handle_server_event(ServerEvent::ClientObserveTerminal {
        client_id: 8,
        target: old_terminal.to_string(),
    });
    let replacement_id = crate::terminal::TerminalId::alloc();
    let (replacement, _) = TerminalRuntime::test_with_channel(40, 5);
    let replacement_record = replacement.exit_record();
    server.app.state.terminals.insert(
        replacement_id.clone(),
        crate::terminal::TerminalState::new(replacement_id.clone(), std::env::temp_dir()),
    );
    server
        .app
        .terminal_runtimes
        .insert(replacement_id.clone(), replacement);
    server.app.state.workspaces[0].tabs[0]
        .panes
        .get_mut(&pane)
        .unwrap()
        .attached_terminal_id = replacement_id.clone();
    server.handle_server_event(ServerEvent::ClientAttachTerminal {
        client_id: 9,
        terminal_id: replacement_id.to_string(),
        takeover: false,
    });
    server
        .app
        .state
        .terminals
        .get_mut(&replacement_id)
        .unwrap()
        .set_detected_state(
            Some(crate::detect::Agent::Codex),
            crate::detect::AgentState::Working,
        );
    let before = server.app.event_hub.events_after(0).len();
    let focus = server.app.state.workspaces[0].tabs[0].layout.focused();
    record.test_record(ChildExitReason::Exited);
    assert!(
        server.handle_internal_event_with_forwarding(AppEvent::RuntimeExited {
            pane_id: pane,
            record: record.clone()
        })
    );
    for client_id in [7, 8] {
        assert!(!server.clients.contains_key(&client_id));
    }
    assert!(server.clients.contains_key(&9));
    for control in &controls[..2] {
        assert_eq!(
            read_server_shutdown_reason(control.recv_timeout(Duration::from_secs(2)).unwrap()),
            Some(format!("terminal {old_terminal} exited"))
        );
    }
    assert!(server.app.terminal_runtimes.get(&old_terminal).is_none());
    assert!(!server.app.state.terminals.contains_key(&old_terminal));
    assert!(!server
        .app
        .state
        .direct_attach_resize_locks
        .contains(&old_terminal));
    assert!(server
        .app
        .state
        .direct_attach_resize_locks
        .contains(&replacement_id));
    assert!(server
        .app
        .terminal_runtimes
        .get(&replacement_id)
        .unwrap()
        .exit_record()
        .same_runtime(&replacement_record));
    assert_eq!(
        server.app.state.terminals[&replacement_id].state,
        crate::detect::AgentState::Working
    );
    assert_eq!(
        server.app.state.workspaces[0].tabs[0].layout.focused(),
        focus
    );
    assert_eq!(server.app.event_hub.events_after(0).len(), before);
    assert!(
        !server.handle_internal_event_with_forwarding(AppEvent::RuntimeExited {
            pane_id: pane,
            record
        })
    );
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_queued_stale_identity_has_no_headless_effects() {
    let (mut server, pane, terminal, record) = fixture();
    record.test_record(ChildExitReason::Interrupted);
    server
        .app
        .event_tx
        .try_send(AppEvent::RuntimeExited {
            pane_id: pane,
            record: record.clone(),
        })
        .unwrap();
    let (replacement, _) = TerminalRuntime::test_with_channel(40, 5);
    let current = replacement.exit_record();
    server
        .app
        .terminal_runtimes
        .insert(terminal.clone(), replacement);
    server
        .app
        .state
        .terminals
        .get_mut(&terminal)
        .unwrap()
        .set_detected_state(
            Some(crate::detect::Agent::Codex),
            crate::detect::AgentState::Working,
        );
    let (writer, _control_rx, _) = test_client_writer();
    server.handle_server_event(ServerEvent::ClientConnected {
        client_id: 7,
        cols: 80,
        rows: 24,
        cell_width_px: 0,
        cell_height_px: 0,
        pixel_mouse: false,
        writer,
    });
    server.handle_server_event(ServerEvent::ClientAttachTerminal {
        client_id: 7,
        terminal_id: terminal.to_string(),
        takeover: false,
    });
    let events_before = server.app.event_hub.events_after(0).len();
    let event = server.app.event_rx.recv().await.unwrap();
    assert!(!server.handle_internal_event_with_forwarding(event));
    assert!(server.clients.contains_key(&7));
    assert_eq!(server.app.event_hub.events_after(0).len(), events_before);
    assert_eq!(
        server.app.state.terminals[&terminal].state,
        crate::detect::AgentState::Working
    );
    assert!(server.app.find_pane(pane).is_some());
    assert!(server
        .app
        .terminal_runtimes
        .get(&terminal)
        .unwrap()
        .exit_record()
        .same_runtime(&current));
    assert!(!record.is_claimed());
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_headless_timeout_rebound_without_runtime_has_no_exit_effects() {
    let (mut server, pane, current_terminal, _) = fixture();
    server.app.terminal_runtimes.remove(&current_terminal);
    let old_terminal = crate::terminal::TerminalId::alloc();
    let old = ExitRecord::test_recorded(ChildExitReason::Exited);
    server
        .app
        .pending_worktree_remove_runtime_exits
        .insert(pane, vec![(old_terminal.clone(), old.clone())]);
    server.app.pending_worktree_remove_runtime_restores.insert(
        pane,
        crate::app::runtime_exit::WorktreeRestoreRequest::new(7, old_terminal),
    );
    let before = server.app.event_hub.events_after(0).len();
    server.handle_internal_event_with_forwarding(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        request: server.app.pending_worktree_remove_runtime_restores[&pane].clone(),
    });
    assert!(server.app.find_pane(pane).is_some());
    assert_eq!(server.app.event_hub.events_after(0).len(), before);
    assert!(server.app.pending_worktree_remove_runtime_exits.is_empty());
    assert!(
        !server.handle_internal_event_with_forwarding(AppEvent::RuntimeExited {
            pane_id: pane,
            record: old.clone()
        })
    );
    assert!(!old.is_claimed());
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_current_closes_stream_and_emits_exit_once() {
    let (mut server, pane, terminal, record) = fixture();
    let (writer, control_rx, _) = test_client_writer();
    server.handle_server_event(ServerEvent::ClientConnected {
        client_id: 7,
        cols: 80,
        rows: 24,
        cell_width_px: 0,
        cell_height_px: 0,
        pixel_mouse: false,
        writer,
    });
    server.handle_server_event(ServerEvent::ClientAttachTerminal {
        client_id: 7,
        terminal_id: terminal.to_string(),
        takeover: false,
    });
    record.test_record(ChildExitReason::Exited);
    let event = || AppEvent::RuntimeExited {
        pane_id: pane,
        record: record.clone(),
    };
    assert!(server.handle_internal_event_with_forwarding(event()));
    assert!(!server.clients.contains_key(&7));
    assert_eq!(
        read_server_shutdown_reason(control_rx.recv().unwrap()),
        Some(format!("terminal {terminal} exited"))
    );
    let before = server.app.event_hub.events_after(0);
    assert_eq!(
        before
            .iter()
            .filter(|(_, event)| event.event == crate::api::schema::EventKind::PaneExited)
            .count(),
        1
    );
    assert!(!server.handle_internal_event_with_forwarding(event()));
    assert_eq!(server.app.event_hub.events_after(0).len(), before.len());
    assert!(record.is_claimed());
    server.app.state.assert_invariants_for_test();
}
