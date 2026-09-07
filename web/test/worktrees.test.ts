import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worktreeAction } from '../server/worktree-actions.ts';
test('worktree actions preserve native scope and explicit trust without forwarding environment or commands', () => {
  assert.deepEqual(worktreeAction({ action: 'worktree.create', id: 'w:1', cwd: '/repo', branch: 'feature', trust: false, command: 'bad', env: { bad: true } }), { method: 'worktree.create', params: { cwd: '/repo', trust_repository: false, branch: 'feature', focus: true } });
  assert.deepEqual(worktreeAction({ action: 'worktree.list', id: 'w:1' }), { method: 'worktree.list', params: { workspace_id: 'w:1', trust_repository: false } });
  assert.deepEqual(worktreeAction({ action: 'worktree.remove', id: 'w:2', force: true, trust: true, path: '/ignored' }), { method: 'worktree.remove', params: { workspace_id: 'w:2', force: true, trust_repository: true } });
  for (const value of [{ action: 'worktree.open', id: 'w:1' }, { action: 'worktree.open', id: 'w:1', path: '/repo', branch: 'main' }, { action: 'worktree.list', cwd: '/repo\0bad' }, { action: 'worktree.remove', id: 'w:1', force: 'true' }, { action: 'worktree.list', id: 'w:1', trust: 1 }, { action: 'worktree.exec', id: 'w:1' }]) assert.throws(() => worktreeAction(value));
});
