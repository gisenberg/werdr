use super::*;

fn queued_request(method: &str) -> (api::ApiRequestMessage, std::sync::mpsc::Receiver<String>) {
    let (respond_to, response_rx) = std::sync::mpsc::channel();
    (
        api::ApiRequestMessage {
            request: serde_json::from_value(serde_json::json!({
                "id": method, "method": method, "params": {}
            }))
            .unwrap(),
            respond_to,
            response_write_complete: None,
            stream_active: None,
        },
        response_rx,
    )
}

fn response(rx: std::sync::mpsc::Receiver<String>) -> serde_json::Value {
    serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap()
}

#[test]
fn stop_if_idle_fences_queued_creation_without_creating_a_default_workspace() {
    let mut server = test_headless_server();
    assert!(server.app.state.workspaces.is_empty());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    server.app.api_rx = rx;
    let (stop, stop_rx) = queued_request("server.stop_if_idle");
    let (create, create_rx) = queued_request("workspace.create");
    tx.send(stop).unwrap();
    tx.send(create).unwrap();

    assert!(server.drain_api_requests_with_shutdown_check());
    assert_eq!(response(stop_rx)["result"]["type"], "ok");
    assert!(server.shutting_down);
    assert!(server.should_quit.load(Ordering::Acquire));
    assert!(server.app.state.should_quit);
    assert_eq!(server.app.api_rx.len(), 1);
    server.reject_queued_api_requests_for_shutdown();
    assert_eq!(response(create_rx)["error"]["code"], "server_unavailable");
    assert!(server.app.state.workspaces.is_empty());
    assert!(server.app.state.terminals.is_empty());
    assert_eq!(server.app.terminal_runtimes.len(), 0);
}

#[test]
fn stop_if_idle_rejects_existing_panes_and_keeps_serving_requests() {
    let mut server = test_headless_server();
    server
        .app
        .state
        .workspaces
        .push(crate::workspace::Workspace::test_new("busy"));
    let (stop, stop_rx) = queued_request("server.stop_if_idle");
    assert!(!server.handle_api_request_with_shutdown_check(stop));
    assert_eq!(response(stop_rx)["error"]["code"], "server_busy");
    assert!(!server.shutting_down);
    assert!(!server.should_quit.load(Ordering::Acquire));
    assert!(!server.app.state.should_quit);
    assert_eq!(server.app.state.workspaces.len(), 1);
    let (list, list_rx) = queued_request("workspace.list");
    server.handle_api_request_with_shutdown_check(list);
    assert!(response(list_rx).get("result").is_some());
    shutdown_test_runtimes(&mut server);
}

#[test]
fn stop_if_idle_rejects_pending_work_without_any_panes() {
    for kind in ["plugin", "create", "remove"] {
        let mut server = test_headless_server();
        match kind {
            "plugin" => server.app.state.plugin_commands_in_flight = 1,
            "create" => {
                server
                    .app
                    .pending_api_worktree_creates
                    .insert("pending".into(), 1);
            }
            "remove" => {
                server
                    .app
                    .pending_api_worktree_removes
                    .insert("pending".into(), 1);
            }
            _ => unreachable!(),
        }
        let (stop, stop_rx) = queued_request("server.stop_if_idle");
        assert!(!server.handle_api_request_with_shutdown_check(stop));
        assert_eq!(response(stop_rx)["error"]["code"], "server_busy", "{kind}");
        assert!(!server.shutting_down);
        assert!(!server.should_quit.load(Ordering::Acquire));
        assert!(server.app.state.workspaces.is_empty());
    }
}
