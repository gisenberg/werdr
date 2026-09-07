import type { FleetState } from '../shared/fleet';
export interface NavigationTarget { kind: 'Workspace' | 'Tab' | 'Pane'; machine: string; workspace: string; tab: string; pane: string; label: string; disabled: boolean }
export function navigationTargets(fleet: FleetState): NavigationTarget[] {
  return fleet.hosts.flatMap(host => {
    const snapshot = host.snapshot; if (!snapshot) return [];
    const workspaceLabels = new Map(snapshot.workspaces.map(workspace => [workspace.workspace_id, workspace.label || workspace.workspace_id]));
    const tabLabels = new Map(snapshot.tabs.map(tab => [tab.tab_id, tab.label || tab.tab_id]));
    const context = { machine: host.machine.id, disabled: !host.machine.enabled };
    const suffix = (id: string) => ` [${host.machine.id}/${id}; ${host.connection.toUpperCase()}]`;
    return [
      ...snapshot.workspaces.map(workspace => ({ ...context, kind: 'Workspace' as const, workspace: workspace.workspace_id, tab: '', pane: '', label: `Workspace: ${host.machine.label} / ${workspaceLabels.get(workspace.workspace_id)}${suffix(workspace.workspace_id)}` })),
      ...snapshot.tabs.map(tab => ({ ...context, kind: 'Tab' as const, workspace: tab.workspace_id, tab: tab.tab_id, pane: '', label: `Tab: ${host.machine.label} / ${workspaceLabels.get(tab.workspace_id) || tab.workspace_id} / ${tabLabels.get(tab.tab_id)}${suffix(tab.tab_id)}` })),
      ...snapshot.panes.map(pane => ({ ...context, kind: 'Pane' as const, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, label: `Pane: ${host.machine.label} / ${workspaceLabels.get(pane.workspace_id) || pane.workspace_id} / ${tabLabels.get(pane.tab_id) || pane.tab_id} / ${pane.label || pane.title || pane.pane_id}${pane.cwd ? ` / ${pane.cwd}` : ''}${suffix(pane.pane_id)}` })),
    ];
  });
}
export function resolveNavigationTarget(fleet: FleetState, target: NavigationTarget): NavigationTarget | undefined {
  return navigationTargets(fleet).find(item => !item.disabled && item.kind === target.kind && item.machine === target.machine && item.workspace === target.workspace && item.tab === target.tab && item.pane === target.pane);
}
