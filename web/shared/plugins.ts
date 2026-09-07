export type PluginPlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed';
export type PluginContext = 'global' | 'workspace' | 'tab' | 'pane' | 'selection';
export interface PluginEntry { id: string; title: string; description?: string; command: string[]; platforms?: string[] }
export interface PluginAction extends PluginEntry { contexts?: PluginContext[] }
export interface PluginPane extends PluginEntry { placement: PluginPlacement; width?: number | string; height?: number | string }
export interface Plugin {
  plugin_id: string; name: string; version: string; min_herdr_version: string; enabled: boolean;
  description?: string; manifest_path: string; plugin_root: string; platforms?: string[]; warnings?: string[];
  actions?: PluginAction[]; panes?: PluginPane[]; build?: { command: string[] }[]; startup?: { command: string[] }[]; events?: { on: string; command: string[] }[];
  source: { kind: 'local' | 'github'; owner?: string; repo?: string; requested_ref?: string; resolved_commit?: string };
}
export interface PluginLog {
  log_id: string; plugin_id: string; action_id?: string; event?: string; command: string[];
  status: 'running' | 'succeeded' | 'failed'; started_unix_ms: number; finished_unix_ms?: number;
  exit_code?: number; stdout?: string; stderr?: string; error?: string;
}
