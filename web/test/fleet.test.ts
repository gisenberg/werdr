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
    await until(() => fleet.state().hosts.filter(host => host.connection === 'online').length === 2);
    await until(() => endpoints.get('one')!.listeners.length === 2 && endpoints.get('two')!.listeners.length === 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fleet.state().notices.length, 0, 'bootstrap must not announce existing work');
    endpoints.get('two')!.status('blocked'); endpoints.get('two')!.status('blocked');
    await until(() => fleet.state().notices.length === 1);
    assert.equal(fleet.state().notices[0].machineId, 'two');
    endpoints.get('one')!.status('idle');
    await until(() => fleet.state().notices.length === 2);
    assert.equal(fleet.state().notices[0].kind, 'finished');
    assert.equal(fleet.state().notices[0].machineId, 'one');
    const old = endpoints.get('two')!;
    old.listeners[0].fail(new Error('SSH lost'));
    assert.equal(fleet.state().hosts.find(host => host.machine.id === 'one')!.connection, 'online');
    assert.equal(fleet.state().hosts.find(host => host.machine.id === 'two')!.snapshot!.panes.length, 1);
    fleet.retry('two');
    await until(() => endpoints.get('two') !== old && fleet.state().hosts.find(host => host.machine.id === 'two')!.connection === 'online');
    catalog = catalog.map(machine => machine.id === 'two' ? { ...machine, enabled: false } : machine);
    await fleet.reloadCatalog();
    assert.equal(endpoints.get('two')!.closed, true);
    await assert.rejects(fleet.request('two', 'session.snapshot'), /not connected/);
    await fleet.markNoticesRead();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    fleet.stop(); fleet = new Fleet(async () => catalog, path, connect); await fleet.start();
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
