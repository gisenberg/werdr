// The native runtime remains authoritative. These are the fields the browser consumes.
export interface Machine { id: string; label: string; enabled: boolean; target?: string; session?: string; platform?: 'posix' | 'windows' }
export type AgentStatus = 'unknown' | 'idle' | 'working' | 'blocked' | 'done';
export interface WorkspaceWorktree { repo_key: string; repo_name: string; repo_root: string; checkout_path: string; is_linked_worktree: boolean }
export interface Workspace { active_tab_id?: string; workspace_id: string; label: string; agent_status: AgentStatus; tokens?: Record<string, string>; worktree?: WorkspaceWorktree }
export interface Tab { tab_id: string; workspace_id: string; label: string; custom_label?: boolean }
export interface Pane { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; label?: string; title?: string; agent?: string; display_agent?: string; agent_status: AgentStatus; cwd?: string; revision?: number }
export interface Agent extends Pane { name?: string; state_change_seq: number; interactive_ready?: boolean; launch_pending?: boolean; state_labels?: Record<string, string>; tokens?: Record<string, string>; terminal_title?: string; terminal_title_stripped?: string; foreground_cwd?: string }
export interface AgentView { definition: { source: string; label?: string } | null; pane_ids: string[] }
export interface Snapshot { agent_view?: AgentView; focused_workspace_id?: string; version: string; protocol: number; workspaces: Workspace[]; tabs: Tab[]; panes: Pane[]; agents: Agent[]; layouts: { tab_id: string; focused_pane_id: string }[] }
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'disabled' | 'incompatible';
export interface HostView { machine: Machine; connection: ConnectionState; detail?: string; version?: string; lastSeen?: number; retryAt?: number; snapshot?: Snapshot }
export interface Notice { id: string; machineId: string; machineLabel: string; paneId: string; workspaceId: string; tabId: string; title: string; body: string; kind: 'attention' | 'finished'; created: number; read: boolean }
export interface FleetState { revision: number; hosts: HostView[]; notices: Notice[] }
export type FleetEvent = { type: 'fleet.snapshot'; state: FleetState } | { type: 'fleet.host'; revision: number; host: HostView } | { type: 'fleet.catalog'; revision: number; hosts: HostView[] } | { type: 'fleet.notices'; revision: number; notices: Notice[]; added?: Notice };
export interface SetupRequest { target: string; label: string; session: string; platform: 'posix' | 'windows' }
export interface SetupJob { id: string; machineId?: string; state: 'running' | 'complete' | 'failed' | 'cancelled'; target: string; label: string; platform: 'posix' | 'windows'; output: string; started: number; ended?: number; error?: string }
export const emptySnapshot = (): Snapshot => ({ version: '', protocol: 0, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] });
