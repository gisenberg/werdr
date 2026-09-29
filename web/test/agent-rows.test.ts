import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalAgents, defaultAgentRows, tokenStyle, validateAgentRows } from '../shared/agent-rows.ts';
import { resolveAgentRows } from '../src/agent-row-renderer.ts';
import { sidebarTokenWidths } from '../src/sidebar-row-renderer.ts';
import { validatePreferences } from '../shared/settings.ts';
import type { Agent } from '../shared/fleet.ts';

test('agent row configuration follows native defaults and canonical agent vocabulary', async () => {
  const native = await readFile('../src/config/sidebar.rs', 'utf8');
  assert.match(native, /impl Default for AgentsSidebarConfig[\s\S]*StateIcon,[\s\S]*Machine,[\s\S]*Workspace,[\s\S]*Tab,[\s\S]*vec!\[AgentSidebarToken::Agent\]/);
  const labels = (await readFile('../src/detect/mod.rs', 'utf8')).split('pub fn agent_label')[1].split('pub fn interactive_agent_executable')[0];
  assert.deepEqual([...labels.matchAll(/=> "([a-z]+)"/g)].map(match => match[1]), [...canonicalAgents]);
  assert.deepEqual(validateAgentRows({}), defaultAgentRows);
  const config = validateAgentRows({ rows: [[{ token: '$load', fg: '#abc', rules: [{ gt: 80, bold: true }] }]], rows_by_agent: { claude: [['pane']] }, row_gap: 2 });
  const copy = validatePreferences({ agentRows: config });
  config.rows[0].length = 0; config.rows_by_agent.claude[0].length = 0;
  assert.equal(copy.agentRows.rows[0].length, 1); assert.deepEqual(copy.agentRows.rows_by_agent.claude, [['pane']]);
});

test('row validation rejects malformed, unknown, unbounded, or ambiguous native rules', () => {
  const invalid = [null, [], { rows: [42] }, { rows: [Array(17).fill('agent')] }, { rows: Array(17).fill([]) }, { rows: [['missing']] }, { rows: [['$']] }, { rows: [['$bad.name']] }, { rows: [['$' + 'x'.repeat(33)]] }, { rows_by_agent: { 'Claude': [] } }, { row_gap: -1 }, { row_gap: 65536 }, { row_gap: 1.5 }, { unexpected: true }];
  for (const token of [{ token: 'agent', fg: 'url(x)' }, { token: 'agent', bold: 1 }, { token: 'agent', rules: [{}] }, { token: 'agent', rules: [{ equals: 'a', gt: 1 }] }, { token: 'agent', rules: [{ equals: 1 }] }, { token: 'agent', rules: [{ gt: Infinity }] }, { token: 'agent', rules: [{ gt: 2, ignore_case: false }] }, { token: 'agent', rules: [{ contains: 'x', ignore_case: 'true' }] }, { token: 'agent', rules: [{ equals: 'x', typo: true }] }, { token: 'state_icon', rules: [{ equals: 'x' }] }, { token: '$load', rules: Array(17).fill({ gt: 1 }) }, { token: '$load', rules: [{ equals: '界'.repeat(6000) }] }]) invalid.push({ rows: [[token]] } as never);
  for (const value of invalid) assert.throws(() => validateAgentRows(value));
  assert.throws(() => validatePreferences({ agentRows: null }), /Agent rows/);
  assert.deepEqual(validateAgentRows({ rows: [], row_gap: 65535 }).rows, []);
});

test('conditional token styling uses first-match precedence, explicit false, ASCII case folding, and strict finite decimals', () => {
  const token = { token: '$load', fg: '#abc', bold: true, dim: true, rules: [{ gt: 80, bold: false, dim: false }, { gt: 90, fg: '#f00' }] };
  for (const value of ['90', '8.1e1', '+90', '90.']) assert.deepEqual(tokenStyle(token, value), { fg: '#abc', bold: false, dim: false });
  for (const value of ['80', '90%', ' 90', '90 ', '', 'NaN', 'inf', '-inf', '1e999', '0x90']) assert.deepEqual(tokenStyle(token, value), { fg: '#abc', bold: true, dim: true });
  for (const condition of ['equals', 'contains', 'starts_with']) {
    const styled = { token: 'machine', rules: [{ [condition]: 'ÉA', ignore_case: true, fg: '#123' }] };
    assert.equal(tokenStyle(styled, 'Éa').fg, '#123'); assert.equal(tokenStyle(styled, 'éa').fg, undefined);
  }
});

test('native rows resolve overrides, state labels, pane names and metadata without inventing missing fields', () => {
  const agent: Agent = { pane_id: 'p', terminal_id: 't', workspace_id: 'w', tab_id: 'tab', agent_status: 'blocked', state_change_seq: 1, agent: 'Claude', name: 'manual', display_agent: 'Researcher', title: 'Review', terminal_title: '● Building', terminal_title_stripped: 'Building', state_labels: { blocked: 'needs approval' }, tokens: { load: '90', summary: '<script>alert(1)</script>' } };
  const config = validateAgentRows({ rows: [['$missing']], rows_by_agent: { claude: [['state_icon', 'machine', 'workspace', 'tab'], ['agent', 'state_text', 'pane'], ['terminal_title', 'terminal_title_stripped', '$summary', { token: '$load', rules: [{ gt: 80, fg: '#f00' }] }], ['$missing', '$constructor', '$__proto__']] } });
  const rows = resolveAgentRows(config, { agent, machine: 'builder', workspace: 'project', tab: 'review' }, 'symbols');
  assert.deepEqual(rows.map(row => row.map(token => token.text)), [['×', 'builder', 'project', 'review'], ['Researcher', 'needs approval', 'Review'], ['● Building', 'Building', '<script>alert(1)</script>', '90']]);
  assert.equal(rows[2][3].style.fg, '#f00');
  assert.deepEqual(resolveAgentRows(config, { agent: { ...agent, agent: 'unknown-agent' }, machine: 'm', workspace: 'w' }, 'dots').map(row => row.map(token => token.text)), [['●']]);
  assert.deepEqual(resolveAgentRows(validateAgentRows({ rows: [['state_text']] }), { agent: { ...agent, agent_status: 'unknown' }, machine: 'm', workspace: 'w' }, 'text')[0][0].text, 'idle');
});

test('native row widths reserve status, share spare cells and retain later text fields on narrow rails', () => {
  const tokens = [{ kind: 'state_icon', width: 9 }, { kind: 'machine', width: 7 }, { kind: 'workspace', width: 16 }, { kind: 'tab', width: 1 }];
  assert.deepEqual(sidebarTokenWidths(tokens, 29), [9, 6, 6, 1]);
  assert.deepEqual(sidebarTokenWidths(tokens, 18), [9, null, 4, 1]);
  assert.deepEqual(sidebarTokenWidths(tokens, 11), [9, null, null, 1]);
  assert.deepEqual(sidebarTokenWidths(tokens, 9), [9, null, null, null]);
  assert.deepEqual(sidebarTokenWidths(tokens, 100), [9, 7, 16, 1]);
  assert.deepEqual(sidebarTokenWidths([{ kind: 'agent', width: 2 }, { kind: 'custom', width: 30 }], 20), [2, 15]);
});
