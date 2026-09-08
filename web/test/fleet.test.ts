import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet } from '../server/fleet.ts';
import type { NativeEndpoint, NativeEvent, Subscription } from '../server/native-api.ts';
import { emptySnapshot, type AgentStatus, type Machine } from '../shared/fleet.ts';

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Fleet did not reach expected state');
}
class Endpoint implements NativeEndpoint {
  version = 'fixture'; closed = false;
  capabilities?: { semantic_notifications?: boolean };
  listeners: { subscriptions: Subscription[]; receive(event: NativeEvent): void; fail(error: Error): void }[] = [];
  snapshot = { ...emptySnapshot(), version: 'fixture', workspaces: [{ workspace_id: 'w:1', label: 'Workspace', agent_status: 'working' as AgentStatus }], tabs: [{ workspace_id: 'w:1', tab_id: 't:1', label: 'Tab' }], panes: [{ workspace_id: 'w:1', tab_id: 't:1', pane_id: 'p:1', terminal_id: 'terminal:1', agent_status: 'working' as AgentStatus }], agents: [{ workspace_id: 'w:1', tab_id: 't:1', pane_id: 'p:1', terminal_id: 'terminal:1', agent_status: 'working' as AgentStatus, agent: 'Claude', state_change_seq: 1 }] };
  async request(method: string) { assert.equal(method, 'session.snapshot'); return { snapshot: structuredClone(this.snapshot) }; }
  async subscribe(subscriptions: Subscription[], receive: (event: NativeEvent) => void, fail: (error: Error) => void) {
    const item = { subscriptions, receive, fail }; this.listeners.push(item);
    return () => { this.listeners = this.listeners.filter(value => value !== item); };
  }
  status(state: AgentStatus) {
    this.snapshot.agents[0].agent_status = state;
    this.snapshot.agents[0].state_change_seq++;
    for (const item of [...this.listeners]) if (item.subscriptions.some(subscription => subscription.type === 'pane.agent_status_changed')) item.receive({ event: 'pane.agent_status_changed', data: structuredClone(this.snapshot.agents[0]) });
  }
  close() { this.closed = true; this.listeners = []; }
}

test('semantic notifications exclusively use the advertised stream and retain native facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-semantic-fleet-'));
  const endpoint = new Endpoint(); endpoint.capabilities = { semantic_notifications: true };
  const fleet = new Fleet(async () => [{ id: 'one', label: 'One', enabled: true }], join(directory, 'notices.json'), async () => endpoint);
  try {
    await fleet.start(); await until(() => endpoint.listeners.length === 2 && fleet.state().hosts[0]?.connection === 'online');
    const emit = (data: object) => { for (const listener of endpoint.listeners) if (listener.subscriptions.some(item => item.type === 'notification.semantic')) listener.receive({ event: 'notification.semantic', data }); };
    endpoint.status('blocked');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fleet.state().notices.length, 0, 'status transitions cannot synthesize duplicate semantic notifications');
    emit({ kind: 'needs_attention', title: 'Native title', body: 'Native context', pane_id: 'p:1', terminal_id: 'terminal:1', workspace_id: 'w:1', tab_id: 't:1', sound: 'request', agent: 'claude' });
    await until(() => fleet.state().notices.length === 1);
    const notice = fleet.state().notices[0]; assert.equal(notice.title, 'Native title'); assert.equal(notice.body, 'Native context'); assert.equal(notice.terminalId, 'terminal:1'); assert.equal(notice.sound, 'request');
    emit({ kind: 'future_kind', title: 'Ignored future event' });
    emit({ kind: 'custom', title: 'No pane', position: 'bottom-left' });
    await until(() => fleet.state().notices.length === 2);
    assert.equal(fleet.state().notices[0].paneId, ''); assert.equal(fleet.state().notices[0].position, 'bottom-left');
    assert.equal(fleet.state().hosts[0].connection, 'online');
  } finally { fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('host failures, colliding pane IDs, reconnects and notification persistence remain independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-test-')), path = join(directory, 'notices.json');
  let catalog: Machine[] = [{ id: 'one', label: 'One', enabled: true }, { id: 'two', label: 'Two', enabled: true }, { id: 'down', label: 'Down', enabled: true }];
  const endpoints = new Map<string, Endpoint>();
  const connect = async (machine: Machine) => {
    if (machine.id === 'down') throw new Error('unreachable');
    const endpoint = new Endpoint(); endpoints.set(machine.id, endpoint); return endpoint;
  };
  let fleet = new Fleet(async () => catalog, path, connect);
  try {
    await fleet.start();
    const generation = fleet.state().generation; assert.match(generation, /^[0-9a-f]{32}$/);
    await until(() => fleet.state().hosts.filter(host => host.connection === 'online').length === 2);
    await until(() => endpoints.get('one')!.listeners.length === 2 && endpoints.get('two')!.listeners.length === 2);
    assert.ok([...endpoints.values()].every(endpoint => endpoint.listeners.every(listener => listener.subscriptions.every(item => item.type !== 'agent.view.changed'))), 'legacy runtimes must not receive the optional view subscription');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fleet.state().notices.length, 0, 'bootstrap must not announce existing work');
    endpoints.get('two')!.status('blocked'); endpoints.get('two')!.status('blocked');
    await until(() => fleet.state().notices.length === 1);
    assert.equal(fleet.state().notices[0].machineId, 'two');
    endpoints.get('one')!.status('idle');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fleet.state().notices.length, 1, 'idle is not completion evidence');
    endpoints.get('one')!.status('working');
    endpoints.get('one')!.status('done');
    await until(() => fleet.state().notices.length === 2);
    assert.equal(fleet.state().notices[0].kind, 'finished');
    assert.equal(fleet.state().notices[0].machineId, 'one');
    const old = endpoints.get('two')!;
    const connectionGeneration = fleet.state().hosts.find(host => host.machine.id === 'two')!.connectionGeneration;
    assert.match(connectionGeneration!, /^[0-9a-f]{32}$/);
    old.listeners[0].fail(new Error('SSH lost'));
    assert.equal(fleet.state().hosts.find(host => host.machine.id === 'one')!.connection, 'online');
    assert.equal(fleet.state().hosts.find(host => host.machine.id === 'two')!.snapshot!.panes.length, 1);
    fleet.retry('two');
    await until(() => endpoints.get('two') !== old && fleet.state().hosts.find(host => host.machine.id === 'two')!.connection === 'online');
    assert.notEqual(fleet.state().hosts.find(host => host.machine.id === 'two')!.connectionGeneration, connectionGeneration);
    catalog = catalog.map(machine => machine.id === 'two' ? { ...machine, enabled: false } : machine);
    await fleet.reloadCatalog();
    assert.equal(endpoints.get('two')!.closed, true);
    await assert.rejects(fleet.request('two', 'session.snapshot'), /not connected/);
    await fleet.markNoticesRead();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(fleet.state().generation, generation);
    fleet.stop(); fleet = new Fleet(async () => catalog, path, connect); await fleet.start();
    assert.notEqual(fleet.state().generation, generation);
    assert.equal(fleet.state().notices.length, 2); assert.ok(fleet.state().notices.every(notice => notice.read));
  } finally { fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('removing a host while its handshake is pending retires the eventual connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-test-'));
  let catalog: Machine[] = [{ id: 'pending', label: 'Pending', enabled: true }];
  let finish!: (endpoint: NativeEndpoint) => void;
  const endpoint = new Endpoint();
  const fleet = new Fleet(async () => catalog, join(directory, 'notices.json'), () => new Promise(resolve => { finish = resolve; }));
  try {
    await fleet.start(); await until(() => !!finish);
    catalog = []; await fleet.reloadCatalog(); finish(endpoint);
    await until(() => endpoint.closed);
    assert.equal(fleet.state().hosts.length, 0);
  } finally { fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('multi-step browser actions serialize per host while metadata reads and other hosts remain independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-actions-'));
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  const calls: string[] = [];
  class ActionEndpoint extends Endpoint {
    focused = '';
    constructor(private name: string) { super(); }
    override async request(method: string, params: any = {}) {
      if (method === 'session.snapshot') return super.request(method);
      calls.push(`${this.name}:${method}:${params.pane_id || this.focused}`);
      if (method === 'pane.focus') { this.focused = params.pane_id; if (this.name === 'one' && this.focused === 'p:first') await paused; }
      return { snapshot: structuredClone(this.snapshot) };
    }
  }
  const fleet = new Fleet(async () => ['one', 'two'].map(id => ({ id, label: id, enabled: true })), join(directory, 'notices.json'), async machine => new ActionEndpoint(machine.id));
  try {
    await fleet.start(); await until(() => fleet.state().hosts.every(host => host.connection === 'online'));
    const first = fleet.action('one', async request => { await request('pane.focus', { pane_id: 'p:first' }); return request('plugin.action.invoke'); });
    const second = fleet.action('one', async request => { await request('pane.focus', { pane_id: 'p:second' }); return request('plugin.action.invoke'); });
    await until(() => calls.length === 1);
    await fleet.request('one', 'session.snapshot', {}, false);
    await fleet.action('two', request => request('pane.focus', { pane_id: 'p:other' }));
    assert.deepEqual(calls, ['one:pane.focus:p:first', 'two:pane.focus:p:other']);
    resume(); await Promise.all([first, second]);
    assert.deepEqual(calls.slice(2), ['one:plugin.action.invoke:p:first', 'one:pane.focus:p:second', 'one:plugin.action.invoke:p:second']);
    await assert.rejects(fleet.action('one', async () => { throw new Error('fixture failure'); }), /fixture failure/);
    await fleet.action('one', request => request('session.snapshot'));
  } finally { resume(); fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a multi-step action cannot continue on a replacement host with the same catalog ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-actions-'));
  let catalog: Machine[] = [{ id: 'one', label: 'One', target: 'original', enabled: true }];
  let endpoint: Endpoint | undefined;
  const fleet = new Fleet(async () => catalog, join(directory, 'notices.json'), async () => { endpoint = new Endpoint(); return endpoint; });
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; }); let began = false, continued = false;
  try {
    await fleet.start(); await until(() => fleet.state().hosts[0]?.connection === 'online');
    const original = endpoint;
    const action = fleet.action('one', async request => { await request('session.snapshot', {}, false); began = true; await paused; await request('session.snapshot', {}, false); continued = true; });
    await until(() => began);
    catalog = [{ ...catalog[0], target: 'replacement' }]; await fleet.reloadCatalog();
    await until(() => endpoint !== original && fleet.state().hosts[0]?.connection === 'online');
    assert.equal(original?.closed, true); resume();
    await assert.rejects(action, /Host changed/); assert.equal(continued, false);
    await fleet.action('one', request => request('session.snapshot'));
  } finally { resume(); fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('per-host action backlog is bounded and drains after the active operation finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-actions-'));
  const fleet = new Fleet(async () => [{ id: 'one', label: 'One', enabled: true }], join(directory, 'notices.json'), async () => new Endpoint());
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  try {
    await fleet.start(); await until(() => fleet.state().hosts[0]?.connection === 'online');
    const tasks = [fleet.action('one', async request => { await paused; return request('session.snapshot'); })];
    for (let index = 0; index < 31; index++) tasks.push(fleet.action('one', request => request('session.snapshot')));
    await assert.rejects(fleet.action('one', request => request('session.snapshot')), /too many pending actions/);
    resume(); await Promise.all(tasks); await fleet.action('one', request => request('session.snapshot'));
  } finally { resume(); fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('terminal scroll subscriptions stay pane-local and cannot follow a reassigned machine target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fleet-scroll-'));
  const original: Machine = { id: 'one', label: 'One', enabled: true, target: 'original' };
  let machine = original;
  const endpoints: Endpoint[] = [];
  class ScrollEndpoint extends Endpoint {
    snapshots = 0;
    override async request(method: string) {
      if (method === 'pane.get') return { pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 20, alternate_screen_active: false } } } as any;
      this.snapshots++; return super.request(method);
    }
  }
  const fleet = new Fleet(async () => [machine], join(directory, 'notices.json'), async () => { const endpoint = new ScrollEndpoint(); endpoints.push(endpoint); return endpoint; });
  const values: any[] = []; let stop = () => {};
  try {
    await fleet.start(); await until(() => fleet.state().hosts[0].connection === 'online');
    await new Promise(resolve => setTimeout(resolve, 100));
    const first = endpoints[0] as ScrollEndpoint;
    stop = fleet.watchPaneScroll(original, 'p:1', state => values.push(state));
    await until(() => values.at(-1)?.max_offset_from_bottom === 100);
    const reads = first.snapshots;
    const watcher = first.listeners.find(listener => listener.subscriptions.some(value => value.type === 'pane.scroll_changed'))!;
    for (let offset = 1; offset <= 20; offset++) watcher.receive({ event: 'pane.scroll_changed', data: { pane_id: 'p:1', scroll: { ...values.at(-1), offset_from_bottom: offset } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(values.at(-1).offset_from_bottom, 20);
    assert.equal(first.snapshots, reads, 'scroll events must not invalidate the fleet snapshot');
    machine = { ...original, target: 'replacement' }; await fleet.reloadCatalog();
    await until(() => endpoints.length === 2 && fleet.state().hosts[0].connection === 'online');
    assert.equal(values.at(-1), undefined);
    assert.ok(endpoints[1].listeners.every(listener => !listener.subscriptions.some(value => value.type === 'pane.scroll_changed')));
    const count = values.length; watcher.receive({ event: 'pane.scroll_changed', data: { pane_id: 'p:1', scroll: { offset_from_bottom: 30, max_offset_from_bottom: 100, viewport_rows: 20 } } });
    assert.equal(values.length, count);
  } finally { stop(); fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('native view subscriptions are capability gated and refresh after definition changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-view-test-'));
  const endpoint = new Endpoint();
  endpoint.snapshot.agent_view = { definition: null, pane_ids: ['p:1'] };
  const fleet = new Fleet(async () => [{ id: 'one', label: 'One', enabled: true }], join(directory, 'notices.json'), async () => endpoint);
  try {
    await fleet.start();
    await until(() => endpoint.listeners.some(listener => listener.subscriptions.some(item => item.type === 'agent.view.changed')));
    endpoint.snapshot.agent_view = { definition: { source: 'test', label: 'Focus' }, pane_ids: [] };
    for (const listener of endpoint.listeners) if (listener.subscriptions.some(item => item.type === 'agent.view.changed')) listener.receive({ event: 'agent.view.changed', data: { definition: endpoint.snapshot.agent_view.definition } });
    await until(() => fleet.state().hosts[0].snapshot?.agent_view?.definition?.label === 'Focus');
    assert.deepEqual(fleet.state().hosts[0].snapshot!.agent_view!.pane_ids, []);
    assert.equal(fleet.state().notices.length, 0);
  } finally { fleet.stop(); await rm(directory, { recursive: true, force: true }); }
});
