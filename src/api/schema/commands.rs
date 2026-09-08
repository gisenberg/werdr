use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandInvokeParams {
    /// Opaque endpoint-issued command identifier from command.list.
    pub command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// Client-owned selection coordinates, validated against the pane's content revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<super::PaneSelectionReadParams>,
}

/// Configuration-backed command metadata. Executable text stays on the owning endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandInfo {
    pub command_id: String,
    pub binding_labels: Vec<String>,
    pub action: CommandAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CommandAction {
    Shell,
    Pane,
    Popup,
    PluginAction,
    #[serde(other)]
    Unknown,
}
