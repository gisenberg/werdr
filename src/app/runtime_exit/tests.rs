use super::*;
use crate::{
    layout::PaneId,
    pane::ExitRecord,
    platform::ChildExitReason,
    terminal::{TerminalId, TerminalRuntime},
};

fn fixture() -> (App, PaneId, TerminalId, ExitRecord) {
    let (_, api_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut app = App::new(
        &crate::config::Config::default(),
        super::super::AppPolicy::TEST,
        None,
        api_rx,
        crate::api::EventHub::default(),
    );
    let workspace = crate::workspace::Workspace::test_new("exit-identity");
    let pane = workspace.tabs[0].root_pane;
    let terminal = workspace.terminal_id(pane).unwrap().clone();
    app.state.workspaces = vec![workspace];
    app.state.ensure_test_terminals();
    app.state.active = Some(0);
    let (runtime, _) = TerminalRuntime::test_with_channel(40, 5);
    let record = runtime.exit_record();
    app.terminal_runtimes.insert(terminal.clone(), runtime);
    (app, pane, terminal, record)
}

fn event(pane_id: PaneId, record: &ExitRecord) -> AppEvent {
    AppEvent::RuntimeExited {
        pane_id,
        record: record.clone(),
    }
}

#[tokio::test]
async fn restore_timer_replacement_and_aba_get_distinct_deliverable_registrations() {
    let (mut app, pane, terminal, _) = fixture();
    app.terminal_runtimes.remove(&terminal);
    let other = TerminalId::alloc();
    let mut registrations = Vec::new();
    for (operation, target) in [
        (1, terminal.clone()),
        (2, terminal.clone()),
        (2, other),
        (2, terminal.clone()),
    ] {
        assert!(app.schedule_worktree_runtime_restore(pane, operation, target.clone()));
        let registered = app.pending_worktree_remove_runtime_restores[&pane].clone();
        assert!(!app.schedule_worktree_runtime_restore(pane, operation, target));
        assert!(app.pending_worktree_remove_runtime_restores[&pane].same_registration(&registered));
        registrations.push(registered);
    }
    assert!(!registrations[1].same_registration(&registrations[3]));
    let latest = registrations.last().unwrap().clone();
    let mut seen = vec![false; registrations.len()];
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for _ in 0..registrations.len() {
            let AppEvent::WorktreeRuntimeRestoreFailed { pane_id, request } =
                app.event_rx.recv().await.unwrap()
            else {
                panic!("expected restore timer")
            };
            assert_eq!(pane_id, pane);
            let index = registrations
                .iter()
                .position(|registered| registered.same_registration(&request))
                .unwrap();
            assert!(!seen[index]);
            seen[index] = true;
            if !request.same_registration(&latest) {
                assert!(!app.claim_worktree_runtime_restore_failure(pane, &request));
            }
        }
    })
    .await
    .unwrap();
    assert!(seen.into_iter().all(|seen| seen));
    assert!(app.event_rx.try_recv().is_err());
    assert!(app.pending_worktree_remove_runtime_restores[&pane].same_registration(&latest));
    app.handle_internal_event(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        request: latest.clone(),
    });
    assert!(app.find_pane(pane).is_none());
    assert!(!app.claim_worktree_runtime_restore_failure(pane, &latest));
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn restore_timer_retirement_completion_invalidates_queued_timeout() {
    let (mut app, pane, terminal, _) = fixture();
    let retired = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits
        .insert(pane, vec![(terminal.clone(), retired.clone())]);
    assert!(app.schedule_worktree_runtime_restore(pane, 7, terminal.clone()));
    app.handle_internal_event(event(pane, &retired));
    assert!(app.pending_worktree_remove_runtime_restores.is_empty());
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(5), app.event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    app.handle_internal_event(timeout);
    assert!(app.find_pane(pane).is_some());
    assert!(app.terminal_runtimes.get(&terminal).is_some());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn restore_timer_bounded_queue_preserves_superseding_registration() {
    let (mut app, pane, terminal, _) = fixture();
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    app.event_tx = sender;
    app.event_rx = crate::events::OwnerInbox::new(receiver);
    app.event_tx
        .try_send(AppEvent::TerminalBell {
            pane_id: pane,
            count: 1,
        })
        .unwrap();
    assert!(app.schedule_worktree_runtime_restore(pane, 1, terminal.clone()));
    let first = app.pending_worktree_remove_runtime_restores[&pane].clone();
    assert!(app.schedule_worktree_runtime_restore(pane, 2, terminal));
    let latest = app.pending_worktree_remove_runtime_restores[&pane].clone();
    // Keep the capacity-one queue full across both timer deadlines.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert!(matches!(
        app.event_rx.recv().await,
        Some(AppEvent::TerminalBell { .. })
    ));
    let mut delivered = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for _ in 0..2 {
            let AppEvent::WorktreeRuntimeRestoreFailed { request, .. } =
                app.event_rx.recv().await.unwrap()
            else {
                panic!("expected restore timer")
            };
            delivered.push(request);
        }
    })
    .await
    .unwrap();
    assert!(delivered
        .iter()
        .any(|request| request.same_registration(&first)));
    assert!(delivered
        .iter()
        .any(|request| request.same_registration(&latest)));
    assert!(!app.claim_worktree_runtime_restore_failure(pane, &first));
    assert!(app.pending_worktree_remove_runtime_restores[&pane].same_registration(&latest));
}

#[tokio::test]
async fn runtime_exit_timeout_rebound_without_runtime_preserves_new_attachment() {
    let (mut app, pane, current_terminal, _) = fixture();
    app.terminal_runtimes.remove(&current_terminal);
    let old_terminal = TerminalId::alloc();
    let old = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits
        .insert(pane, vec![(old_terminal.clone(), old.clone())]);
    app.pending_worktree_remove_runtime_restores
        .insert(pane, WorktreeRestoreRequest::new(7, old_terminal));
    app.handle_internal_event(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        request: app.pending_worktree_remove_runtime_restores[&pane].clone(),
    });
    assert!(app.find_pane(pane).is_some());
    assert!(app.terminal_runtimes.get(&current_terminal).is_none());
    assert!(app.pending_worktree_remove_runtime_restores.is_empty());
    assert!(app.pending_worktree_remove_runtime_exits.is_empty());
    app.handle_internal_event(event(pane, &old));
    assert!(!old.is_claimed());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_rejects_missing_evidence_and_replaced_incarnation() {
    let (mut app, pane, terminal, record) = fixture();
    assert!(app.validate_runtime_exit(event(pane, &record)).is_none());
    assert!(!record.is_claimed());
    record.test_record(ChildExitReason::Exited);
    let (replacement, _) = TerminalRuntime::test_with_channel(40, 5);
    let identity = replacement.exit_record();
    app.terminal_runtimes.insert(terminal.clone(), replacement);
    app.handle_internal_event(event(pane, &record));
    assert!(!record.is_claimed());
    assert!(app.find_pane(pane).is_some());
    assert!(app
        .terminal_runtimes
        .get(&terminal)
        .unwrap()
        .exit_record()
        .same_runtime(&identity));
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_valid_current_applies_once_and_ignores_producer_pane_id() {
    let (mut app, pane, _, record) = fixture();
    record.test_record(ChildExitReason::Exited);
    app.handle_internal_event(event(PaneId::alloc(), &record));
    assert!(record.is_claimed());
    assert!(app.find_pane(pane).is_none());
    assert!(app.validate_runtime_exit(event(pane, &record)).is_none());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_retired_out_of_order_duplicate_cannot_consume_other_expectation() {
    let (mut app, pane, terminal, _) = fixture();
    let first = ExitRecord::test_recorded(ChildExitReason::Exited);
    let second = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits.insert(
        pane,
        vec![
            (terminal.clone(), first.clone()),
            (terminal.clone(), second.clone()),
        ],
    );
    app.pending_worktree_remove_runtime_restores
        .insert(pane, WorktreeRestoreRequest::new(7, terminal.clone()));
    let replacement = app.terminal_runtimes.get(&terminal).unwrap().exit_record();
    app.handle_internal_event(event(pane, &second));
    assert_eq!(app.pending_worktree_remove_runtime_exits[&pane].len(), 1);
    app.handle_internal_event(event(pane, &second));
    assert_eq!(app.pending_worktree_remove_runtime_exits[&pane].len(), 1);
    app.handle_internal_event(event(
        pane,
        &ExitRecord::test_recorded(ChildExitReason::Exited),
    ));
    assert_eq!(app.pending_worktree_remove_runtime_exits[&pane].len(), 1);
    app.handle_internal_event(event(pane, &first));
    assert!(app.pending_worktree_remove_runtime_exits.is_empty());
    assert!(app.pending_worktree_remove_runtime_restores.is_empty());
    assert!(app
        .terminal_runtimes
        .get(&terminal)
        .unwrap()
        .exit_record()
        .same_runtime(&replacement));
    assert!(app.find_pane(pane).is_some());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_timeout_never_closes_replacement_or_accepts_late_retired_exit() {
    let (mut app, pane, terminal, _) = fixture();
    let retired = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits
        .insert(pane, vec![(terminal.clone(), retired.clone())]);
    app.pending_worktree_remove_runtime_restores
        .insert(pane, WorktreeRestoreRequest::new(8, terminal.clone()));
    assert!(!app
        .claim_worktree_runtime_restore_failure(pane, &WorktreeRestoreRequest::new(7, terminal)));
    assert!(app
        .pending_worktree_remove_runtime_exits
        .contains_key(&pane));
    app.handle_internal_event(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        request: app.pending_worktree_remove_runtime_restores[&pane].clone(),
    });
    assert!(app.pending_worktree_remove_runtime_exits.is_empty());
    app.handle_internal_event(event(pane, &retired));
    assert!(!retired.is_claimed());
    assert!(app.find_pane(pane).is_some());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_detached_evidence_cannot_close_former_pane() {
    let (mut app, pane, terminal, record) = fixture();
    record.test_record(ChildExitReason::Exited);
    let detached = app.terminal_runtimes.remove(&terminal).unwrap();
    let detached_id = TerminalId::alloc();
    app.state.terminals.insert(
        detached_id.clone(),
        crate::terminal::TerminalState::new(detached_id.clone(), std::env::temp_dir()),
    );
    app.terminal_runtimes.insert(detached_id, detached);
    let (replacement, _) = TerminalRuntime::test_with_channel(40, 5);
    app.terminal_runtimes.insert(terminal, replacement);
    app.handle_internal_event(event(pane, &record));
    assert!(app.find_pane(pane).is_some());
    assert!(!record.is_claimed());
    assert!(record.evidence().is_some());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_popup_replacement_rejects_old_record_and_accepts_current() {
    let (mut app, underlying, _, _) = fixture();
    let (popup, _) = TerminalRuntime::test_with_channel(40, 5);
    let old = popup.exit_record();
    let (pane, terminal) = app.install_test_popup_runtime(popup);
    old.test_record(ChildExitReason::Exited);
    let (replacement, _) = TerminalRuntime::test_with_channel(40, 5);
    let current = replacement.exit_record();
    app.terminal_runtimes.insert(terminal, replacement);
    assert!(!app.handle_internal_event_with_render_impact(event(pane, &old)));
    assert_eq!(app.state.popup_pane.as_ref().unwrap().pane_id, pane);
    current.test_record(ChildExitReason::Exited);
    assert!(app.handle_internal_event_with_render_impact(event(pane, &current)));
    assert!(app.state.popup_pane.is_none());
    assert!(app.find_pane(underlying).is_some());
    assert!(current.is_claimed());
    app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn runtime_exit_retired_rebound_attachment_does_not_respawn() {
    let (mut app, pane, terminal, _) = fixture();
    app.terminal_runtimes.remove(&terminal);
    let retired = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits
        .insert(pane, vec![(TerminalId::alloc(), retired.clone())]);
    app.pending_worktree_remove_runtime_restores
        .insert(pane, WorktreeRestoreRequest::new(7, terminal.clone()));
    app.handle_internal_event(event(pane, &retired));
    assert!(app.terminal_runtimes.get(&terminal).is_none());
    assert!(app.pending_worktree_remove_runtime_exits.is_empty());
    assert!(app.pending_worktree_remove_runtime_restores.is_empty());
    assert!(app.find_pane(pane).is_some());
}
