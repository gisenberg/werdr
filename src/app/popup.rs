use std::path::PathBuf;

use crate::app::{App, Mode};
use crate::layout::PaneId;
use crate::pane::PaneLaunchEnv;
use crate::popup_size::{resolve_popup_geometry, PopupSize};
use crate::terminal::{TerminalId, TerminalRuntime, TerminalState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct PopupGeometry {
    pub width: Option<PopupSize>,
    pub height: Option<PopupSize>,
}

impl App {
    pub(crate) fn popup_session_info(&self) -> Option<crate::api::schema::CommandPopup> {
        let popup = self.state.popup_pane.as_ref()?;
        let (workspace, _) = self.parse_tab_id(&popup.owner_tab_id)?;
        Some(crate::api::schema::CommandPopup {
            terminal_id: popup.terminal_id.as_str().to_owned(),
            owner_workspace_id: self.public_workspace_id(workspace),
            owner_tab_id: popup.owner_tab_id.clone(),
            width: popup.width,
            height: popup.height,
        })
    }

    pub(crate) fn handle_popup_close_exact(
        &mut self,
        id: String,
        params: crate::api::schema::PopupCloseExactParams,
    ) -> String {
        use crate::app::api::responses::{encode_error, encode_success};
        let Some(popup) = self.state.popup_pane.as_ref() else {
            return encode_error(id, "popup_not_open", "no popup is open");
        };
        if popup.terminal_id.as_str() != params.terminal_id
            || popup.owner_tab_id != params.owner_tab_id
        {
            return encode_error(id, "popup_target_mismatch", "popup identity changed");
        }
        self.close_popup_pane();
        encode_success(id, crate::api::schema::ResponseResult::Ok {})
    }

    fn emit_popup_changed(&mut self) {
        self.emit_event(crate::api::schema::EventEnvelope {
            event: crate::api::schema::EventKind::PopupChanged,
            data: crate::api::schema::EventData::PopupChanged {},
        });
    }

    pub(crate) fn close_popup_pane(&mut self) -> bool {
        let Some(popup) = self.state.popup_pane.take() else {
            return false;
        };
        self.state
            .direct_attach_resize_locks
            .remove(&popup.terminal_id);
        self.state.terminals.remove(&popup.terminal_id);
        self.shutdown_terminal_runtime(popup.terminal_id);
        self.state.mode = if self.state.active.is_some() {
            Mode::Terminal
        } else {
            Mode::Navigate
        };
        self.render_dirty.request_generic();
        self.render_notify.notify_one();
        self.emit_popup_changed();
        true
    }

    pub(crate) fn spawn_popup_shell_command(
        &mut self,
        command: &str,
        cwd: Option<PathBuf>,
        extra_env: Vec<(String, String)>,
        geometry: PopupGeometry,
    ) -> std::io::Result<crate::api::schema::CommandPopup> {
        self.spawn_popup_command(
            None,
            cwd,
            extra_env,
            geometry,
            |pane_id, rows, cols, cwd, launch_env, app| {
                TerminalRuntime::spawn_shell_command(
                    pane_id,
                    rows,
                    cols,
                    cwd,
                    command,
                    launch_env,
                    crate::pane::AgentDetection::Disabled,
                    app.state.pane_scrollback_limit_bytes,
                    app.state.host_terminal_theme,
                    app.state.host_terminal_appearance,
                    app.event_tx.clone(),
                    app.render_notify.clone(),
                    app.render_dirty.clone(),
                )
                .map(|runtime| (runtime, None))
            },
        )
    }

    pub(crate) fn spawn_popup_argv_command(
        &mut self,
        argv: &[String],
        source: Option<(usize, PaneId)>,
        cwd: Option<PathBuf>,
        extra_env: Vec<(String, String)>,
        geometry: PopupGeometry,
    ) -> std::io::Result<crate::api::schema::CommandPopup> {
        self.spawn_popup_command(
            source,
            cwd,
            extra_env,
            geometry,
            |pane_id, rows, cols, cwd, launch_env, app| {
                TerminalRuntime::spawn_argv_command(
                    pane_id,
                    rows,
                    cols,
                    cwd,
                    argv,
                    launch_env,
                    crate::pane::AgentDetection::Disabled,
                    app.state.pane_scrollback_limit_bytes,
                    app.state.host_terminal_theme,
                    app.state.host_terminal_appearance,
                    app.event_tx.clone(),
                    app.render_notify.clone(),
                    app.render_dirty.clone(),
                )
                .map(|runtime| (runtime, Some(argv.to_vec())))
            },
        )
    }

    fn spawn_popup_command<F>(
        &mut self,
        source: Option<(usize, PaneId)>,
        cwd: Option<PathBuf>,
        extra_env: Vec<(String, String)>,
        geometry: PopupGeometry,
        spawn: F,
    ) -> std::io::Result<crate::api::schema::CommandPopup>
    where
        F: FnOnce(
            PaneId,
            u16,
            u16,
            PathBuf,
            &PaneLaunchEnv,
            &mut App,
        ) -> std::io::Result<(TerminalRuntime, Option<Vec<String>>)>,
    {
        if self.state.popup_pane.is_some() {
            return Err(std::io::Error::other("popup already open"));
        }
        let (ws_idx, focused_pane) = source
            .or_else(|| {
                let workspace = self.state.active?;
                Some((
                    workspace,
                    self.state.workspaces.get(workspace)?.focused_pane_id()?,
                ))
            })
            .ok_or_else(|| std::io::Error::other("no popup source pane"))?;
        let ws = self
            .state
            .workspaces
            .get(ws_idx)
            .ok_or_else(|| std::io::Error::other("popup source workspace disappeared"))?;
        let tab_index = ws
            .find_tab_index_for_pane(focused_pane)
            .ok_or_else(|| std::io::Error::other("popup source tab disappeared"))?;
        let active_tab = &ws.tabs[tab_index];
        let cwd = cwd.or_else(|| {
            active_tab.cwd_for_pane(focused_pane, &self.state.terminals, &self.terminal_runtimes)
        });
        let cwd = cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| "/".into()));
        let owner_tab_id = self
            .public_tab_id(ws_idx, tab_index)
            .ok_or_else(|| std::io::Error::other("popup owning tab disappeared"))?;
        let pane_id = PaneId::alloc();
        let terminal_id = TerminalId::alloc();
        let launch_env = PaneLaunchEnv::from_extra(extra_env).without_pane_identity();
        let terminal_area = if self.state.view.terminal_area.width >= 4
            && self.state.view.terminal_area.height >= 4
        {
            self.state.view.terminal_area
        } else {
            let (estimated_rows, estimated_cols) = self.state.estimate_pane_size();
            ratatui::layout::Rect::new(0, 0, estimated_cols, estimated_rows)
        };
        let Some(resolved_geometry) =
            resolve_popup_geometry(geometry.width, geometry.height, terminal_area)
        else {
            return Err(std::io::Error::other("terminal area too small for popup"));
        };
        let rows = resolved_geometry.inner.height;
        let cols = resolved_geometry.inner.width;
        let (runtime, launch_argv) = spawn(pane_id, rows, cols, cwd.clone(), &launch_env, self)?;
        let terminal = match launch_argv {
            Some(argv) => TerminalState::new(terminal_id.clone(), cwd).with_launch_argv(argv),
            None => TerminalState::new(terminal_id.clone(), cwd),
        };
        self.terminal_runtimes.insert(terminal_id.clone(), runtime);
        self.state.terminals.insert(terminal_id.clone(), terminal);
        let result = crate::api::schema::CommandPopup {
            terminal_id: terminal_id.as_str().to_owned(),
            owner_workspace_id: self.public_workspace_id(ws_idx),
            owner_tab_id: owner_tab_id.clone(),
            width: geometry.width,
            height: geometry.height,
        };
        self.state.popup_pane = Some(crate::app::state::PopupPaneState {
            owner_tab_id,
            pane_id,
            terminal_id,
            width: geometry.width,
            height: geometry.height,
        });
        if source.is_some() {
            self.state.focus_pane_in_workspace(ws_idx, focused_pane);
        }
        self.state.mode = Mode::Terminal;
        self.emit_popup_changed();
        Ok(result)
    }
}

#[cfg(test)]
impl App {
    pub(crate) fn install_test_popup_runtime(
        &mut self,
        runtime: TerminalRuntime,
    ) -> (PaneId, TerminalId) {
        let pane_id = PaneId::alloc();
        let terminal_id = TerminalId::alloc();
        self.terminal_runtimes.insert(terminal_id.clone(), runtime);
        self.state.terminals.insert(
            terminal_id.clone(),
            TerminalState::new(terminal_id.clone(), PathBuf::from("/popup")),
        );
        self.state.popup_pane = Some(crate::app::state::PopupPaneState {
            owner_tab_id: self
                .state
                .active
                .and_then(|ws_idx| {
                    self.public_tab_id(ws_idx, self.state.workspaces[ws_idx].active_tab_index())
                })
                .expect("test popup requires an owning tab"),
            pane_id,
            terminal_id: terminal_id.clone(),
            width: None,
            height: None,
        });
        (pane_id, terminal_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_popup() -> App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(
            &crate::config::Config::default(),
            crate::app::AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        app.state.workspaces = vec![crate::workspace::Workspace::test_new("popup")];
        app.state.active = Some(0);
        app.state.selected = 0;
        let terminal_id = TerminalId::alloc();
        app.state.terminals.insert(
            terminal_id.clone(),
            TerminalState::new(terminal_id.clone(), PathBuf::from("/popup")),
        );
        app.state.popup_pane = Some(crate::app::state::PopupPaneState {
            owner_tab_id: app.public_tab_id(0, 0).expect("test owning tab"),
            pane_id: PaneId::alloc(),
            terminal_id,
            width: None,
            height: None,
        });
        app
    }

    #[test]
    fn close_popup_uses_terminal_mode_with_active_workspace() {
        let mut app = app_with_popup();
        app.state.mode = Mode::Navigate;

        assert!(app.close_popup_pane());

        assert_eq!(app.state.mode, Mode::Terminal);
    }

    #[test]
    fn close_popup_uses_navigate_mode_without_active_workspace() {
        let mut app = app_with_popup();
        app.state.workspaces.clear();
        app.state.active = None;
        app.state.mode = Mode::Navigate;

        assert!(app.close_popup_pane());

        assert_eq!(app.state.mode, Mode::Navigate);
    }

    #[test]
    fn close_popup_clears_direct_attach_resize_lock() {
        let mut app = app_with_popup();
        let terminal_id = app.state.popup_pane.as_ref().unwrap().terminal_id.clone();
        app.state
            .direct_attach_resize_locks
            .insert(terminal_id.clone());

        assert!(app.close_popup_pane());

        assert!(!app.state.direct_attach_resize_locks.contains(&terminal_id));
    }

    #[test]
    fn popup_survives_background_workspace_removal() {
        let mut app = app_with_popup();
        app.state.workspaces.clear();
        app.state.active = None;

        app.state.assert_invariants_for_test();

        assert!(app.state.popup_pane.is_some());
    }

    #[test]
    fn popup_close_api_closes_only_active_popup() {
        let mut app = app_with_popup();
        let close = || crate::api::schema::Request {
            id: "close-popup".into(),
            method: crate::api::schema::Method::PopupClose(
                crate::api::schema::EmptyParams::default(),
            ),
        };

        let response = app.handle_api_request(close());
        let response: crate::api::schema::SuccessResponse =
            serde_json::from_str(&response).unwrap();
        assert_eq!(response.result, crate::api::schema::ResponseResult::Ok {});

        let response = app.handle_api_request(close());
        let response: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(response.error.code, "popup_not_open");
    }

    #[tokio::test]
    async fn popup_discovery_and_exact_close_follow_producer_lifecycle() {
        use crate::api::schema::{
            EmptyParams, EventKind, Method, PopupCloseExactParams, Request, ResponseResult,
            SuccessResponse,
        };
        let mut app = app_with_popup();
        app.close_popup_pane();
        let sequence = app.event_hub.current_sequence();
        let mut receivers = Vec::new();
        let mut spawn = |app: &mut App| {
            app.spawn_popup_command(
                None,
                None,
                Vec::new(),
                super::PopupGeometry::default(),
                |_, rows, cols, _, _, _| {
                    let (runtime, receiver) =
                        TerminalRuntime::test_with_channel_and_scrollback_bytes(
                            cols, rows, 0, b"POPUP", 4,
                        );
                    receivers.push(receiver);
                    Ok((runtime, None))
                },
            )
            .unwrap()
        };
        let first = spawn(&mut app);
        let first_pane = app.state.popup_pane.as_ref().unwrap().pane_id;
        let get = || Request {
            id: "get".into(),
            method: Method::PopupGet(EmptyParams::default()),
        };
        assert!(!crate::api::request_changes_ui(&get()));
        let result: SuccessResponse = serde_json::from_str(&app.handle_api_request(get())).unwrap();
        assert_eq!(
            result.result,
            ResponseResult::PopupSession {
                popup: Some(first.clone())
            }
        );
        app.handle_internal_event(crate::events::AppEvent::PaneDied {
            pane_id: first_pane,
        });
        assert!(app.popup_session_info().is_none());
        let second = spawn(&mut app);
        assert_ne!(first.terminal_id, second.terminal_id);
        // Delayed process-exit and browser-close messages cannot close a replacement.
        app.handle_internal_event(crate::events::AppEvent::PaneDied {
            pane_id: first_pane,
        });
        for stale in [
            PopupCloseExactParams {
                terminal_id: first.terminal_id.clone(),
                owner_tab_id: second.owner_tab_id.clone(),
            },
            PopupCloseExactParams {
                terminal_id: second.terminal_id.clone(),
                owner_tab_id: "wrong-tab".into(),
            },
        ] {
            let before = app.event_hub.current_sequence();
            let request = Request {
                id: "stale".into(),
                method: Method::PopupCloseExact(stale),
            };
            assert!(crate::api::request_changes_ui(&request));
            let response: crate::api::schema::ErrorResponse =
                serde_json::from_str(&app.handle_api_request(request)).unwrap();
            assert_eq!(response.error.code, "popup_target_mismatch");
            assert_eq!(app.popup_session_info(), Some(second.clone()));
            assert_eq!(app.event_hub.current_sequence(), before);
        }
        let response: SuccessResponse = serde_json::from_str(&app.handle_api_request(Request {
            id: "close".into(),
            method: Method::PopupCloseExact(PopupCloseExactParams {
                terminal_id: second.terminal_id,
                owner_tab_id: second.owner_tab_id,
            }),
        }))
        .unwrap();
        assert_eq!(response.result, ResponseResult::Ok {});
        let result: SuccessResponse = serde_json::from_str(&app.handle_api_request(get())).unwrap();
        assert_eq!(result.result, ResponseResult::PopupSession { popup: None });
        assert!(!app.close_popup_pane());
        let events = app.event_hub.events_after(sequence);
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| event.event == EventKind::PopupChanged)
                .count(),
            4
        );
    }
}
