import type { AgentStatus, Machine, Workspace } from '../shared/fleet';

// Native reference: client/shell/sidebar.rs workspace_entries and
// displayed_workspace_status. Group only authoritative repository membership.
export interface WorkspaceEntry {
  workspace: Workspace;
  indented: boolean;
  lastChild: boolean;
  status: AgentStatus;
  group?: { key: string; collapsed: boolean; members: Workspace[] };
}
export function workspaceGroupKey(machine: Machine, repo: string): string {
  return JSON.stringify([machine.id, machine.target || '', machine.session || '', repo]);
}
export function workspaceGroup(workspaces: Workspace[], workspace: Workspace | undefined): Workspace[] | undefined {
  if (!workspace?.worktree || workspace.worktree.is_linked_worktree) return;
  const members = workspaces.filter(item => item.worktree?.repo_key === workspace.worktree!.repo_key);
  return members.length >= 2 ? members : undefined;
}
const priority: Record<AgentStatus, number> = { unknown: 0, idle: 1, working: 2, done: 3, blocked: 4 };
export function workspaceEntries(machine: Machine, workspaces: Workspace[], collapsed: ReadonlySet<string>, active: string, query = ''): WorkspaceEntry[] {
  const groups = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    const key = workspace.worktree?.repo_key;
    if (key !== undefined) { const members = groups.get(key) || []; members.push(workspace); groups.set(key, members); }
  }
  const parents = new Map<string, Workspace>();
  for (const [key, members] of groups) {
    const parent = members.length >= 2 && members.find(item => !item.worktree!.is_linked_worktree);
    if (parent) parents.set(key, parent);
  }
  const emitted = new Set<string>(), entries: WorkspaceEntry[] = [];
  const matches = (workspace: Workspace) => `${machine.label} ${workspace.label} ${workspace.workspace_id} ${workspace.worktree?.repo_name || ''} ${workspace.worktree?.checkout_path || ''}`.toLowerCase().includes(query);
  for (const workspace of workspaces) {
    const members = workspace.worktree && groups.get(workspace.worktree.repo_key);
    const parent = workspace.worktree && parents.get(workspace.worktree.repo_key);
    if (!members || !parent) {
      if (matches(workspace)) entries.push({ workspace, indented: false, lastChild: false, status: workspace.agent_status });
      continue;
    }
    const key = workspaceGroupKey(machine, parent.worktree!.repo_key);
    if (emitted.has(key)) continue;
    emitted.add(key);
    if (!members.some(matches)) continue;
    const hidden = collapsed.has(key);
    const status = hidden ? members.reduce((status, item) => priority[item.agent_status] > priority[status] ? item.agent_status : status, parent.agent_status) : parent.agent_status;
    entries.push({ workspace: parent, indented: false, lastChild: false, status, group: { key, collapsed: hidden, members } });
    const children = members.filter(item => item !== parent && (query ? matches(item) || matches(parent) : !hidden || item.workspace_id === active));
    children.forEach((workspace, index) => entries.push({ workspace, indented: true, lastChild: index === children.length - 1, status: workspace.agent_status }));
  }
  return entries;
}
