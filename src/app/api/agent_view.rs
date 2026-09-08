use crate::api::schema::{AgentViewClearParams, AgentViewInfo, AgentViewSetParams, ResponseResult};
use crate::app::App;

use super::responses::{encode_error, encode_success};

impl App {
    pub(super) fn handle_agent_view_get(&self, id: String) -> String {
        encode_success(
            id,
            ResponseResult::AgentViewState {
                view: self.agent_view_info(),
            },
        )
    }

    pub(crate) fn agent_view_info(&self) -> AgentViewInfo {
        AgentViewInfo {
            definition: self.state.agent_view_override.clone(),
            pane_ids: crate::app::agent_view::agent_view_entries(&self.state)
                .into_iter()
                .filter_map(|entry| self.public_pane_id(entry.ws_idx, entry.pane_id))
                .collect(),
        }
    }

    pub(super) fn handle_agent_view_set(
        &mut self,
        id: String,
        mut params: AgentViewSetParams,
    ) -> String {
        if let Err(message) = crate::app::agent_view::validate_agent_view(&mut params) {
            return encode_error(id, "invalid_agent_view", message);
        }
        if let Some(plugin_id) = params.source.strip_prefix("plugin:") {
            let Some(plugin_id) = super::plugins::normalize_plugin_id(plugin_id) else {
                return encode_error(
                    id,
                    "invalid_agent_view",
                    "plugin-owned agent view source has an invalid plugin id",
                );
            };
            let Some(plugin) = self.state.installed_plugins.get(&plugin_id) else {
                return encode_error(id, "plugin_not_found", "plugin not found");
            };
            if !plugin.enabled {
                return encode_error(id, "plugin_disabled", "plugin is disabled");
            }
        }
        let source = params.source.clone();
        let label = params.label.clone();
        self.replace_agent_view_override(Some(params));
        encode_success(
            id,
            ResponseResult::AgentView {
                active: true,
                source: Some(source),
                label,
            },
        )
    }

    pub(super) fn handle_agent_view_clear(
        &mut self,
        id: String,
        params: AgentViewClearParams,
    ) -> String {
        let source = match params.source {
            Some(source) => match crate::app::agent_view::validate_agent_view_source(&source) {
                Ok(source) => Some(source),
                Err(message) => return encode_error(id, "invalid_agent_view", message),
            },
            None => None,
        };
        if source.as_deref().is_none_or(|source| {
            self.state
                .agent_view_override
                .as_ref()
                .is_some_and(|active| active.source == source)
        }) {
            self.replace_agent_view_override(None);
        }
        let active = self.state.agent_view_override.as_ref();
        encode_success(
            id,
            ResponseResult::AgentView {
                active: active.is_some(),
                source: active.map(|view| view.source.clone()),
                label: active.and_then(|view| view.label.clone()),
            },
        )
    }

    pub(crate) fn clear_agent_view_for_source(&mut self, source: &str) -> bool {
        if self
            .state
            .agent_view_override
            .as_ref()
            .is_some_and(|active| active.source == source)
        {
            self.replace_agent_view_override(None);
            true
        } else {
            false
        }
    }

    fn replace_agent_view_override(&mut self, view: Option<AgentViewSetParams>) {
        if self.state.agent_view_override == view {
            return;
        }
        self.state.agent_view_override = view.clone();
        self.emit_event(crate::api::schema::EventEnvelope {
            event: crate::api::schema::EventKind::AgentViewChanged,
            data: crate::api::schema::EventData::AgentViewChanged { definition: view },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::schema::{
        AgentViewBuiltinField, AgentViewField, AgentViewFilter, AgentViewValue,
    };

    fn test_app() -> App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        App::new(
            &crate::config::Config::default(),
            crate::app::AppPolicy::TEST,
            None,
            api_rx,
            crate::api::EventHub::default(),
        )
    }

    fn working_view(source: &str) -> AgentViewSetParams {
        AgentViewSetParams {
            source: source.to_string(),
            label: Some("working".to_string()),
            filter: Some(AgentViewFilter::Eq {
                field: AgentViewField::Builtin(AgentViewBuiltinField::Status),
                value: AgentViewValue::String("working".to_string()),
            }),
            sort: Vec::new(),
        }
    }

    #[test]
    fn set_and_source_guarded_clear_replace_transient_view() {
        let mut app = test_app();

        let set = app.handle_agent_view_set("set".to_string(), working_view("example.views"));
        let set: crate::api::schema::SuccessResponse = serde_json::from_str(&set).unwrap();
        assert_eq!(
            set.result,
            ResponseResult::AgentView {
                active: true,
                source: Some("example.views".to_string()),
                label: Some("working".to_string()),
            }
        );
        assert_eq!(
            app.state
                .agent_view_override
                .as_ref()
                .map(|view| view.source.as_str()),
            Some("example.views")
        );

        app.handle_agent_view_clear(
            "wrong-source".to_string(),
            AgentViewClearParams {
                source: Some("other.views".to_string()),
            },
        );
        assert!(app.state.agent_view_override.is_some());

        app.handle_agent_view_clear(
            "right-source".to_string(),
            AgentViewClearParams {
                source: Some("example.views".to_string()),
            },
        );
        assert!(app.state.agent_view_override.is_none());
    }

    #[test]
    fn agent_view_get_and_snapshot_share_projection_without_mutation() {
        let mut app = test_app();
        app.state.workspaces = vec![crate::workspace::Workspace::test_new("view")];
        app.state.ensure_test_terminals();
        let pane = app.state.workspaces[0].tabs[0].root_pane;
        let terminal = app.state.workspaces[0].tabs[0].panes[&pane]
            .attached_terminal_id
            .clone();
        let state = app.state.terminals.get_mut(&terminal).unwrap();
        state.detected_agent = Some(crate::detect::Agent::Claude);
        state.state = crate::detect::AgentState::Working;
        app.handle_agent_view_set("set".into(), working_view("test"));
        let sequence = app.event_hub.current_sequence();
        let request = crate::api::schema::Request {
            id: "get".into(),
            method: crate::api::schema::Method::AgentViewGet(Default::default()),
        };
        assert!(!crate::api::request_changes_ui(&request));
        let response: crate::api::schema::SuccessResponse =
            serde_json::from_str(&app.handle_api_request(request)).unwrap();
        let ResponseResult::AgentViewState { view } = response.result else {
            panic!("expected view");
        };
        assert_eq!(view.pane_ids, vec![app.public_pane_id(0, pane).unwrap()]);
        assert_eq!(app.session_snapshot().agent_view, Some(view));
        assert_eq!(app.event_hub.current_sequence(), sequence);
        app.state.terminals.get_mut(&terminal).unwrap().state = crate::detect::AgentState::Idle;
        assert!(app.agent_view_info().pane_ids.is_empty());
    }

    #[test]
    fn agent_view_events_only_report_definition_changes() {
        let mut app = test_app();
        app.handle_agent_view_set("set".into(), working_view("test"));
        app.handle_agent_view_set("same".into(), working_view("test"));
        app.handle_agent_view_clear(
            "mismatch".into(),
            AgentViewClearParams {
                source: Some("other".into()),
            },
        );
        assert_eq!(app.event_hub.current_sequence(), 1);
        app.clear_agent_view_for_source("test");
        let events = app.event_hub.events_after(0);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0].1.data,
            crate::api::schema::EventData::AgentViewChanged {
                definition: Some(_)
            }
        ));
        assert!(matches!(
            events[1].1.data,
            crate::api::schema::EventData::AgentViewChanged { definition: None }
        ));
    }

    #[test]
    fn invalid_view_does_not_replace_active_view() {
        let mut app = test_app();
        app.handle_agent_view_set("set".to_string(), working_view("example.views"));

        let mut invalid = working_view("example.other");
        invalid.filter = Some(AgentViewFilter::Any {
            filters: Vec::new(),
        });
        let response = app.handle_agent_view_set("invalid".to_string(), invalid);
        let response: crate::api::schema::ErrorResponse = serde_json::from_str(&response).unwrap();

        assert_eq!(response.error.code, "invalid_agent_view");
        assert_eq!(
            app.state
                .agent_view_override
                .as_ref()
                .map(|view| view.source.as_str()),
            Some("example.views")
        );
    }
}
