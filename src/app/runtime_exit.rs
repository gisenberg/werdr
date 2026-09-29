//! Validate runtime incarnation before forwarding or applying exit effects.

use super::App;
use crate::events::AppEvent;

/// Retaining the allocation prevents an old timer from matching a later A/B/A
/// registration. This identity is process-local, not part of the wire protocol.
#[derive(Clone, Debug)]
pub struct WorktreeRestoreRequest {
    operation_id: u64,
    terminal_id: crate::terminal::TerminalId,
    identity: std::sync::Arc<()>,
}

impl WorktreeRestoreRequest {
    pub(crate) fn new(operation_id: u64, terminal_id: crate::terminal::TerminalId) -> Self {
        Self {
            operation_id,
            terminal_id,
            identity: std::sync::Arc::new(()),
        }
    }

    pub(crate) fn matches_binding(
        &self,
        operation_id: u64,
        terminal_id: &crate::terminal::TerminalId,
    ) -> bool {
        self.operation_id == operation_id && &self.terminal_id == terminal_id
    }

    pub(crate) fn same_registration(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.identity, &other.identity)
    }

    pub(crate) fn terminal_id(&self) -> &crate::terminal::TerminalId {
        &self.terminal_id
    }
}

/// A move-only proof of an owner claim. Only this module constructs it.
pub(crate) struct RuntimeExitClaim {
    retired_terminal: Option<crate::terminal::TerminalId>,
}

#[cfg(test)]
mod tests;

impl RuntimeExitClaim {
    pub(crate) fn is_retired(&self) -> bool {
        self.retired_terminal.is_some()
    }

    pub(super) fn permits_restore(&self, terminal_id: &crate::terminal::TerminalId) -> bool {
        self.retired_terminal.as_ref() == Some(terminal_id)
    }
}

pub(crate) struct ValidatedOwnerEvent {
    event: AppEvent,
    exit: Option<RuntimeExitClaim>,
}

impl ValidatedOwnerEvent {
    pub(crate) fn into_parts(self) -> (AppEvent, Option<RuntimeExitClaim>) {
        (self.event, self.exit)
    }
}

impl App {
    pub(crate) fn validate_runtime_exit(&self, event: AppEvent) -> Option<ValidatedOwnerEvent> {
        let AppEvent::RuntimeExited { pane_id, record } = event else {
            return Some(ValidatedOwnerEvent { event, exit: None });
        };
        // A removed runtime is authoritative only for its explicit retirement.
        let retired_terminal = self
            .pending_worktree_remove_runtime_exits
            .get(&pane_id)
            .and_then(|records| {
                records
                    .iter()
                    .find(|(_, expected)| expected.same_runtime(&record))
                    .map(|(id, _)| id.clone())
            });
        let target = if retired_terminal.is_some() {
            pane_id
        } else {
            let (terminal_id, _) = self
                .terminal_runtimes
                .iter()
                .find(|(_, runtime)| runtime.exit_record().same_runtime(&record))?;
            if let Some(popup) = self
                .state
                .popup_pane
                .as_ref()
                .filter(|popup| &popup.terminal_id == terminal_id)
            {
                popup.pane_id
            } else {
                // Resolve the current attachment, never the producer's old pane.
                // Detached evidence remains unclaimed and retained by its runtime.
                self.state
                    .workspaces
                    .iter()
                    .flat_map(|workspace| &workspace.tabs)
                    .flat_map(|tab| &tab.panes)
                    .find(|(_, pane)| &pane.attached_terminal_id == terminal_id)
                    .map(|(id, _)| *id)?
            }
        };
        let exit_reason = record.claim()?;
        Some(ValidatedOwnerEvent {
            event: AppEvent::PaneDied {
                pane_id: target,
                exit_reason,
            },
            exit: Some(RuntimeExitClaim { retired_terminal }),
        })
    }
}
