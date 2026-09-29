import type { AgentStatus, HostView } from '../shared/fleet';

const priority: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

export function agentEntries(hosts: HostView[], sort: 'native' | 'priority', filter: string, query: string) {
  const needle = query.trim().toLowerCase();
  const hasView = hosts.some(host => host.snapshot?.agent_view?.definition);
  const entries = hosts.flatMap((host, hostIndex) => {
    const workspaces = new Map(host.snapshot?.workspaces.map(workspace => [workspace.workspace_id, workspace.label]));
    const tabs = new Map(host.snapshot?.tabs.map(tab => [tab.tab_id, tab]));
    const tabCounts = new Map<string, number>();
    for (const tab of tabs.values()) tabCounts.set(tab.workspace_id, (tabCounts.get(tab.workspace_id) || 0) + 1);
    const panes = new Map(host.snapshot?.panes.map(pane => [pane.pane_id, pane.label]));
    const view = host.snapshot?.agent_view;
    const order = new Map(view?.pane_ids.map((id, index) => [id, index]));
    const agents = host.snapshot?.agents || [];
    return agents.filter(agent => !view?.definition || order.has(agent.pane_id)).map(agent => {
      const tab = tabs.get(agent.tab_id);
      const context = `${host.machine.label} / ${workspaces.get(agent.workspace_id) || agent.workspace_id} / ${tab?.label || agent.tab_id}`;
      const title = [context, agent.name, agent.display_agent || agent.agent, agent.terminal_title_stripped || agent.terminal_title || agent.title, agent.foreground_cwd || agent.cwd].filter(Boolean).join('\n');
      return { host, hostIndex, viewIndex: order.get(agent.pane_id) ?? 0, agent, title, workspaceLabel: workspaces.get(agent.workspace_id) || agent.workspace_id, tabLabel: tab?.custom_label === false && tabCounts.get(agent.workspace_id) === 1 ? undefined : tab?.label, paneLabel: panes.get(agent.pane_id) };
    });
  }).filter(({ agent, title }) => (agent.agent || agent.display_agent || agent.name || agent.launch_pending || agent.agent_status !== 'unknown')
    && [title, agent.pane_id, agent.agent, agent.title, agent.terminal_title, agent.cwd, ...Object.values(agent.tokens || {}), ...Object.values(agent.state_labels || {})].filter(Boolean).join('\n').toLowerCase().includes(needle)
    && (filter === 'all' || filter === agent.agent_status || filter === 'done' && agent.agent_status === 'idle'));
  entries.sort((a, b) => {
    // A native override owns ordering within its host. Keep fleet groups stable
    // whenever one is active so global priority cannot undo the native view.
    if (hasView && a.hostIndex !== b.hostIndex) return a.hostIndex - b.hostIndex;
    if (a.hostIndex === b.hostIndex && a.host.snapshot?.agent_view?.definition) return a.viewIndex - b.viewIndex;
    if (sort !== 'priority') return 0;
    return priority[b.agent.agent_status] - priority[a.agent.agent_status]
      || a.hostIndex - b.hostIndex
      || (b.agent.state_change_seq || 0) - (a.agent.state_change_seq || 0);
  });
  return entries;
}
