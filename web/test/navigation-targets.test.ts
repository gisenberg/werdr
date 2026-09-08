import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, type FleetState } from '../shared/fleet.ts';
import { attentionTarget, navigationTargets, resolveNavigationTarget } from '../src/navigation-targets.ts';

test('navigation identity survives duplicate labels and rejects removed or moved targets', () => {
  const fleet: FleetState = { generation: 'fixture', revision: 1, notices: [], hosts: ['one', 'two'].map(id => ({ machine: { id, label: 'same host label', enabled: true }, connection: 'online', snapshot: { ...emptySnapshot(), workspaces: [{ workspace_id: 'w1', label: 'same', agent_status: 'idle' }], tabs: [{ workspace_id: 'w1', tab_id: 't1', label: 'same' }], panes: [{ workspace_id: 'w1', tab_id: 't1', pane_id: 'p1', terminal_id: 'x1', label: 'same', agent_status: 'idle' }] } })) };
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

test('attention navigation wraps native order while retaining host identity and excluding unavailable agents', () => {
  const fleet: FleetState = { generation: 'fixture', revision: 1, notices: [], hosts: ['one', 'two', 'offline'].map(id => ({ machine: { id, label: id, enabled: true }, connection: id === 'offline' ? 'offline' : 'online', snapshot: { ...emptySnapshot(), agents: ['idle', 'blocked', 'working'].map((status, index) => ({ pane_id: `p${index}`, terminal_id: `t${index}`, workspace_id: 'w1', tab_id: 't1', agent_status: status as 'idle' | 'blocked' | 'working', state_change_seq: index })) } })) };
  assert.equal(attentionTarget(fleet, 'one', 'p0', 1)?.machine, 'one');
  assert.equal(attentionTarget(fleet, 'one', 'p1', 1)?.machine, 'two');
  assert.equal(attentionTarget(fleet, 'two', 'p1', 1)?.machine, 'one');
  assert.equal(attentionTarget(fleet, 'one', 'p1', -1)?.machine, 'two');
  fleet.hosts[0].machine.enabled = false; fleet.hosts[1].snapshot!.agents = [];
  assert.equal(attentionTarget(fleet, 'one', 'p1', 1), undefined);
});
