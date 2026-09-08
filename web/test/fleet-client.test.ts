import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetClient } from '../src/fleet-client.ts';
import type { FleetState } from '../shared/fleet.ts';

const state = (generation: string, revision: number): FleetState => ({ generation, revision, hosts: [], notices: [] });
test('HTTP and stream snapshot adoption rejects older revisions without rejecting a restarted gateway', () => {
  const changes: FleetState[] = []; const client = new FleetClient(value => changes.push(value), () => {});
  const initialRead = client.version;
  assert.equal(client.acceptSnapshot(state('first', 5), initialRead), true);
  assert.equal(client.acceptSnapshot(state('first', 3), initialRead), false);
  assert.equal(client.acceptSnapshot(state('first', 6), initialRead), true);
  const oldRead = client.version;
  assert.equal(client.acceptSnapshot(state('restarted', 1), client.version), true);
  assert.equal(client.acceptSnapshot(state('first', 100), oldRead), false);
  assert.equal(client.acceptSnapshot(state('restarted', 2), client.version), true);
  const beforeStop = client.version; client.stop();
  assert.equal(client.acceptSnapshot(state('restarted', 3), beforeStop), false);
  assert.deepEqual(changes.map(value => [value.generation, value.revision]), [['first', 5], ['first', 6], ['restarted', 1], ['restarted', 2]]);
});

test('stream snapshots and deltas remain tied to their generation across concurrent HTTP updates', () => {
  const descriptors = new Map(['WebSocket', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Socket {
    static OPEN = 1; static CLOSING = 2; readyState = 1;
    static instances: Socket[] = [];
    onmessage?: (message: { data: string }) => void; onclose?: () => void;
    constructor() { Socket.instances.push(this); }
    close() { this.readyState = 2; }
    send() {}
    receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'fixture' } });
  let reconciled: FleetState | undefined;
  const client = new FleetClient(value => { reconciled = value; }, online => { if (online) assert.equal(reconciled, client.state, 'recovery must see reconciled state'); });
  try {
    client.start(); const socket = Socket.instances[0];
    socket.receive({ type: 'fleet.snapshot', state: state('first', 2) });
    client.acceptSnapshot(state('first', 4));
    socket.receive({ type: 'fleet.snapshot', state: state('first', 3) });
    assert.equal(client.state.revision, 4);
    socket.receive({ type: 'fleet.notices', revision: 5, notices: [] });
    assert.equal(client.state.revision, 5);
    client.acceptSnapshot(state('restarted', 1));
    assert.equal(socket.readyState, Socket.CLOSING);
    socket.receive({ type: 'fleet.notices', revision: 2, notices: [] });
    assert.deepEqual(client.state, state('restarted', 1));
    client.stop(); client.start(); const replacement = Socket.instances[1];
    client.acceptSnapshot(state('restarted', 3));
    replacement.receive({ type: 'fleet.snapshot', state: state('ambiguous', 1) });
    assert.equal(replacement.readyState, Socket.CLOSING); assert.deepEqual(client.state, state('restarted', 3));
    client.stop(); client.start();
    Socket.instances[2].receive({ type: 'fleet.snapshot', state: state('ambiguous', 1) });
    assert.deepEqual(client.state, state('ambiguous', 1));
  } finally {
    client.stop();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
