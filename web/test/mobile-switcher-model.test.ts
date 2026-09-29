import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, type FleetState } from '../shared/fleet.ts';
import { defaults } from '../shared/settings.ts';
import { mobileSwitcherSections } from '../src/mobile-switcher-model.ts';
import { workspaceGroupKey } from '../src/workspace-groups.ts';
function model() {
  const fleet: FleetState = { generation: 'fixture', revision: 1, notices: [], hosts: [{ machine: { id: 'one', label: 'Same host label', enabled: true }, connection: 'online', snapshot: {
    ...emptySnapshot(),
    workspaces: [{ workspace_id: 'w1', label: 'Same workspace label', agent_status: 'idle' }, { workspace_id: 'w2', label: 'Same workspace label', agent_status: 'idle' }],
    tabs: [{ workspace_id: 'w1', tab_id: 't1', label: '1', custom_label: false }, { workspace_id: 'w2', tab_id: 't2', label: '1', custom_label: false }],
    panes: [{ workspace_id: 'w1', tab_id: 't1', pane_id: 'p1', terminal_id: 'x1', agent_status: 'idle' }],
    agents: [{ workspace_id: 'w1', tab_id: 't1', pane_id: 'p1', terminal_id: 'x1', agent: 'Claude', agent_status: 'idle', state_change_seq: 1, state_labels: { idle: 'ready for a prompt' } }],
  } }] };
  const events: unknown[][] = [];
  const context = { fleetState: fleet, machineId: 'one', workspaceId: 'w1', tabId: 't1', paneId: 'p1', preferences: structuredClone(defaults), preview: { machine: 'one', workspace: 'w2' } };
  const sections = () => mobileSwitcherSections(context, { target: (...args) => events.push(args), command: (...args) => events.push(args), menu: (...args) => events.push(args) });
  return { fleet, context, sections, events };
}
test('mobile switcher separates workspace preview from active tabs and preserves native agent labels', () => {
  const { sections, events } = model(), groups = sections();
  assert.deepEqual(groups.map(group => group.id), ['agents', 'workspaces', 'tabs', 'menu']);
  const workspaces = groups.find(group => group.id === 'workspaces')!.items;
  assert.equal(workspaces.find(item => item.active)?.id, 'one/w1'); assert.equal(workspaces.find(item => item.preview)?.id, 'one/w2');
  const tabs = groups.find(group => group.id === 'tabs')!.items;
  assert.deepEqual(tabs.map(item => item.id), ['new-tab', 't1']); tabs[1].run();
  workspaces[2].run(); groups[0].items[0].run();
  assert.deepEqual(events, [['tab', 'one', 't1'], ['workspace', 'one', 'w2'], ['pane', 'one', 'p1']]);
  assert.equal(groups[0].items[0].detail, '[ready for a prompt] Claude');
});
test('mobile switcher expands worktree groups, retains unavailable hosts, and reports empty native views', () => {
  const { fleet, context, sections } = model(), host = fleet.hosts[0];
  host.snapshot!.workspaces[0].worktree = { repo_key: 'repo', repo_name: 'repo', repo_root: '/repo', checkout_path: '/repo', is_linked_worktree: false };
  host.snapshot!.workspaces[1].worktree = { ...host.snapshot!.workspaces[0].worktree, checkout_path: '/child', is_linked_worktree: true };
  context.preferences.collapsedWorkspaceGroups = [workspaceGroupKey(host.machine, 'repo')];
  host.snapshot!.agent_view = { definition: { source: 'fixture', label: 'Review queue' }, pane_ids: [] };
  fleet.hosts.push({ machine: { id: 'two', label: 'Same host label', enabled: false }, connection: 'disabled' });
  const groups = sections();
  assert.deepEqual(groups.map(group => group.id), ['hosts', 'agents', 'workspaces', 'tabs', 'menu']);
  assert.equal(groups[0].items[1].unavailable, true);
  assert.equal(groups[1].label, 'AGENTS / Review queue'); assert.equal(groups[1].empty, 'No matching agents.'); assert.equal(groups[1].items.length, 0);
  assert.equal(groups[2].items.length, 3); assert.match(groups[2].items[2].label, /^└─ /);
  assert.deepEqual(context.preferences.collapsedWorkspaceGroups, [workspaceGroupKey(host.machine, 'repo')]);
});
