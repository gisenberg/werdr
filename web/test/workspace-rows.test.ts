import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorkspaceRows, validateWorkspaceRows } from '../shared/workspace-rows.ts';
import { tokenStyle } from '../shared/sidebar-tokens.ts';

test('workspace layouts preserve native defaults, missing tokens and styled rules', () => {
  assert.deepEqual(validateWorkspaceRows({}), defaultWorkspaceRows);
  const value = { rows: [[], ['state_icon', 'workspace'], [{ token: '$build', fg: '#abc', rules: [{ equals: 'FAILED', ignore_case: true, fg: '#f00', bold: true }, { contains: 'fail', dim: true }] }], ['branch', { token: 'git_status', fg: '#abcdef' }]], row_gap: 2 };
  assert.deepEqual(validateWorkspaceRows(value), value);
  const token = value.rows[2][0];
  assert.equal(typeof token, 'object');
  assert.deepEqual(tokenStyle(token!, 'failed'), { fg: '#f00', bold: true, dim: undefined });
  assert.deepEqual(validateWorkspaceRows({ rows: [], row_gap: 0 }), { rows: [], row_gap: 0 });
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
