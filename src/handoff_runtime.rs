#[cfg(unix)]
use serde::{Deserialize, Serialize};

/// Long-lived pane runtime transferred during server replacement.
///
/// Handoff preserves server-owned session state such as PTYs, processes, agent
/// identity, and durable plugin/session metadata. It intentionally does not
/// preserve transient coordination such as in-flight requests, waits,
/// subscriptions, client sockets, or pane-to-pane messages; clients reconnect
/// and retry those operations after replacement.
#[cfg(unix)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HandoffRuntimeState {
    pub pane_id: u32,
    pub child_pid: u32,
    pub rows: u16,
    pub cols: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
    #[serde(default)]
    pub keyboard_protocol_flags: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard_protocol_ansi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_state: Option<crate::pane::InputState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_history_ansi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_state: Option<crate::terminal::state::HandoffAgentState>,
    /// Exact terminal state offered for this pane. The bytes follow the
    /// manifest on the handoff stream only when the importer accepts the codec.
    /// Absent from manifests written by exporters without exact capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_state: Option<HandoffTerminalStateOffer>,
}

/// Describes one exact terminal-state record without carrying its bytes.
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HandoffTerminalStateOffer {
    /// Exporter's terminal-state codec identity; importers accept only an exact match.
    pub codec: String,
    /// Exact encoded length of the record that follows the manifest.
    pub bytes: u64,
    /// Retained images referenced process-local files and were not transferred.
    #[serde(default)]
    pub graphics_dropped: bool,
}

#[cfg(unix)]
impl HandoffRuntimeState {
    pub fn with_pane_id(mut self, pane_id: crate::layout::PaneId) -> Self {
        self.pane_id = pane_id.raw();
        self
    }
}

#[derive(Debug)]
pub(crate) struct ImportedHandoffRuntime {
    #[cfg(unix)]
    pub master_fd: std::os::fd::RawFd,
    #[cfg(unix)]
    pub state: HandoffRuntimeState,
    /// Exact terminal-state record received after the manifest, if accepted.
    #[cfg(unix)]
    pub terminal_state: Option<Vec<u8>>,
    /// The exporter required lossless transfer; never fall back to history replay.
    #[cfg(unix)]
    pub require_exact_terminal_state: bool,
}
