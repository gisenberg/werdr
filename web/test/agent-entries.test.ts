import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEntries } from '../src/agent-entries.ts';
import { emptySnapshot, type Agent, type AgentStatus, type HostView } from '../shared/fleet.ts';

const agent = (pane_id: string, agent_status: AgentStatus, state_change_seq = 0): Agent => ({ pane_id, terminal_id: pane_id, workspace_id: 'w', tab_id: 't', agent: 'codex', agent_status, state_change_seq });
const host = (id: string, agents: Agent[]): HostView => ({ machine: { id, label: id, enabled: true }, connection: 'online', snapshot: { ...emptySnapshot(), agents, workspaces: [{ workspace_id: 'w', label: 'Project Mercury', agent_status: 'idle' }], tabs: [{ tab_id: 't', workspace_id: 'w', label: 'Review changes' }] } });
const ids = (hosts: HostView[], sort: 'native' | 'priority' = 'priority', filter = 'all', query = '') => agentEntries(hosts, sort, filter, query).map(({ agent }) => agent.pane_id);

test('agent priority matches native status and most recent transition ordering without comparing independent runtime counters', () => {
  const first = host('first', [agent('working', 'working', 90), agent('old', 'done', 2), agent('new', 'done', 3), agent('blocked', 'blocked'), agent('idle', 'idle'), agent('unknown', 'unknown')]);
  const second = host('second', [agent('remote', 'done', 9000)]);
  assert.deepEqual(ids([first, second]), ['blocked', 'new', 'old', 'remote', 'working', 'idle', 'unknown']);
  assert.deepEqual(ids([first], 'native'), ['working', 'old', 'new', 'blocked', 'idle', 'unknown']);
  assert.deepEqual(ids([first], 'priority', 'done'), ['new', 'old', 'idle']);
  assert.deepEqual(first.snapshot!.agents.map(agent => agent.pane_id), ['working', 'old', 'new', 'blocked', 'idle', 'unknown']);
});

test('agent search and tooltip retain native workspace, tab, title and cwd context, including launching agents', () => {
  const pending = { ...agent('pending', 'unknown'), agent: undefined, launch_pending: true, terminal_title_stripped: 'Investigating reconnect', foreground_cwd: '/repo/feature', cwd: '/repo/base' };
  const hosts = [host('builder', [pending, { ...agent('shell', 'unknown'), agent: undefined }])];
  for (const query of ['mercury', 'REVIEW CHANGES', 'reconnect', '/repo/feature', '/repo/base', 'pending']) assert.deepEqual(ids(hosts, 'native', 'all', query), ['pending']);
  assert.equal(agentEntries(hosts, 'native', 'all', '')[0].title, 'builder / Project Mercury / Review changes\nInvestigating reconnect\n/repo/feature');
  assert.deepEqual(ids(hosts, 'priority', 'working'), []);
});
