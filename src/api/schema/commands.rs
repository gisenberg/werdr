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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandTarget {
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandExecuteParams {
    pub command_id: String,
    /// None is an explicit global context, permitted only while the endpoint has no workspaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CommandTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<super::PaneSelectionReadParams>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandPopup {
    pub terminal_id: String,
    pub owner_workspace_id: String,
    pub owner_tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<crate::popup_size::PopupSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<crate::popup_size::PopupSize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandEffect {
    ShellStarted {},
    PaneCreated {
        pane: CommandTarget,
    },
    PopupOpened {
        popup: CommandPopup,
    },
    PluginStarted {
        log_id: String,
        plugin_id: String,
    },
    #[serde(other)]
    Unknown,
}
