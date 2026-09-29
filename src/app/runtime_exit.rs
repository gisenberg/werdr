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

/// A move-only validated exit destination. Attached and retired exits are already
/// claimed; detached candidates are revalidated and claimed at removal instead.
/// Only this module constructs it.
pub(crate) struct RuntimeExitClaim {
    retired_terminal: Option<crate::terminal::TerminalId>,
    detached: Option<(crate::terminal::TerminalId, crate::pane::ExitRecord)>,
}

#[cfg(test)]
mod tests;

impl RuntimeExitClaim {
    pub(crate) fn is_detached(&self) -> bool {
        self.detached.is_some()
    }
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
                let attachment = self
                    .state
                    .workspaces
                    .iter()
                    .flat_map(|workspace| &workspace.tabs)
                    .flat_map(|tab| &tab.panes)
                    .find(|(_, pane)| &pane.attached_terminal_id == terminal_id)
                    .map(|(id, _)| *id);
                if let Some(pane_id) = attachment {
                    pane_id
                } else {
                    record.evidence()?;
                    if record.is_claimed() {
                        return None;
                    }
                    return Some(ValidatedOwnerEvent {
                        event: AppEvent::RuntimeExited {
                            pane_id,
                            record: record.clone(),
                        },
                        exit: Some(RuntimeExitClaim {
                            retired_terminal: None,
                            detached: Some((terminal_id.clone(), record)),
                        }),
                    });
                }
            }
        };
        let exit_reason = record.claim()?;
        Some(ValidatedOwnerEvent {
            event: AppEvent::PaneDied {
                pane_id: target,
                exit_reason,
            },
            exit: Some(RuntimeExitClaim {
                retired_terminal,
                detached: None,
            }),
        })
    }

    /// Revalidate at removal, so even a retained token cannot target a replacement
    /// or a terminal reattached since normalization. No await separates claim and
    /// removal. This never applies the old producer pane's exit policy.
    pub(crate) fn finish_detached_runtime_exit(
        &mut self,
        claim: RuntimeExitClaim,
    ) -> Option<crate::terminal::TerminalId> {
        let (terminal_id, record) = claim.detached?;
        if self
            .state
            .popup_pane
            .as_ref()
            .is_some_and(|popup| popup.terminal_id == terminal_id)
            || self
                .state
                .workspaces
                .iter()
                .flat_map(|workspace| &workspace.tabs)
                .flat_map(|tab| tab.panes.values())
                .any(|pane| pane.attached_terminal_id == terminal_id)
            || !self
                .terminal_runtimes
                .get(&terminal_id)
                .is_some_and(|runtime| runtime.exit_record().same_runtime(&record))
        {
            return None;
        }
        record.claim()?;
        let runtime = self.terminal_runtimes.remove(&terminal_id)?;
        self.state.terminals.remove(&terminal_id);
        self.state.direct_attach_resize_locks.remove(&terminal_id);
        self.state
            .terminal_runtime_shutdowns
            .retain(|queued| queued != &terminal_id);
        // Observed-exit disposal releases owned PTY/task resources without using
        // a potentially reused numeric child PID to signal unrelated processes.
        drop(runtime);
        self.sync_agent_metadata_deadline();
        Some(terminal_id)
    }
}
