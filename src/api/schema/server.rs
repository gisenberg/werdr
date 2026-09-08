use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct PingParams {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ServerLiveHandoffParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_exe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_protocol: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ServerCapabilities {
    /// Atomically rejects shutdown while sessions or pending work remain.
    #[serde(default)]
    pub stop_if_idle: bool,
    /// Supports popup.get, popup.close_exact, plugin.popup.open and popup.changed subscriptions.
    #[serde(default)]
    pub popup_sessions: bool,
    /// Executes opaque commands with explicit context and producer-owned result identities.
    #[serde(default)]
    pub command_execution: bool,
    /// Supports command.list and command.manifest_changed subscriptions.
    #[serde(default)]
    pub command_catalog: bool,
    /// Supports include_git_status on workspace.updated subscriptions.
    #[serde(default)]
    pub workspace_git_status: bool,
    /// Supports opt-in ephemeral semantic notification subscriptions.
    #[serde(default)]
    pub semantic_notifications: bool,
    pub live_handoff: bool,
    #[serde(default)]
    pub detached_server_daemon: bool,
    /// Stable client-owned endpoint generation supported by this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_protocol_generation: Option<u32>,
    /// Whether this server supports explicit client-shell surface interest.
    #[serde(default)]
    pub surface_interest: bool,
    /// Inactive endpoint attachment never creates sessions or nudges live panes.
    #[serde(default)]
    pub passive_metadata: bool,
    /// Whether this server supports endpoint health probes.
    #[serde(default)]
    pub health_check: bool,
}
