use std::fs;
use std::io::{self, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::layout::Direction;

use super::{App, Mode};

static NEXT_COMMAND_NAMESPACE: AtomicU64 = AtomicU64::new(1);

pub(super) fn new_command_namespace() -> String {
    let counter = NEXT_COMMAND_NAMESPACE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}-{counter}", std::process::id())
}

#[derive(Debug)]
pub(super) struct EndpointCommandRegistry {
    entries: Vec<EndpointCommand>,
}

#[derive(Debug)]
struct EndpointCommand {
    id: String,
    binding: crate::config::CustomCommandKeybind,
    action: crate::protocol::ClientShellCommandAction,
}

impl EndpointCommandRegistry {
    pub(super) fn new(bindings: &[crate::config::CustomCommandKeybind]) -> Self {
        let namespace = new_command_namespace();
        let entries = bindings
            .iter()
            .enumerate()
            .map(|(index, binding)| EndpointCommand {
                action: binding.action.into(),
                id: format!("cmd_{namespace}_{index}"),
                binding: binding.clone(),
            })
            .collect();
        Self { entries }
    }
}

impl App {
    pub(crate) fn client_shell_keybindings_profile(&self) -> Option<&str> {
        self.client_shell_keybindings_profile.as_deref()
    }

    pub(crate) fn command_manifest(&self) -> Vec<crate::api::schema::CommandInfo> {
        use crate::api::schema::{CommandAction, CommandInfo};
        self.endpoint_commands
            .entries
            .iter()
            .map(|entry| CommandInfo {
                command_id: entry.id.clone(),
                binding_labels: entry.binding.bindings.labels(),
                action: match entry.binding.action {
                    crate::config::CustomCommandAction::Shell => CommandAction::Shell,
                    crate::config::CustomCommandAction::Pane => CommandAction::Pane,
                    crate::config::CustomCommandAction::Popup => CommandAction::Popup,
                    crate::config::CustomCommandAction::PluginAction => CommandAction::PluginAction,
                },
                description: entry.binding.description.clone(),
            })
            .collect()
    }

    pub(crate) fn client_shell_command_manifest(&self) -> Vec<crate::protocol::ClientShellCommand> {
        self.endpoint_commands
            .entries
            .iter()
            .map(|entry| crate::protocol::ClientShellCommand {
                command_id: entry.id.clone(),
                binding_label: entry.binding.label.clone(),
                binding_labels: entry.binding.bindings.labels(),
                action: entry.action,
                description: entry.binding.description.clone(),
            })
            .collect()
    }

    pub(crate) fn resolve_client_shell_command(
        &self,
        id: &str,
    ) -> Option<crate::config::CustomCommandKeybind> {
        self.endpoint_commands
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.binding.clone())
    }

    fn command_pane_target(
        &self,
        workspace_index: usize,
        pane_id: crate::layout::PaneId,
    ) -> Option<crate::api::schema::CommandTarget> {
        let workspace = self.state.workspaces.get(workspace_index)?;
        let tab_index = workspace.find_tab_index_for_pane(pane_id)?;
        Some(crate::api::schema::CommandTarget {
            workspace_id: self.public_workspace_id(workspace_index),
            tab_id: self.public_tab_id(workspace_index, tab_index)?,
            pane_id: self.public_pane_id(workspace_index, pane_id)?,
            terminal_id: workspace.terminal_id(pane_id)?.as_str().to_owned(),
        })
    }

    pub(crate) fn handle_command_execute(
        &mut self,
        id: String,
        params: crate::api::schema::CommandExecuteParams,
    ) -> String {
        use crate::app::api::responses::{encode_error, encode_success};
        let Some(binding) = self.resolve_client_shell_command(&params.command_id) else {
            return encode_error(
                id,
                "command_not_found",
                "custom command manifest is stale; reload configuration",
            );
        };
        if binding.action == crate::config::CustomCommandAction::Popup
            && self.state.popup_pane.is_some()
        {
            return encode_error(id, "popup_already_open", "popup already open");
        }
        let target = if let Some(expected) = params.target.as_ref() {
            let Some((workspace, pane)) = self.parse_pane_id(&expected.pane_id) else {
                return encode_error(
                    id,
                    "command_target_mismatch",
                    "command target is no longer available",
                );
            };
            if self.command_pane_target(workspace, pane).as_ref() != Some(expected) {
                return encode_error(
                    id,
                    "command_target_mismatch",
                    "command target identity changed",
                );
            }
            Some((workspace, pane))
        } else {
            if !self.state.workspaces.is_empty() {
                return encode_error(
                    id,
                    "command_target_required",
                    "choose an explicit command target",
                );
            }
            None
        };
        let selected_text = if let Some(selection) = params.selection.as_ref() {
            if binding.action != crate::config::CustomCommandAction::PluginAction
                || params.target.as_ref().map(|target| target.pane_id.as_str())
                    != Some(selection.pane_id.as_str())
                || selection.content_revision.is_none()
            {
                return encode_error(
                    id,
                    "command_selection_mismatch",
                    "command selection requires the exact plugin target and content revision",
                );
            }
            match self.pane_selection_text(selection) {
                Ok(text) => Some(text),
                Err((code, message)) => return encode_error(id, code, message),
            }
        } else {
            None
        };
        if let Some((workspace, pane)) = target {
            self.state.focus_pane_in_workspace(workspace, pane);
        }
        match self.execute_custom_command_binding(&binding, selected_text) {
            Ok(effect) => encode_success(
                id,
                crate::api::schema::ResponseResult::CommandExecuted { effect },
            ),
            Err(error) => encode_error(id, "command_failed", error.to_string()),
        }
    }

    pub(crate) fn handle_command_invoke(
        &mut self,
        id: String,
        params: crate::api::schema::CommandInvokeParams,
    ) -> String {
        let Some(binding) = self.resolve_client_shell_command(&params.command_id) else {
            return crate::app::api::responses::encode_error(
                id,
                "command_not_found",
                "custom command manifest is stale; reload configuration",
            );
        };
        if let Err((code, message)) = self.focus_client_shell_command_target(&params) {
            return crate::app::api::responses::encode_error(id, code, message);
        }
        let selected_text = if binding.action == crate::config::CustomCommandAction::PluginAction {
            let Some(selection) = params.selection.as_ref() else {
                return self.execute_custom_command_response(id, &binding, None);
            };
            if params.pane_id.as_deref() != Some(selection.pane_id.as_str()) {
                return crate::app::api::responses::encode_error(
                    id,
                    "command_target_mismatch",
                    "command selection does not belong to the requested pane",
                );
            }
            match self.pane_selection_text(selection) {
                Ok(text) => Some(text),
                Err((code, message)) => {
                    return crate::app::api::responses::encode_error(id, code, message);
                }
            }
        } else {
            None
        };
        self.execute_custom_command_response(id, &binding, selected_text)
    }

    fn execute_custom_command_response(
        &mut self,
        id: String,
        binding: &crate::config::CustomCommandKeybind,
        selected_text: Option<String>,
    ) -> String {
        match self.execute_custom_command_binding(binding, selected_text) {
            Ok(_) => crate::app::api::responses::encode_success(
                id,
                crate::api::schema::ResponseResult::Ok {},
            ),
            Err(error) => {
                crate::app::api::responses::encode_error(id, "command_failed", error.to_string())
            }
        }
    }

    fn focus_client_shell_command_target(
        &mut self,
        params: &crate::api::schema::CommandInvokeParams,
    ) -> Result<(), (&'static str, String)> {
        if let Some(pane_id) = params.pane_id.as_deref() {
            let Some((workspace_index, pane)) = self.parse_pane_id(pane_id) else {
                return Err(("pane_not_found", format!("pane not found: {pane_id}")));
            };
            let Some(tab_index) =
                self.state.workspaces[workspace_index].find_tab_index_for_pane(pane)
            else {
                return Err(("pane_not_found", format!("pane not found: {pane_id}")));
            };
            self.validate_client_shell_command_parent_ids(params, workspace_index, tab_index)?;
            self.state.focus_pane_in_workspace(workspace_index, pane);
            return Ok(());
        }

        if let Some(tab_id) = params.tab_id.as_deref() {
            let Some((workspace_index, tab_index)) = self.parse_tab_id(tab_id) else {
                return Err(("tab_not_found", format!("tab not found: {tab_id}")));
            };
            self.validate_client_shell_command_workspace_id(params, workspace_index)?;
            self.state.switch_workspace_tab(workspace_index, tab_index);
            return Ok(());
        }

        if let Some(workspace_id) = params.workspace_id.as_deref() {
            let Some(workspace_index) = self.parse_workspace_id(workspace_id) else {
                return Err((
                    "workspace_not_found",
                    format!("workspace not found: {workspace_id}"),
                ));
            };
            self.state.switch_workspace(workspace_index);
        }
        Ok(())
    }

    fn validate_client_shell_command_parent_ids(
        &self,
        params: &crate::api::schema::CommandInvokeParams,
        workspace_index: usize,
        tab_index: usize,
    ) -> Result<(), (&'static str, String)> {
        self.validate_client_shell_command_workspace_id(params, workspace_index)?;
        if let Some(tab_id) = params.tab_id.as_deref() {
            let actual = self
                .public_tab_id(workspace_index, tab_index)
                .unwrap_or_default();
            if tab_id != actual {
                return Err((
                    "command_target_mismatch",
                    "command pane does not belong to the requested tab".to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn validate_client_shell_command_workspace_id(
        &self,
        params: &crate::api::schema::CommandInvokeParams,
        workspace_index: usize,
    ) -> Result<(), (&'static str, String)> {
        if params
            .workspace_id
            .as_deref()
            .is_some_and(|workspace_id| workspace_id != self.public_workspace_id(workspace_index))
        {
            return Err((
                "command_target_mismatch",
                "command target does not belong to the requested workspace".to_owned(),
            ));
        }
        Ok(())
    }
    pub(crate) fn execute_custom_command_binding(
        &mut self,
        binding: &crate::config::CustomCommandKeybind,
        selected_text: Option<String>,
    ) -> io::Result<crate::api::schema::CommandEffect> {
        use crate::api::schema::CommandEffect;
        match binding.action {
            crate::config::CustomCommandAction::Shell => self
                .spawn_custom_command(binding)
                .map(|()| CommandEffect::ShellStarted {}),
            crate::config::CustomCommandAction::Pane => self
                .spawn_pane_command(&binding.command, Vec::new())
                .map(|pane| CommandEffect::PaneCreated { pane }),
            crate::config::CustomCommandAction::Popup => self
                .spawn_popup_shell_command(
                    &binding.command,
                    None,
                    self.custom_command_env().0,
                    crate::app::popup::PopupGeometry {
                        width: binding.width,
                        height: binding.height,
                    },
                )
                .map(|popup| CommandEffect::PopupOpened { popup }),
            crate::config::CustomCommandAction::PluginAction => self
                .invoke_plugin_action_from_keybind(binding.command.clone(), selected_text)
                .map(|log| CommandEffect::PluginStarted {
                    log_id: log.log_id,
                    plugin_id: log.plugin_id,
                })
                .map_err(io::Error::other),
        }
    }

    pub(crate) fn custom_command_env(&self) -> (Vec<(String, String)>, Option<std::path::PathBuf>) {
        let mut env = vec![(
            crate::api::SOCKET_PATH_ENV_VAR.to_string(),
            crate::api::socket_path().display().to_string(),
        )];
        if let Ok(current_exe) = std::env::current_exe() {
            env.push((
                "HERDR_BIN_PATH".to_string(),
                current_exe.display().to_string(),
            ));
        }

        let mut cwd = None;
        if let Some(ws_idx) = self.state.active {
            env.push((
                "HERDR_ACTIVE_WORKSPACE_ID".to_string(),
                self.public_workspace_id(ws_idx),
            ));
            if let Some(workspace) = self.state.workspaces.get(ws_idx) {
                let tab_idx = workspace.active_tab_index();
                if let Some(tab_id) = self.public_tab_id(ws_idx, tab_idx) {
                    env.push(("HERDR_ACTIVE_TAB_ID".to_string(), tab_id));
                }
                if let Some(pane_id) = workspace.focused_pane_id() {
                    if let Some(public_pane_id) = self.public_pane_id(ws_idx, pane_id) {
                        env.push(("HERDR_ACTIVE_PANE_ID".to_string(), public_pane_id));
                    }
                    if let Some(pane_cwd) = workspace.active_tab().and_then(|tab| {
                        tab.cwd_for_pane(pane_id, &self.state.terminals, &self.terminal_runtimes)
                    }) {
                        env.push((
                            "HERDR_ACTIVE_PANE_CWD".to_string(),
                            pane_cwd.display().to_string(),
                        ));
                        if pane_cwd.is_dir() {
                            cwd = Some(pane_cwd);
                        }
                    }
                }
            }
        }
        (env, cwd)
    }

    fn spawn_custom_command(
        &mut self,
        binding: &crate::config::CustomCommandKeybind,
    ) -> std::io::Result<()> {
        let mut command = crate::platform::detached_custom_command_process(&binding.command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (env, cwd) = self.custom_command_env();
        command.envs(env);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let child = command.spawn()?;
        self.detached_process_children.push(child);
        Ok(())
    }

    pub(crate) fn open_focused_scrollback_in_editor(&mut self) -> std::io::Result<()> {
        let ws_idx = self
            .state
            .active
            .ok_or_else(|| std::io::Error::other("no active workspace"))?;
        let ws = self
            .state
            .workspaces
            .get(ws_idx)
            .ok_or_else(|| std::io::Error::other("active workspace disappeared"))?;
        let pane_id = ws
            .focused_pane_id()
            .ok_or_else(|| std::io::Error::other("no focused pane"))?;
        let scrollback = self
            .state
            .runtime_for_pane_in_workspace(&self.terminal_runtimes, ws_idx, pane_id)
            .ok_or_else(|| std::io::Error::other("focused pane has no scrollback runtime"))?
            .recent_unwrapped_text_snapshot(usize::MAX)
            .text;

        let path = write_scrollback_temp_file(&scrollback)?;

        let argv = match crate::platform::scrollback_editor_argv(&path) {
            Ok(argv) => argv,
            Err(err) => {
                let _ = fs::remove_file(&path);
                return Err(err);
            }
        };
        let (env, _) = self.custom_command_env();
        let new_pane = match self.spawn_overlay_argv_command(&argv, None, env, vec![path.clone()]) {
            Ok((_, new_pane)) => new_pane,
            Err(err) => {
                let _ = fs::remove_file(&path);
                return Err(err);
            }
        };
        let terminal_id = new_pane.terminal.id.clone();
        self.terminal_runtimes
            .insert(terminal_id.clone(), new_pane.runtime);
        self.state
            .remove_alias_shadowed_by_new_pane(new_pane.pane_id);
        self.state.terminals.insert(terminal_id, new_pane.terminal);

        if let Some(public_pane_id) = self.public_pane_id(ws_idx, pane_id) {
            self.state.toast = Some(crate::app::state::ToastNotification {
                kind: crate::app::state::ToastKind::Finished,
                title: "opened scrollback".to_string(),
                context: format!("focused pane {public_pane_id}"),
                position: None,
                target: None,
            });
        }
        Ok(())
    }

    fn spawn_pane_command(
        &mut self,
        command: &str,
        temp_files: Vec<std::path::PathBuf>,
    ) -> std::io::Result<crate::api::schema::CommandTarget> {
        let Some(ws_idx) = self.state.active else {
            return Err(std::io::Error::other("no active workspace"));
        };
        let previous_focus_target = self.state.current_pane_focus_target();
        let (rows, cols) = self.state.estimate_pane_size();
        let new_rows = rows.max(4);
        let new_cols = cols.max(10);
        let (env, _) = self.custom_command_env();

        let ws = self
            .state
            .workspaces
            .get_mut(ws_idx)
            .ok_or_else(|| std::io::Error::other("active workspace disappeared"))?;
        let tab_idx = ws.active_tab_index();
        let previous_focus = ws
            .focused_pane_id()
            .ok_or_else(|| std::io::Error::other("no focused pane"))?;
        let previous_zoomed = ws.active_tab().map(|tab| tab.zoomed).unwrap_or(false);
        let cwd = ws.active_tab().and_then(|tab| {
            tab.cwd_for_pane(
                previous_focus,
                &self.state.terminals,
                &self.terminal_runtimes,
            )
        });
        let new_pane = ws.split_focused_command(
            Direction::Horizontal,
            new_rows,
            new_cols,
            cwd,
            command,
            env,
            self.state.pane_scrollback_limit_bytes,
            self.state.host_terminal_theme,
            self.state.host_terminal_appearance,
        )?;
        let new_pane_id = new_pane.pane_id;
        self.terminal_runtimes
            .insert(new_pane.terminal.id.clone(), new_pane.runtime);
        self.state
            .terminals
            .insert(new_pane.terminal.id.clone(), new_pane.terminal);
        let new_focus_target = crate::app::state::PaneFocusTarget {
            workspace_id: ws.id.clone(),
            pane_id: new_pane_id,
        };
        if previous_focus_target.as_ref() != Some(&new_focus_target) {
            self.state.previous_pane_focus = previous_focus_target;
        }
        ws.active_tab_mut()
            .expect("workspace must have an active tab")
            .layout
            .focus_pane(new_pane_id);
        ws.active_tab_mut()
            .expect("workspace must have an active tab")
            .zoomed = true;
        self.overlay_panes.insert(
            new_pane_id,
            super::OverlayPaneState {
                ws_idx,
                tab_idx,
                previous_focus,
                previous_zoomed,
                temp_files,
            },
        );
        self.state.remove_alias_shadowed_by_new_pane(new_pane_id);
        self.state.mode = Mode::Terminal;
        self.command_pane_target(ws_idx, new_pane_id)
            .ok_or_else(|| io::Error::other("created command pane disappeared"))
    }

    pub(crate) fn spawn_overlay_argv_command(
        &mut self,
        argv: &[String],
        cwd: Option<std::path::PathBuf>,
        extra_env: Vec<(String, String)>,
        temp_files: Vec<std::path::PathBuf>,
    ) -> std::io::Result<(usize, crate::workspace::NewPane)> {
        let Some(ws_idx) = self.state.active else {
            return Err(std::io::Error::other("no active workspace"));
        };
        let previous_focus_target = self.state.current_pane_focus_target();
        let (rows, cols) = self.state.estimate_pane_size();
        let new_rows = rows.max(4);
        let new_cols = cols.max(10);

        let ws = self
            .state
            .workspaces
            .get(ws_idx)
            .ok_or_else(|| std::io::Error::other("active workspace disappeared"))?;
        let previous_focus = ws
            .focused_pane_id()
            .ok_or_else(|| std::io::Error::other("no focused pane"))?;
        let cwd = cwd.or_else(|| {
            ws.active_tab().and_then(|tab| {
                tab.cwd_for_pane(
                    previous_focus,
                    &self.state.terminals,
                    &self.terminal_runtimes,
                )
            })
        });

        let (tab_idx, new_pane, workspace_id) = {
            let ws = self
                .state
                .workspaces
                .get_mut(ws_idx)
                .ok_or_else(|| std::io::Error::other("active workspace disappeared"))?;
            let previous_zoomed = ws.active_tab().map(|tab| tab.zoomed).unwrap_or(false);
            let result = ws.split_pane_argv_command(
                previous_focus,
                Direction::Horizontal,
                new_rows,
                new_cols,
                cwd,
                argv,
                extra_env,
                self.state.pane_scrollback_limit_bytes,
                self.state.host_terminal_theme,
                self.state.host_terminal_appearance,
                true,
            );
            let (tab_idx, new_pane) = match result {
                Some(Ok(result)) => result,
                Some(Err(err)) => return Err(err),
                None => return Err(std::io::Error::other("focused pane disappeared")),
            };
            ws.tabs
                .get_mut(tab_idx)
                .ok_or_else(|| std::io::Error::other("plugin overlay tab disappeared"))?
                .zoomed = true;
            self.overlay_panes.insert(
                new_pane.pane_id,
                super::OverlayPaneState {
                    ws_idx,
                    tab_idx,
                    previous_focus,
                    previous_zoomed,
                    temp_files,
                },
            );
            (tab_idx, new_pane, ws.id.clone())
        };

        let new_focus_target = crate::app::state::PaneFocusTarget {
            workspace_id,
            pane_id: new_pane.pane_id,
        };
        if previous_focus_target.as_ref() != Some(&new_focus_target) {
            self.state.previous_pane_focus = previous_focus_target;
        }
        self.state.switch_workspace_tab(ws_idx, tab_idx);
        self.state.mode = Mode::Terminal;
        Ok((ws_idx, new_pane))
    }
}

fn write_scrollback_temp_file(content: &str) -> io::Result<std::path::PathBuf> {
    let mut last_collision = None;
    for attempt in 0..16 {
        let path = unique_scrollback_path(attempt);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(content.as_bytes())?;
                return Ok(path);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                last_collision = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_collision.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to create unique scrollback temp file",
        )
    }))
}

fn unique_scrollback_path(attempt: u32) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "herdr-scrollback-{}-{nanos}-{attempt}.txt",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    fn test_app() -> crate::app::App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        crate::app::App::new(
            &crate::config::Config::default(),
            crate::app::AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        )
    }

    fn binding(action: crate::config::CustomCommandAction) -> crate::config::CustomCommandKeybind {
        crate::config::CustomCommandKeybind {
            bindings: crate::config::ActionKeybinds::prefix("z"),
            label: "prefix+z".into(),
            command: "secret-command --token hidden".into(),
            action,
            description: Some("safe description".into()),
            width: None,
            height: None,
        }
    }

    fn install(app: &mut crate::app::App, binding: crate::config::CustomCommandKeybind) {
        app.endpoint_commands = super::EndpointCommandRegistry::new(&[binding]);
    }

    #[test]
    fn manifest_exposes_opaque_ids_without_command_text() {
        let mut app = test_app();
        install(&mut app, binding(crate::config::CustomCommandAction::Shell));
        let manifest = app.client_shell_command_manifest();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].binding_label, "prefix+z");
        assert_eq!(manifest[0].binding_labels, ["prefix+z"]);
        assert_eq!(manifest[0].description.as_deref(), Some("safe description"));
        assert!(!format!("{:?}", manifest).contains("secret-command"));
        assert_eq!(
            app.resolve_client_shell_command(&manifest[0].command_id)
                .map(|binding| binding.command),
            Some("secret-command --token hidden".into())
        );
    }

    fn scoped_app(
        action: crate::config::CustomCommandAction,
    ) -> (crate::app::App, crate::api::schema::CommandExecuteParams) {
        let mut app = test_app();
        app.state.workspaces = vec![
            crate::workspace::Workspace::test_new("target"),
            crate::workspace::Workspace::test_new("other"),
        ];
        app.state.ensure_test_terminals();
        app.state.active = Some(1);
        let mut configured = binding(action);
        configured.command = crate::app::exiting_test_command().into();
        install(&mut app, configured);
        let params = crate::api::schema::CommandExecuteParams {
            command_id: app.command_manifest()[0].command_id.clone(),
            target: app.command_pane_target(0, app.state.workspaces[0].tabs[0].root_pane),
            selection: None,
        };
        (app, params)
    }

    #[test]
    fn scoped_command_rejects_stale_identity_and_missing_context_without_changing_focus() {
        for field in ["workspace", "tab", "pane", "terminal", "command", "missing"] {
            let (mut app, mut params) = scoped_app(crate::config::CustomCommandAction::Shell);
            let before = app.session_snapshot();
            match field {
                "workspace" => {
                    params.target.as_mut().unwrap().workspace_id = app.public_workspace_id(1)
                }
                "tab" => params.target.as_mut().unwrap().tab_id = app.public_tab_id(1, 0).unwrap(),
                "pane" => params.target.as_mut().unwrap().pane_id = "stale".into(),
                "terminal" => params.target.as_mut().unwrap().terminal_id = "replaced".into(),
                "command" => params.command_id = "stale".into(),
                _ => params.target = None,
            }
            let response = app.handle_command_execute("scoped".into(), params);
            let error: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();
            assert!(error.error.code.starts_with("command_"));
            assert_eq!(app.session_snapshot(), before);
            assert!(app.detached_process_children.is_empty());
        }
    }

    #[tokio::test]
    async fn scoped_command_reports_shell_execution_in_explicit_and_empty_global_contexts() {
        use crate::api::schema::{CommandEffect, ResponseResult, SuccessResponse};
        for global in [false, true] {
            let (mut app, mut params) = scoped_app(crate::config::CustomCommandAction::Shell);
            if global {
                app.state.workspaces.clear();
                app.state.active = None;
                params.target = None;
            }
            let response: SuccessResponse =
                serde_json::from_str(&app.handle_command_execute("shell".into(), params)).unwrap();
            assert_eq!(
                response.result,
                ResponseResult::CommandExecuted {
                    effect: CommandEffect::ShellStarted {}
                }
            );
            assert_eq!(app.detached_process_children.len(), 1);
            for child in &mut app.detached_process_children {
                assert!(child.wait().unwrap().success());
            }
            assert_eq!(app.state.active, if global { None } else { Some(0) });
        }
    }

    #[tokio::test]
    async fn scoped_command_validates_selection_before_changing_focus() {
        let (mut app, mut params) = scoped_app(crate::config::CustomCommandAction::PluginAction);
        let target = params.target.as_ref().unwrap();
        let pane = app.state.workspaces[0].tabs[0].root_pane;
        let terminal = app.state.workspaces[0].terminal_id(pane).cloned().unwrap();
        app.terminal_runtimes.insert(
            terminal,
            crate::terminal::TerminalRuntime::test_with_screen_bytes(80, 24, b"selection"),
        );
        params.selection = Some(crate::api::schema::PaneSelectionReadParams {
            pane_id: target.pane_id.clone(),
            anchor: crate::api::schema::PaneTextPoint { row: 0, col: 0 },
            cursor: crate::api::schema::PaneTextPoint { row: 0, col: 3 },
            content_revision: Some(u64::MAX),
        });
        let before = app.session_snapshot();
        let error: crate::api::schema::ErrorResponse =
            serde_json::from_str(&app.handle_command_execute("selection".into(), params)).unwrap();
        assert_eq!(error.error.code, "stale_content");
        assert_eq!(app.session_snapshot(), before);
        assert!(app.state.plugin_command_logs.is_empty());
        for (_, runtime) in app.terminal_runtimes.drain() {
            runtime.shutdown();
        }
    }

    #[tokio::test]
    async fn scoped_command_preserves_existing_popup_and_focus_on_rejection() {
        let (mut app, params) = scoped_app(crate::config::CustomCommandAction::Popup);
        let (runtime, _) = crate::terminal::TerminalRuntime::test_with_channel_and_scrollback_bytes(
            40,
            12,
            0,
            b"EXISTING",
            4,
        );
        app.install_test_popup_runtime(runtime);
        let popup = app.state.popup_pane.clone();
        let before = app.session_snapshot();
        let error: crate::api::schema::ErrorResponse =
            serde_json::from_str(&app.handle_command_execute("existing".into(), params)).unwrap();
        assert_eq!(error.error.code, "popup_already_open");
        assert_eq!(app.session_snapshot(), before);
        assert_eq!(app.state.popup_pane, popup);
        for (_, runtime) in app.terminal_runtimes.drain() {
            runtime.shutdown();
        }
    }

    #[tokio::test]
    async fn scoped_command_results_identify_produced_pane_and_popup_before_later_focus_changes() {
        use crate::api::schema::{CommandEffect, ResponseResult, SuccessResponse};
        for action in [
            crate::config::CustomCommandAction::Pane,
            crate::config::CustomCommandAction::Popup,
        ] {
            let (mut app, params) = scoped_app(action);
            let source = params.target.clone().unwrap();
            let response = app.handle_command_execute("created".into(), params);
            let response: SuccessResponse = serde_json::from_str(&response).unwrap();
            let ResponseResult::CommandExecuted { effect } = response.result else {
                panic!("execution result")
            };
            app.state.active = Some(1);
            match effect {
                CommandEffect::PaneCreated { pane } => {
                    assert_eq!(pane.workspace_id, source.workspace_id);
                    assert_eq!(pane.tab_id, source.tab_id);
                    assert_ne!(pane.pane_id, source.pane_id);
                    assert_ne!(pane.terminal_id, source.terminal_id);
                    let (workspace, id) = app.parse_pane_id(&pane.pane_id).unwrap();
                    assert_eq!(app.command_pane_target(workspace, id), Some(pane));
                }
                CommandEffect::PopupOpened { popup } => {
                    assert_eq!(popup.owner_workspace_id, source.workspace_id);
                    assert_eq!(popup.owner_tab_id, source.tab_id);
                    let state = app.state.popup_pane.as_ref().unwrap();
                    assert_eq!(state.owner_tab_id, popup.owner_tab_id);
                    assert_eq!(state.terminal_id.as_str(), popup.terminal_id);
                    assert_ne!(popup.terminal_id, source.terminal_id);
                }
                _ => panic!("wrong command effect"),
            }
            for (_, runtime) in app.terminal_runtimes.drain() {
                runtime.shutdown();
            }
        }
    }

    #[test]
    fn public_command_catalog_preserves_registry_order_without_executables_or_focus() {
        use crate::api::schema::{
            CommandAction, EmptyParams, Method, Request, ResponseResult, SuccessResponse,
        };
        let mut app = test_app();
        let actions = [
            crate::config::CustomCommandAction::Shell,
            crate::config::CustomCommandAction::Pane,
            crate::config::CustomCommandAction::Popup,
            crate::config::CustomCommandAction::PluginAction,
        ];
        app.endpoint_commands = super::EndpointCommandRegistry::new(&actions.map(binding));
        let before = app.session_snapshot();
        let request = Request {
            id: "catalog".into(),
            method: Method::CommandList(EmptyParams::default()),
        };
        assert!(!crate::api::request_changes_ui(&request));
        let encoded = app.handle_api_request(request);
        assert!(!encoded.contains("secret-command"));
        assert!(!encoded.contains("hidden"));
        let response: SuccessResponse = serde_json::from_str(&encoded).unwrap();
        let ResponseResult::CommandList { commands } = response.result else {
            panic!("expected command catalog")
        };
        let projected = app.client_shell_command_manifest();
        assert_eq!(
            commands
                .iter()
                .map(|c| c.command_id.as_str())
                .collect::<Vec<_>>(),
            projected
                .iter()
                .map(|c| c.command_id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            commands.iter().map(|c| c.action).collect::<Vec<_>>(),
            [
                CommandAction::Shell,
                CommandAction::Pane,
                CommandAction::Popup,
                CommandAction::PluginAction
            ]
        );
        assert!(commands.iter().all(|c| c.binding_labels == ["prefix+z"]
            && c.description.as_deref() == Some("safe description")));
        assert_eq!(app.session_snapshot(), before);
        assert_eq!(app.command_manifest(), commands);
    }

    #[test]
    fn stale_command_id_is_rejected_after_definition_changes() {
        let mut app = test_app();
        install(&mut app, binding(crate::config::CustomCommandAction::Shell));
        let old_id = app.client_shell_command_manifest()[0].command_id.clone();
        let mut replacement = binding(crate::config::CustomCommandAction::Shell);
        replacement.command = "replacement-command".into();
        install(&mut app, replacement);

        let response = app.handle_command_invoke(
            "request-1".into(),
            crate::api::schema::CommandInvokeParams {
                command_id: old_id,
                workspace_id: None,
                tab_id: None,
                pane_id: None,
                selection: None,
            },
        );
        let error: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(error.error.code, "command_not_found");
    }

    #[test]
    fn foreground_keybinding_projection_cannot_remap_command_ids() {
        let mut app = test_app();
        install(&mut app, binding(crate::config::CustomCommandAction::Shell));
        let command_id = app.client_shell_command_manifest()[0].command_id.clone();
        let mut foreground_binding = binding(crate::config::CustomCommandAction::Shell);
        foreground_binding.command = "different-foreground-command".into();
        app.state.keybinds.custom_commands = vec![foreground_binding];

        assert_eq!(
            app.resolve_client_shell_command(&command_id)
                .map(|binding| binding.command),
            Some("secret-command --token hidden".into())
        );
    }

    #[test]
    fn command_ids_do_not_alias_across_endpoint_restarts() {
        let mut old_app = test_app();
        install(
            &mut old_app,
            binding(crate::config::CustomCommandAction::Shell),
        );
        let old_id = old_app.client_shell_command_manifest()[0]
            .command_id
            .clone();

        let mut replacement_app = test_app();
        let mut replacement = binding(crate::config::CustomCommandAction::Shell);
        replacement.command = "replacement-command".into();
        install(&mut replacement_app, replacement);
        assert_ne!(
            replacement_app.client_shell_command_manifest()[0].command_id,
            old_id
        );
        let response = replacement_app.handle_command_invoke(
            "request-1".into(),
            crate::api::schema::CommandInvokeParams {
                command_id: old_id,
                workspace_id: None,
                tab_id: None,
                pane_id: None,
                selection: None,
            },
        );
        let error: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(error.error.code, "command_not_found");
    }

    #[tokio::test]
    async fn plugin_command_rejects_stale_client_selection_before_invocation() {
        let mut app = test_app();
        let workspace = crate::workspace::Workspace::test_new("plugin-selection");
        let pane_id = workspace.tabs[0].root_pane;
        let terminal_id = workspace.terminal_id(pane_id).cloned().unwrap();
        app.state.workspaces = vec![workspace];
        app.state.ensure_test_terminals();
        app.state.active = Some(0);
        app.state.selected = 0;
        app.terminal_runtimes.insert(
            terminal_id,
            crate::terminal::TerminalRuntime::test_with_screen_bytes(80, 24, b"selected text\n"),
        );
        let mut plugin = binding(crate::config::CustomCommandAction::PluginAction);
        plugin.command = "missing.plugin-action".into();
        install(&mut app, plugin);
        let command_id = app.client_shell_command_manifest()[0].command_id.clone();
        let workspace_id = app.public_workspace_id(0);
        let tab_id = app.public_tab_id(0, 0).unwrap();
        let pane_id = app.public_pane_id(0, pane_id).unwrap();

        let response = app.handle_command_invoke(
            "request-selection".into(),
            crate::api::schema::CommandInvokeParams {
                command_id,
                workspace_id: Some(workspace_id),
                tab_id: Some(tab_id),
                pane_id: Some(pane_id.clone()),
                selection: Some(crate::api::schema::PaneSelectionReadParams {
                    pane_id,
                    anchor: crate::api::schema::PaneTextPoint { row: 0, col: 0 },
                    cursor: crate::api::schema::PaneTextPoint { row: 0, col: 7 },
                    content_revision: Some(u64::MAX),
                }),
            },
        );

        let error: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(error.error.code, "stale_content");
    }

    #[cfg(unix)]
    #[test]
    fn shell_command_invocation_executes_endpoint_owned_definition() {
        let mut app = test_app();
        let path = std::path::PathBuf::from(format!(
            "/var/tmp/herdr-command-invoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&path);
        let mut command = binding(crate::config::CustomCommandAction::Shell);
        command.command = format!("printf invoked > {}", path.display());
        install(&mut app, command);
        let command_id = app.client_shell_command_manifest()[0].command_id.clone();

        let response = app.handle_command_invoke(
            "request-1".into(),
            crate::api::schema::CommandInvokeParams {
                command_id,
                workspace_id: None,
                tab_id: None,
                pane_id: None,
                selection: None,
            },
        );
        let success: crate::api::schema::SuccessResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(success.result, crate::api::schema::ResponseResult::Ok {});
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invoked");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn popup_commands_are_advertised_without_exposing_the_command_text() {
        let mut app = test_app();
        install(&mut app, binding(crate::config::CustomCommandAction::Popup));

        let manifest = app.client_shell_command_manifest();
        assert_eq!(manifest.len(), 1);
        assert_eq!(
            manifest[0].action,
            crate::protocol::ClientShellCommandAction::Popup
        );
        assert!(!format!("{manifest:?}").contains("secret-command"));
    }
}
