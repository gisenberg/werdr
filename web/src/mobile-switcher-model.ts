import { emptySnapshot, type FleetState } from '../shared/fleet';
import type { Preferences } from '../shared/settings';
import type { ShortcutAction } from '../shared/shortcuts';
import { agentEntries } from './agent-entries';
import { workspaceEntries } from './workspace-groups';
import type { WorkspacePreview } from './navigate-preview';
import type { SwitcherSection } from './mobile-switcher';

export type MobileTargetKind = 'host' | 'workspace' | 'tab' | 'pane';
export type MobileMenuAction = 'host-settings' | 'manage-hosts' | 'activity' | 'commands' | 'refresh' | 'sign-out';
interface SwitcherContext {
  fleetState: FleetState;
  machineId: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  preferences: Preferences;
  preview?: Readonly<WorkspacePreview>;
}
interface SwitcherHandlers {
  target(kind: MobileTargetKind, machine: string, id: string): void;
  command(action: ShortcutAction): void;
  menu(action: MobileMenuAction): void;
}
/** Build the native switcher order only while its mobile surface is visible. */
export function mobileSwitcherSections({ fleetState, machineId, workspaceId, tabId, paneId, preferences, preview }: SwitcherContext, handlers: SwitcherHandlers): SwitcherSection[] {
  const host = fleetState.hosts.find(host => host.machine.id === machineId), snapshot = host?.snapshot || emptySnapshot();
  const online = host?.connection === 'online';
  const sections: SwitcherSection[] = [];
  if (fleetState.hosts.length > 1) sections.push({ id: 'hosts', label: 'HOSTS', items: fleetState.hosts.map(host => ({
    id: host.machine.id, label: host.machine.label, detail: `[${host.connection.toUpperCase()}] ${host.machine.target || host.machine.label}`,
    active: host.machine.id === machineId, unavailable: !host.machine.enabled || host.connection !== 'online', run: () => handlers.target('host', host.machine.id, host.machine.id),
  })) });
  const agents = agentEntries(fleetState.hosts, preferences.agentSort, 'all', '');
  const view = snapshot.agent_view?.definition;
  if (agents.length || view) sections.push({ id: 'agents', label: view ? `AGENTS / ${view.label || 'FILTERED'}` : 'AGENTS', empty: 'No matching agents.', items: agents.map(({ host, agent, workspaceLabel, tabLabel }) => ({
    id: `${host.machine.id}/${agent.pane_id}`, label: `${host.machine.label} / ${workspaceLabel}`,
    detail: [tabLabel, `[${agent.state_labels?.[agent.agent_status] || (agent.agent_status === 'unknown' ? 'idle' : agent.agent_status).toUpperCase()}] ${agent.display_agent || agent.name || agent.agent || agent.pane_id}`, host.connection === 'online' ? undefined : host.connection.toUpperCase()].filter(Boolean).join(' / '),
    active: host.machine.id === machineId && agent.pane_id === paneId, unavailable: !host.machine.enabled || host.connection !== 'online', run: () => handlers.target('pane', host.machine.id, agent.pane_id),
  })) });
  sections.push({ id: 'workspaces', label: 'WORKSPACES', items: [
    { id: 'new-workspace', label: '[+] NEW WORKSPACE', unavailable: !online, run: () => handlers.command('new_workspace') },
    ...fleetState.hosts.flatMap(host => {
      const tabCounts = new Map<string, number>();
      for (const tab of host.snapshot?.tabs || []) tabCounts.set(tab.workspace_id, (tabCounts.get(tab.workspace_id) || 0) + 1);
      return workspaceEntries(host.machine, host.snapshot?.workspaces || [], new Set(), host.machine.id === machineId ? workspaceId : '', '').map(entry => ({
        id: `${host.machine.id}/${entry.workspace.workspace_id}`, label: `${entry.indented ? entry.lastChild ? '└─ ' : '├─ ' : ''}${host.machine.label} / ${entry.workspace.label || entry.workspace.workspace_id}`,
        detail: `${entry.workspace.worktree?.repo_name || 'shell'} / ${tabCounts.get(entry.workspace.workspace_id) || 0} TABS / [${host.connection === 'online' ? entry.status.toUpperCase() : host.connection.toUpperCase()}]`,
        active: host.machine.id === machineId && entry.workspace.workspace_id === workspaceId,
        preview: preview?.machine === host.machine.id && preview.workspace === entry.workspace.workspace_id,
        unavailable: !host.machine.enabled || host.connection !== 'online', run: () => handlers.target('workspace', host.machine.id, entry.workspace.workspace_id),
      }));
    }),
  ] });
  if (workspaceId) sections.push({ id: 'tabs', label: 'TABS', items: [
    { id: 'new-tab', label: '[+] NEW TAB', unavailable: !online, run: () => handlers.command('new_tab') },
    ...snapshot.tabs.filter(tab => tab.workspace_id === workspaceId).map((tab, index) => ({ id: tab.tab_id, label: `${index + 1} / ${tab.label || tab.tab_id}`, active: tab.tab_id === tabId, unavailable: !online, run: () => handlers.target('tab', machineId, tab.tab_id) })),
  ] });
  const menu = (label: string, action: MobileMenuAction, unavailable = false) => ({ id: action, label, unavailable, run: () => handlers.menu(action) });
  sections.push({ id: 'menu', label: 'MENU', items: [
    { id: 'settings', label: 'SETTINGS', run: () => handlers.command('settings') },
    { id: 'help', label: 'KEYBOARD SHORTCUTS', run: () => handlers.command('help') },
    menu('HOST SETTINGS', 'host-settings', !online), menu('MANAGE HOSTS', 'manage-hosts'),
    menu('ACTIVITY', 'activity'), menu('COMMANDS', 'commands'), menu('REFRESH HOSTS', 'refresh'), menu('SIGN OUT', 'sign-out'),
  ] });
  return sections;
}
