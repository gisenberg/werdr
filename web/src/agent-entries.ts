import type { AgentStatus, HostView } from '../shared/fleet';

const priority: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

export function agentEntries(hosts: HostView[], sort: 'native' | 'priority', filter: string, query: string) {
  const needle = query.trim().toLowerCase();
  const entries = hosts.flatMap((host, hostIndex) => {
    const workspaces = new Map(host.snapshot?.workspaces.map(workspace => [workspace.workspace_id, workspace.label]));
    const tabs = new Map(host.snapshot?.tabs.map(tab => [tab.tab_id, tab.label]));
    const panes = new Map(host.snapshot?.panes.map(pane => [pane.pane_id, pane.label]));
    return (host.snapshot?.agents || []).map(agent => {
      const context = `${host.machine.label} / ${workspaces.get(agent.workspace_id) || agent.workspace_id} / ${tabs.get(agent.tab_id) || agent.tab_id}`;
      const title = [context, agent.name, agent.display_agent || agent.agent, agent.terminal_title_stripped || agent.terminal_title || agent.title, agent.foreground_cwd || agent.cwd].filter(Boolean).join('\n');
      return { host, hostIndex, agent, title, workspaceLabel: workspaces.get(agent.workspace_id) || agent.workspace_id, tabLabel: tabs.get(agent.tab_id), paneLabel: panes.get(agent.pane_id) };
    });
  }).filter(({ agent, title }) => (agent.agent || agent.display_agent || agent.name || agent.launch_pending || agent.agent_status !== 'unknown')
    && [title, agent.pane_id, agent.agent, agent.title, agent.terminal_title, agent.cwd, ...Object.values(agent.tokens || {}), ...Object.values(agent.state_labels || {})].filter(Boolean).join('\n').toLowerCase().includes(needle)
    && (filter === 'all' || filter === agent.agent_status || filter === 'done' && agent.agent_status === 'idle'));
  if (sort === 'priority') entries.sort((a, b) => priority[b.agent.agent_status] - priority[a.agent.agent_status]
    // Native sequence counters are scoped to one runtime, not comparable across hosts.
    || a.hostIndex - b.hostIndex
    || (b.agent.state_change_seq || 0) - (a.agent.state_change_seq || 0));
  return entries;
}
