import test from 'node:test';
import assert from 'node:assert/strict';
import type { Machine, Workspace } from '../shared/fleet.ts';
import { workspaceEntries, workspaceGroup, workspaceGroupKey } from '../src/workspace-groups.ts';
import { browserAction } from '../server/browser-actions.ts';

const machine: Machine = { id: 'host', label: 'same label', target: 'user@host', session: 'named', enabled: true };
const workspace = (id: string, linked?: boolean, repo = 'repository'): Workspace => ({ workspace_id: id, label: id, agent_status: 'idle', ...(linked === undefined ? {} : { worktree: { repo_key: repo, repo_root: '/repo', repo_name: 'same repository name', checkout_path: '/checkout/' + id, is_linked_worktree: linked } }) });
const parent = workspace('parent', false), a = workspace('a', true), b = workspace('b', true), other = workspace('other');
const ids = (rows: ReturnType<typeof workspaceEntries>) => rows.map(row => row.workspace.workspace_id);
test('native worktree grouping preserves group position, parent-first order, active children and collapsed attention priority', () => {
  const all = [a, other, parent, b];
  assert.deepEqual(ids(workspaceEntries(machine, all, new Set(), '')), ['parent', 'a', 'b', 'other']);
  const key = workspaceGroupKey(machine, 'repository');
  const collapsed = new Set([key]);
  assert.deepEqual(ids(workspaceEntries(machine, all, collapsed, 'b')), ['parent', 'b', 'other']);
  assert.deepEqual(ids(workspaceEntries(machine, all, collapsed, 'other')), ['parent', 'other']);
  const rows = workspaceEntries(machine, all, collapsed, 'b');
  assert.equal(rows[1].indented, true); assert.equal(rows[1].lastChild, true);
  const statuses = [parent, { ...a, agent_status: 'working' as const }, { ...b, agent_status: 'done' as const }];
  assert.equal(workspaceEntries(machine, statuses, collapsed, '')[0].status, 'done');
  assert.equal(workspaceEntries(machine, [...statuses, { ...a, agent_status: 'blocked' }], collapsed, '')[0].status, 'blocked');
  assert.equal(workspaceEntries(machine, statuses, new Set(), '')[0].status, 'idle');
  assert.deepEqual(workspaceGroup(all, parent), [a, parent, b]);
  assert.equal(workspaceGroup(all, a), undefined);
});
test('grouping requires native parent membership, isolates endpoint identities and reveals filtered children without changing preferences', () => {
  assert.deepEqual(ids(workspaceEntries(machine, [a, other, b], new Set(), '')), ['a', 'other', 'b']);
  assert.equal(workspaceEntries(machine, [a, other, b], new Set(), '')[0].indented, false);
  assert.equal(workspaceEntries(machine, [parent], new Set(), '')[0].group, undefined);
  const collapsed = new Set([workspaceGroupKey(machine, 'repository')]);
  assert.deepEqual(ids(workspaceEntries(machine, [parent, a, b], collapsed, '', '/checkout/a')), ['parent', 'a']);
  assert.equal(collapsed.size, 1);
  for (const host of [{ ...machine, id: 'different' }, { ...machine, target: 'other@host' }, { ...machine, session: 'other' }]) assert.deepEqual(ids(workspaceEntries(host, [parent, a, b], collapsed, '')), ['parent', 'a', 'b']);
  assert.equal(workspaceGroupKey({ ...machine, label: 'renamed' }, 'repository'), workspaceGroupKey(machine, 'repository'));
  assert.deepEqual(ids(workspaceEntries(machine, [parent, a, workspace('second', false, 'second'), workspace('second-child', true, 'second')], collapsed, '')), ['parent', 'second', 'second-child']);
});
test('workspace group closure is explicit and never coerces an invalid broad-close flag', () => {
  assert.deepEqual(browserAction({ action: 'workspace.close', id: 'w1' }).params, { workspace_id: 'w1' });
  assert.deepEqual(browserAction({ action: 'workspace.close', id: 'w1', close_group: true }).params, { workspace_id: 'w1', close_group: true });
  assert.deepEqual(browserAction({ action: 'workspace.close', id: 'w1', close_group: false }).params, { workspace_id: 'w1' });
  for (const close_group of ['true', 1, null, [], {}]) assert.throws(() => browserAction({ action: 'workspace.close', id: 'w1', close_group }));
});
