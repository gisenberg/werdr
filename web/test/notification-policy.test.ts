import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationPolicy, notificationTarget } from '../src/notification-policy.ts';
import { emptySnapshot, noticeEndpointKey, type FleetState, type Notice } from '../shared/fleet.ts';
import { defaults, type Preferences } from '../shared/settings.ts';
import { readNotices, semanticNotice } from '../server/notices.ts';

function fixture() {
  const machine = { id: 'one', label: 'One', target: 'user@host', session: 'work', enabled: true };
  const pane = { pane_id: 'p1', terminal_id: 'terminal1', workspace_id: 'w1', tab_id: 't1', agent_status: 'done' as const };
  const state: FleetState = { generation: 'gateway', revision: 1, notices: [], hosts: [{ machine, connection: 'online', snapshot: { ...emptySnapshot(), workspaces: [{ workspace_id: 'w1', label: 'Work', agent_status: 'done' }], tabs: [{ workspace_id: 'w1', tab_id: 't1', label: 'Tab' }], panes: [pane], agents: [{ ...pane, state_change_seq: 1 }] } }] };
  const notice: Notice = { id: 'first', machineId: 'one', machineLabel: 'One', endpointKey: noticeEndpointKey(machine), paneId: 'p1', terminalId: 'terminal1', workspaceId: 'w1', tabId: 't1', kind: 'finished', title: 'Finished', body: '', sound: 'done', created: 100, read: false };
  const preferences: Preferences = { ...structuredClone(defaults), toastDelivery: 'both', toastDelaySeconds: 0, notificationSound: true };
  const context = { machine: 'other', workspace: 'other', tab: 'other', focused: true };
  return { state, notice, preferences, context, policy: new NotificationPolicy() };
}

test('per-agent sound preferences do not suppress in-app or desktop delivery', () => {
  for (const enabled of [true, false]) for (const setting of ['default', 'on', 'off'] as const) {
    const { policy, notice, state, context, preferences } = fixture();
    preferences.notificationSound = enabled; preferences.agentSounds.claude = setting;
    notice.agent = 'Claude';
    policy.receive(notice, 0, preferences);
    const effects = policy.tick(0, state, context, preferences);
    assert.equal(effects.some(effect => effect.kind === 'sound'), enabled && setting !== 'off');
    assert.equal(effects.some(effect => effect.kind === 'desktop'), true);
    assert.equal(policy.visible?.notice.id, notice.id);
  }
});

test('native queue is FIFO with eight waiting slots and fresh promoted lifetimes', () => {
  const { policy, notice, state, context, preferences } = fixture();
  const custom = (id: string) => ({ ...notice, id, paneId: '', terminalId: undefined, workspaceId: '', tabId: '', kind: 'custom' as const });
  for (let i = 0; i < 11; i++) { policy.receive(custom(String(i)), i, preferences); policy.tick(i, state, context, preferences); }
  assert.equal(policy.visible?.notice.id, '0');
  policy.tick(5000, state, context, preferences);
  assert.equal(policy.visible?.notice.id, '3', 'oldest two waiting items were evicted');
  assert.equal(policy.visible?.deadline, 10000);
  assert.equal(policy.consume('0', 5100, preferences), false, 'stale clicks cannot consume a successor');
  for (let i = 3; i <= 10; i++) { assert.equal(policy.visible?.notice.id, String(i)); policy.consume(String(i), 5200, preferences); }
  assert.equal(policy.visible, undefined); assert.equal(policy.nextDeadline, undefined);
});

test('pane supersession preserves unrelated endpoints and deduplicates repeated delivery', () => {
  const { policy, notice, state, context, preferences } = fixture();
  state.hosts.push({ ...structuredClone(state.hosts[0]), machine: { ...state.hosts[0].machine, id: 'two' } });
  policy.receive(notice, 0, preferences); policy.tick(0, state, context, preferences);
  policy.receive({ ...notice, id: 'second', machineId: 'two' }, 10, preferences); policy.tick(10, state, context, preferences);
  const next = { ...notice, id: 'replacement', kind: 'attention' as const, sound: 'request' as const };
  policy.receive(next, 20, preferences);
  assert.equal(policy.visible?.notice.id, 'second');
  assert.equal(policy.tick(20, state, context, preferences).length, 2);
  policy.receive(next, 21, preferences);
  assert.deepEqual(policy.tick(21, state, context, preferences), []);
  policy.consume('second', 22, preferences); assert.equal(policy.visible?.notice.id, 'replacement');
});

test('completion waits for Done evidence, expires independently of configured delay, and ignores idle', () => {
  const { policy, notice, state, context, preferences } = fixture();
  const agent = state.hosts[0].snapshot!.agents[0]; agent.agent_status = 'working';
  policy.receive(notice, 0, preferences);
  assert.deepEqual(policy.tick(0, state, context, preferences), []); assert.equal(policy.nextDeadline, 50);
  agent.agent_status = 'done'; assert.equal(policy.tick(50, state, context, preferences).length, 2);
  assert.equal(policy.visible?.notice.id, notice.id);
  policy.reset(); agent.agent_status = 'idle'; policy.receive(notice, 0, preferences);
  assert.deepEqual(policy.tick(0, state, context, preferences), []); assert.equal(policy.visible, undefined);
  policy.reset(); agent.agent_status = 'working'; preferences.toastDelaySeconds = 2;
  policy.receive(notice, 0, preferences); assert.equal(policy.nextDeadline, 2000);
  assert.deepEqual(policy.tick(2000, state, context, preferences), []); assert.equal(policy.nextDeadline, undefined);
  agent.agent_status = 'done'; assert.deepEqual(policy.tick(2100, state, context, preferences), []);
});

test('delayed attention revalidates, while custom notices bypass agent delay', () => {
  const { policy, notice, state, context, preferences } = fixture(); preferences.toastDelaySeconds = 1;
  policy.receive({ ...notice, kind: 'attention' }, 0, preferences);
  assert.deepEqual(policy.tick(1000, state, context, preferences), []);
  policy.receive({ ...notice, id: 'custom', paneId: '', kind: 'custom' }, 1001, preferences);
  assert.equal(policy.tick(1001, state, context, preferences).length, 2);
  assert.equal(policy.visible?.notice.id, 'custom');
});

test('active tab suppression is independent of pane focus, while outer focus affects external effects', () => {
  const { policy, notice, state, preferences } = fixture();
  const active = { machine: 'one', workspace: 'w1', tab: 't1', focused: true };
  policy.receive(notice, 0, preferences); assert.deepEqual(policy.tick(0, state, active, preferences), []);
  assert.equal(policy.visible, undefined);
  policy.receive({ ...notice, id: 'attention', kind: 'attention', sound: 'request' }, 1, preferences);
  assert.deepEqual(policy.tick(1, state, active, preferences).map(effect => effect.kind), ['sound']);
  policy.receive({ ...notice, id: 'unfocused' }, 2, preferences);
  assert.deepEqual(policy.tick(2, state, { ...active, focused: false }, preferences).map(effect => effect.kind), ['sound', 'desktop']);
  assert.equal(policy.visible, undefined, 'in-app toast remains suppressed even while unfocused');
  policy.receive({ ...notice, id: 'workspace', paneId: '', tabId: '', kind: 'custom', sound: undefined }, 3, preferences);
  assert.deepEqual(policy.tick(3, state, { ...active, tab: 'another' }, preferences), []);
});

test('offline target retains queue identity; moves use current ancestry and replacements cannot redirect', () => {
  const { policy, notice, state, context, preferences } = fixture();
  policy.receive(notice, 0, preferences); policy.tick(0, state, context, preferences);
  const host = state.hosts[0]; host.connection = 'offline';
  assert.equal(notificationTarget(state, notice).kind, 'offline');
  policy.tick(100, state, context, preferences); assert.equal(policy.visible?.notice.id, notice.id);
  host.connection = 'online'; host.machine.label = 'Renamed';
  host.snapshot!.workspaces[0].workspace_id = 'w2'; host.snapshot!.tabs[0] = { workspace_id: 'w2', tab_id: 't2', label: 'Moved' };
  Object.assign(host.snapshot!.panes[0], { pane_id: 'moved', workspace_id: 'w2', tab_id: 't2' });
  const moved = notificationTarget(state, notice); assert.equal(moved.kind, 'pane');
  if (moved.kind === 'pane') assert.deepEqual([moved.pane.workspace_id, moved.pane.tab_id, moved.pane.pane_id], ['w2', 't2', 'moved']);
  host.snapshot!.panes[0].terminal_id = 'replacement'; assert.equal(notificationTarget(state, notice).kind, 'stale');
  host.machine.target = 'user@replacement'; policy.tick(200, state, context, preferences);
  assert.equal(policy.visible, undefined); assert.equal(notificationTarget(state, notice).kind, 'stale');
});

test('native duration and explicit delivery settings preserve separate sound and custom disabled toasts', () => {
  const { policy, notice, state, context, preferences } = fixture();
  preferences.toastDelivery = 'off'; policy.receive(notice, 0, preferences);
  assert.deepEqual(policy.tick(0, state, context, preferences).map(effect => effect.kind), ['sound']);
  assert.equal(policy.visible, undefined);
  policy.reset(); preferences.toastDelivery = 'browser';
  policy.receive({ ...notice, kind: 'attention' }, 0, preferences); policy.tick(0, state, context, preferences);
  assert.equal(policy.nextDeadline, 8000);
  policy.reset(); preferences.toastNativeDuration = false; preferences.toastSeconds = 0;
  policy.receive(notice, 0, preferences); policy.tick(0, state, context, preferences); assert.equal(policy.visible, undefined);
  policy.reset(); assert.equal(policy.nextDeadline, undefined);
});

test('semantic records preserve native facts and legacy history stays non-navigable', () => {
  const { notice, state } = fixture();
  const record = semanticNotice({ kind: 'custom', title: '<b>literal</b>', body: 'details', position: 'top-left', sound: 'request' }, state.hosts[0].machine)!;
  assert.equal(record.kind, 'custom'); assert.equal(record.title, '<b>literal</b>'); assert.equal(record.paneId, '');
  assert.equal(notificationTarget(state, record).kind, 'none');
  assert.equal(semanticNotice({ kind: 'unknown', title: 'future' }, state.hosts[0].machine), undefined);
  assert.equal(semanticNotice({ kind: 'finished', title: 'Done', pane_id: 'p1' }, state.hosts[0].machine), undefined);
  const migrated = readNotices({ version: 1, notices: [notice] });
  assert.equal(migrated[0].terminalId, undefined); assert.equal(migrated[0].endpointKey, undefined);
  assert.equal(notificationTarget(state, migrated[0]).kind, 'stale');
  assert.throws(() => readNotices({ version: 3, notices: [] }), /unsupported/);
  assert.throws(() => readNotices({ version: 2, notices: [notice, notice] }), /Duplicate/);
  assert.throws(() => readNotices({ version: 2, notices: [{ ...notice, position: 'anywhere' }] }), /Invalid/);
});
