import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, type FleetState } from '../shared/fleet.ts';
import { navigationTargets, resolveNavigationTarget } from '../src/navigation-targets.ts';

test('navigation identity survives duplicate labels and rejects removed or moved targets', () => {
  const fleet: FleetState = { revision: 1, notices: [], hosts: ['one', 'two'].map(id => ({ machine: { id, label: 'same host label', enabled: true }, connection: 'online', snapshot: { ...emptySnapshot(), workspaces: [{ workspace_id: 'w1', label: 'same', agent_status: 'idle' }], tabs: [{ workspace_id: 'w1', tab_id: 't1', label: 'same' }], panes: [{ workspace_id: 'w1', tab_id: 't1', pane_id: 'p1', terminal_id: 'x1', label: 'same', agent_status: 'idle' }] } })) };
  const targets = navigationTargets(fleet); assert.equal(targets.length, 6);
  assert.equal(new Set(targets.map(item => item.label)).size, 6);
  const target = targets.find(item => item.kind === 'Pane' && item.machine === 'two')!;
  assert.equal(resolveNavigationTarget(fleet, target)?.machine, 'two');
  fleet.hosts[1].snapshot!.panes[0].tab_id = 't2';
  assert.equal(resolveNavigationTarget(fleet, target), undefined);
  assert.equal(resolveNavigationTarget(fleet, targets[2])?.machine, 'one');
  fleet.hosts[0].machine.enabled = false;
  assert.equal(resolveNavigationTarget(fleet, targets[2]), undefined);
});
