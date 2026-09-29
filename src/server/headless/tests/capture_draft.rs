use super::*;
use crate::terminal::{TerminalId, TerminalRuntime};
use std::{future::Future, task::Poll};

fn fixture() -> (HeadlessServer, TerminalId, crate::layout::PaneId) {
    let mut server = test_headless_server();
    let workspace = crate::workspace::Workspace::test_new("capture-prefix");
    let pane_id = workspace.tabs[0].root_pane;
    let terminal_id = workspace.terminal_id(pane_id).unwrap().clone();
    server.app.state.workspaces = vec![workspace];
    server.app.state.ensure_test_terminals();
    server.app.state.active = Some(0);
    server.app.state.selected = 0;
    server.app.terminal_runtimes.insert(
        terminal_id.clone(),
        TerminalRuntime::test_for_draft_capture(b"retained history"),
    );
    server.app.state.assert_invariants_for_test();
    (server, terminal_id, pane_id)
}

#[tokio::test]
async fn prior_cwd_and_detection_events_apply_before_owner_capture() {
    let (mut server, terminal_id, pane_id) = fixture();
    let cwd = std::env::temp_dir();
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalCwdReported {
            pane_id,
            cwd: cwd.clone(),
        })
        .unwrap();
    server
        .app
        .event_tx
        .try_send(AppEvent::StateChanged {
            pane_id,
            agent: Some(crate::detect::Agent::Codex),
            state: crate::detect::AgentState::Working,
            visible_blocker: false,
            visible_working: true,
            process_exited: false,
            observed_at: Instant::now(),
        })
        .unwrap();
    server
        .capture_terminal_after_queued_prefix(
            &terminal_id,
            crate::pane::draft_test_limits(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let terminal = server.app.state.terminals.get(&terminal_id).unwrap();
    assert_eq!(terminal.cwd, cwd);
    assert_eq!(terminal.detected_agent, Some(crate::detect::Agent::Codex));
    assert_eq!(terminal.fallback_state, crate::detect::AgentState::Working);
    assert!(server.app.event_rx.is_empty());
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn pane_death_in_prior_prefix_prevents_stale_capture() {
    let (mut server, terminal_id, pane_id) = fixture();
    server
        .app
        .event_tx
        .try_send(AppEvent::PaneDied {
            pane_id,
            exit_reason: crate::platform::ChildExitReason::Exited,
        })
        .unwrap();
    let error = server
        .capture_terminal_after_queued_prefix(
            &terminal_id,
            crate::pane::draft_test_limits(),
            Duration::from_secs(2),
        )
        .await
        .err()
        .unwrap();
    assert!(
        error.contains("removed") || error.contains("shutdown"),
        "{error}"
    );
    assert!(server.app.terminal_runtimes.get(&terminal_id).is_none());
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn same_terminal_id_with_replacement_runtime_fails_identity_check() {
    let (mut server, terminal_id, _) = fixture();
    let identity = server
        .app
        .terminal_runtimes
        .get(&terminal_id)
        .unwrap()
        .capture_identity();
    let original = server.app.terminal_runtimes.remove(&terminal_id).unwrap();
    drop(original);
    server.app.terminal_runtimes.insert(
        terminal_id.clone(),
        TerminalRuntime::test_for_draft_capture(b"replacement"),
    );
    let err = server
        .capture_runtime_if_unchanged(&terminal_id, &identity)
        .err()
        .unwrap();
    assert!(err.contains("replaced"), "{err}");
    assert!(server
        .app
        .terminal_runtimes
        .get(&terminal_id)
        .unwrap()
        .visible_text()
        .contains("replacement"));
}

#[tokio::test]
async fn finite_prefix_leaves_later_events_queued_in_order() {
    let (mut server, _, pane_id) = fixture();
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalBell { pane_id, count: 1 })
        .unwrap();
    let count = server.app.event_rx.len();
    // Sample once; later publication must not enlarge the owner operation.
    for count in [2, 3] {
        server
            .app
            .event_tx
            .try_send(AppEvent::TerminalBell { pane_id, count })
            .unwrap();
    }
    server.apply_capture_prefix(count).unwrap();
    for expected in [2, 3] {
        let AppEvent::TerminalBell { count, .. } = server.app.event_rx.try_recv().unwrap() else {
            panic!("expected queued bell");
        };
        assert_eq!(count, expected);
    }
    assert!(server.app.event_rx.is_empty());
}

#[tokio::test]
async fn full_event_queue_does_not_require_a_marker_or_block_capture() {
    let (mut server, terminal_id, pane_id) = fixture();
    for _ in 0..crate::app::APP_EVENT_CHANNEL_CAPACITY {
        server
            .app
            .event_tx
            .try_send(AppEvent::TerminalBell { pane_id, count: 1 })
            .unwrap();
    }
    assert_eq!(server.app.event_tx.capacity(), 0);
    server
        .capture_terminal_after_queued_prefix(
            &terminal_id,
            crate::pane::draft_test_limits(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(server.app.event_rx.is_empty());
}

#[tokio::test]
async fn prefix_preserves_normal_foreground_effect_forwarding() {
    let (mut server, terminal_id, pane_id) = fixture();
    let (writer, foreground, _) = test_client_writer();
    let (background_writer, background, _) = test_client_writer();
    for (id, writer) in [(1, writer), (2, background_writer)] {
        server.clients.insert(
            id,
            ClientConnection::new(
                (80, 24),
                crate::kitty_graphics::HostCellSize::default(),
                id,
                RenderEncoding::SemanticFrame,
                Some(writer),
            ),
        );
    }
    server.foreground_client_id = Some(1);
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalBell { pane_id, count: 4 })
        .unwrap();
    server
        .app
        .event_tx
        .try_send(AppEvent::ClipboardWrite {
            content: b"payload".to_vec(),
        })
        .unwrap();
    server
        .capture_terminal_after_queued_prefix(
            &terminal_id,
            crate::pane::draft_test_limits(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(matches!(
        read_server_message(foreground.try_recv().unwrap()),
        ServerMessage::TerminalBell { count: 4 }
    ));
    let ServerMessage::Clipboard { data } = read_server_message(foreground.try_recv().unwrap())
    else {
        panic!("expected clipboard forwarding");
    };
    assert_eq!(data, "cGF5bG9hZA==");
    assert!(foreground.try_recv().is_err());
    assert!(background.try_recv().is_err());
}

#[tokio::test]
async fn shutdown_and_incomplete_prefix_fail_without_false_acknowledgement() {
    for host_shutdown in [false, true] {
        let (mut server, terminal_id, pane_id) = fixture();
        server
            .app
            .event_tx
            .try_send(AppEvent::TerminalBell { pane_id, count: 1 })
            .unwrap();
        if host_shutdown {
            server
                .host_shutdown_requested
                .store(true, Ordering::Release);
        } else {
            server.should_quit.store(true, Ordering::Release);
        }
        let error = server
            .capture_terminal_after_queued_prefix(
                &terminal_id,
                crate::pane::draft_test_limits(),
                Duration::from_secs(2),
            )
            .await
            .err()
            .unwrap();
        assert!(error.contains("shutdown"), "{error}");
        assert_eq!(server.app.event_rx.len(), 1);
    }
    let (mut server, _, pane_id) = fixture();
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalBell { pane_id, count: 1 })
        .unwrap();
    let error = server.apply_capture_prefix(2).unwrap_err();
    assert!(error.contains("completely applied"), "{error}");
    assert!(server.app.event_rx.is_empty());
}

#[tokio::test]
async fn shutdown_while_waiting_for_detector_rejects_after_pause_cleanup() {
    let (mut server, terminal_id, pane_id) = fixture();
    let (runtime, release) = TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"kept");
    server
        .app
        .terminal_runtimes
        .insert(terminal_id.clone(), runtime);
    let cwd = std::env::temp_dir();
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalCwdReported {
            pane_id,
            cwd: cwd.clone(),
        })
        .unwrap();
    let shutdown = server.host_shutdown_requested.clone();
    let mut capture = Box::pin(server.capture_terminal_after_queued_prefix(
        &terminal_id,
        crate::pane::draft_test_limits(),
        Duration::from_secs(2),
    ));
    std::future::poll_fn(|cx| {
        assert!(capture.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    shutdown.store(true, Ordering::Release);
    release.send(()).unwrap();
    let err = capture.await.err().unwrap();
    assert!(err.contains("shutdown"), "{err}");
    assert_eq!(
        server.app.state.terminals.get(&terminal_id).unwrap().cwd,
        cwd
    );
    assert!(server.app.event_rx.is_empty());
    // Retry the underlying scoped operation to prove the detector lease was
    // released, without bypassing the owner's shutdown rejection in production.
    server
        .app
        .terminal_runtimes
        .get_mut(&terminal_id)
        .unwrap()
        .capture_terminal_state_draft(crate::pane::draft_test_limits(), Duration::from_secs(2))
        .await
        .unwrap();
}

#[tokio::test]
async fn cancellation_keeps_applied_prefix_and_releases_detector_request() {
    let (mut server, terminal_id, pane_id) = fixture();
    let (runtime, release) = TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"kept");
    server
        .app
        .terminal_runtimes
        .insert(terminal_id.clone(), runtime);
    let cwd = std::env::temp_dir();
    server
        .app
        .event_tx
        .try_send(AppEvent::TerminalCwdReported {
            pane_id,
            cwd: cwd.clone(),
        })
        .unwrap();
    let mut capture = Box::pin(server.capture_terminal_after_queued_prefix(
        &terminal_id,
        crate::pane::draft_test_limits(),
        Duration::from_secs(2),
    ));
    std::future::poll_fn(|cx| {
        assert!(capture.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(capture);
    assert_eq!(
        server.app.state.terminals.get(&terminal_id).unwrap().cwd,
        cwd
    );
    assert!(server.app.event_rx.is_empty());
    release.send(()).unwrap();
    server
        .capture_terminal_after_queued_prefix(
            &terminal_id,
            crate::pane::draft_test_limits(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(server.app.event_rx.is_empty());
    server.app.state.assert_invariants_for_test();
}
