import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorkspaceRows, validateWorkspaceRows } from '../shared/workspace-rows.ts';
import { tokenStyle } from '../shared/sidebar-tokens.ts';
import { resolveWorkspaceRows } from '../src/workspace-row-renderer.ts';
import { sidebarTokenWidths, rowSeparator } from '../src/sidebar-row-renderer.ts';
import type { Workspace } from '../shared/fleet.ts';

test('workspace layouts preserve native defaults, missing tokens and styled rules', () => {
  assert.deepEqual(validateWorkspaceRows({}), defaultWorkspaceRows);
  const value = { rows: [[], ['state_icon', 'workspace'], [{ token: '$build', fg: '#abc', rules: [{ equals: 'FAILED', ignore_case: true, fg: '#f00', bold: true }, { contains: 'fail', dim: true }] }], ['branch', { token: 'git_status', fg: '#abcdef' }]], row_gap: 2 };
  assert.deepEqual(validateWorkspaceRows(value), value);
  const token = value.rows[2][0];
  assert.equal(typeof token, 'object');
  assert.deepEqual(tokenStyle(token!, 'failed'), { fg: '#f00', bold: true, dim: undefined });
  assert.deepEqual(validateWorkspaceRows({ rows: [], row_gap: 0 }), { rows: [], row_gap: 0 });
});

test('workspace rows preserve native worktree labels, aggregate status, missing Git and literal custom metadata', () => {
  const workspace: Workspace = { workspace_id: 'w', label: 'checkout', custom_label: false, branch: 'worktree/review', git_ahead_behind: [12, 3], agent_status: 'idle', tokens: { build: '<b>failed</b>' } };
  const resolve = (item = workspace, indented = false) => resolveWorkspaceRows(defaultWorkspaceRows, { workspace: item, status: 'blocked', indented }, 'symbols');
  assert.deepEqual(resolve().map(row => row.map(token => token.text)), [['×', 'checkout'], ['worktree/review', '↑12 ↓3']]);
  assert.deepEqual(resolve()[1][1].runs, [{ text: '↑12', tone: 'green' }, { text: ' ' }, { text: '↓3', tone: 'red' }]);
  assert.deepEqual(resolve(workspace, true).map(row => row.map(token => token.text)), [['×', 'review']]);
  for (const custom_label of [true, undefined]) assert.equal(resolve({ ...workspace, custom_label }, true)[0][1].text, 'checkout');
  for (const git_ahead_behind of [undefined, [0, 0] as [number, number]]) assert.deepEqual(resolve({ ...workspace, git_ahead_behind })[1].map(token => token.kind), ['branch']);
  assert.equal(resolve({ ...workspace, branch: undefined, git_ahead_behind: undefined }).length, 1);
  const rows = resolveWorkspaceRows(validateWorkspaceRows({ rows: [['$missing', '$constructor'], ['state_text', { token: '$build', rules: [{ contains: 'failed', fg: '#f00' }] }]] }), { workspace, status: 'unknown', indented: false }, 'text');
  assert.deepEqual(rows.map(row => row.map(token => token.text)), [['idle', '<b>failed</b>']]);
  assert.equal(rows[0][1].style.fg, '#f00');
  assert.deepEqual(resolveWorkspaceRows({ rows: [], row_gap: 0 }, { workspace, status: 'idle', indented: false }, 'dots'), []);
});

test('workspace width allocation reserves Git counts and recomputes native separators after dropping text', () => {
  const tokens = [{ kind: 'branch', width: 30 }, { kind: 'git_status', width: 6 }];
  assert.deepEqual(sidebarTokenWidths(tokens, 12), [5, 6]);
  assert.deepEqual(sidebarTokenWidths(tokens, 6), [null, 6]);
  assert.equal(rowSeparator('branch', 'git_status'), ' ');
  assert.equal(rowSeparator('state_icon', 'workspace'), ' ');
  assert.equal(rowSeparator('workspace', 'branch'), ' · ');
});

test('workspace layouts reject non-text rules, agent-only tokens and unbounded settings', () => {
  for (const value of [
    { rows: [['machine']] }, { rows: [['agent']] }, { rows: [[{ token: 'git_status', rules: [{ gt: 1, bold: true }] }]] },
    { rows: [[{ token: 'state_icon', rules: [{ equals: 'done', bold: true }] }]] },
    { rows: [['$']] }, { rows: [[{ token: 'branch', fg: 'red' }]] }, { row_gap: null }, { row_gap: -1 }, { row_gap: 65536 },
    { rows: Array.from({ length: 17 }, () => []) }, { rows: [Array.from({ length: 17 }, () => 'workspace')] },
    { rows_by_agent: {} }, { rows: [[{ token: '$build', rules: [{ contains: 'x'.repeat(17000) }] }]] },
  ]) assert.throws(() => validateWorkspaceRows(value));
});
