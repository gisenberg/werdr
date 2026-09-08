import test from 'node:test';
import assert from 'node:assert/strict';
import { popupSession, type PopupState } from '../shared/popups.ts';
import { PopupWatch } from '../server/popup-watch.ts';
import type { NativeEndpoint, NativeEvent } from '../server/native-api.ts';
const popup = (id: string) => ({ terminal_id: id, owner_tab_id: 'w1:t1', owner_workspace_id: 'w1' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function endpoint(supported = true) {
  let event: (event: NativeEvent) => void = () => {}, fail: (error: Error) => void = () => {};
  let stops = 0, subscriptions = 0;
  const reads: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const api: NativeEndpoint = {
    version: 'test', capabilities: { popup_sessions: supported },
    request(method) { assert.equal(method, 'popup.get'); return new Promise((resolve, reject) => reads.push({ resolve, reject })); },
    async subscribe(spec, receive, closed) { assert.deepEqual(spec, [{ type: 'popup.changed' }]); subscriptions++; event = receive; fail = closed; return () => { stops++; }; },
    close() {},
  };
  return { api, reads, changed: () => event({ event: 'popup.changed', data: {} }), fail: () => fail(new Error('closed')), stops: () => stops, subscriptions: () => subscriptions };
}

test('popup metadata validates identity and native geometry without forwarding executable details', () => {
  assert.deepEqual(popupSession({ ...popup('terminal'), width: '80%', height: 0, command: 'private' }), { ...popup('terminal'), width: '80%', height: 0 });
  assert.equal(popupSession(null), null);
  for (const value of [undefined, {}, { ...popup('terminal'), width: '101%' }, { ...popup('terminal'), terminal_id: '../bad' }, { ...popup('terminal'), height: 1.5 }]) assert.throws(() => popupSession(value));
});
test('popup reload while a read is pending discards stale IDs and coalesces refreshes', async () => {
  const native = endpoint(), seen: (PopupState | undefined)[] = [];
  const watch = new PopupWatch(value => seen.push(value));
  try {
    watch.reconcile(native.api); await tick(); assert.equal(native.reads.length, 1);
    native.changed(); native.changed(); native.reads[0].resolve({ popup: popup('old') });
    await tick(); assert.equal(native.reads.length, 2);
    assert(!seen.some(value => value?.status === 'ready'));
    native.reads[1].resolve({ popup: popup('new') }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', popup: popup('new') });
    watch.reconcile(native.api); await tick(); assert.equal(native.reads.length, 2);
  } finally { watch.dispose(); }
  assert.equal(native.stops(), 1);
});

test('replacement and disconnect reject late results and old events', async () => {
  const first = endpoint(), second = endpoint(), seen: (PopupState | undefined)[] = [];
  const watch = new PopupWatch(value => seen.push(value));
  try {
    watch.reconcile(first.api); await tick(); watch.reconcile(second.api); await tick();
    first.reads[0].resolve({ popup: popup('old') }); first.changed();
    second.reads[0].resolve({ popup: popup('new') }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', popup: popup('new') });
    assert(!seen.some(value => value?.status === 'ready' && value.popup?.terminal_id === 'old'));
    watch.reconcile(); first.changed(); second.changed(); await tick();
    assert.equal(seen.at(-1), undefined); assert.equal(first.stops(), 1); assert.equal(second.stops(), 1);
  } finally { watch.dispose(); }
});

test('unsupported endpoints are untouched and optional popup failures clear popup availability', async () => {
  const old = endpoint(false), native = endpoint(), seen: (PopupState | undefined)[] = [];
  const watch = new PopupWatch(value => seen.push(value));
  try {
    watch.reconcile(old.api); await tick(); assert.equal(old.subscriptions(), 0); assert.equal(old.reads.length, 0);
    watch.reconcile(native.api); await tick(); native.reads[0].resolve({ popup: popup('known') }); await tick();
    native.fail(); assert.deepEqual(seen.at(-1), { status: 'unavailable' });
    assert.equal(native.stops(), 1);
    native.changed(); await tick(); assert.equal(native.reads.length, 1);
  } finally { watch.dispose(); }
});

test('popup subscription failure retries independently and ignores late output from the failed attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = endpoint(), seen: (PopupState | undefined)[] = [];
  const watch = new PopupWatch(value => seen.push(value));
  try {
    watch.reconcile(native.api); await tick(); native.fail();
    context.mock.timers.tick(5000); await tick(); assert.equal(native.subscriptions(), 2);
    native.reads[1].resolve({ popup: popup('recovered') }); await tick();
    native.reads[0].resolve({ popup: popup('late') }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', popup: popup('recovered') });
    native.changed(); await tick(); native.reads[2].reject(new Error('read failed')); await tick();
    assert.deepEqual(seen.at(-1), { status: 'unavailable' });
    watch.dispose(); context.mock.timers.tick(15000); await tick(); assert.equal(native.subscriptions(), 2);
  } finally { watch.dispose(); }
});
