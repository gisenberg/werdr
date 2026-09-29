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
async fn runtime_exit_timeout_rebound_without_runtime_preserves_new_attachment() {
    let (mut app, pane, current_terminal, _) = fixture();
    app.terminal_runtimes.remove(&current_terminal);
    let old_terminal = TerminalId::alloc();
    let old = ExitRecord::test_recorded(ChildExitReason::Exited);
    app.pending_worktree_remove_runtime_exits
        .insert(pane, vec![(old_terminal.clone(), old.clone())]);
    app.pending_worktree_remove_runtime_restores
        .insert(pane, (7, old_terminal));
    app.handle_internal_event(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        operation_id: 7,
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
        .insert(pane, (7, terminal.clone()));
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
        .insert(pane, (8, terminal));
    assert!(!app.claim_worktree_runtime_restore_failure(pane, 7));
    assert!(app
        .pending_worktree_remove_runtime_exits
        .contains_key(&pane));
    app.handle_internal_event(AppEvent::WorktreeRuntimeRestoreFailed {
        pane_id: pane,
        operation_id: 8,
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
        .insert(pane, (7, terminal.clone()));
    app.handle_internal_event(event(pane, &retired));
    assert!(app.terminal_runtimes.get(&terminal).is_none());
    assert!(app.pending_worktree_remove_runtime_exits.is_empty());
    assert!(app.pending_worktree_remove_runtime_restores.is_empty());
    assert!(app.find_pane(pane).is_some());
}
