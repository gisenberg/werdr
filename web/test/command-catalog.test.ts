import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCatalog, type CommandCatalog } from '../shared/commands.ts';
import { CommandCatalogWatch } from '../server/command-catalog.ts';
import type { NativeEndpoint, NativeEvent } from '../server/native-api.ts';
const command = (id: string) => ({ command_id: id, action: 'shell', binding_labels: ['prefix+f12'], description: '<b>literal</b>' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function endpoint(supported = true) {
  let event: (event: NativeEvent) => void = () => {}, fail: (error: Error) => void = () => {};
  let stops = 0, subscriptions = 0;
  const reads: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const api: NativeEndpoint = {
    version: 'test', capabilities: { command_catalog: supported },
    request(method) { assert.equal(method, 'command.list'); return new Promise((resolve, reject) => reads.push({ resolve, reject })); },
    async subscribe(spec, receive, closed) { assert.deepEqual(spec, [{ type: 'command.manifest_changed' }]); subscriptions++; event = receive; fail = closed; return () => { stops++; }; },
    close() {},
  };
  return { api, reads, changed: () => event({ event: 'command.manifest_changed', data: {} }), fail: () => fail(new Error('closed')), stops: () => stops, subscriptions: () => subscriptions };
}

test('catalog strips foreign fields and skips future kinds without changing known command order', () => {
  const parsed = commandCatalog([{ ...command('first'), command: 'private executable' }, { action: 'future' }, command('second')]);
  assert.deepEqual(parsed, [command('first'), command('second')]);
  assert(!JSON.stringify(parsed).includes('private executable'));
  assert.throws(() => commandCatalog([command('same'), command('same')]));
  assert.throws(() => commandCatalog([{ ...command('bad'), binding_labels: ['x'.repeat(129)] }]));
  assert.deepEqual(commandCatalog([]), []);
});

test('catalog reload while a read is pending discards stale IDs and coalesces refreshes', async () => {
  const native = endpoint(), seen: (CommandCatalog | undefined)[] = [];
  const watch = new CommandCatalogWatch(value => seen.push(value));
  try {
    watch.reconcile(native.api); await tick(); assert.equal(native.reads.length, 1);
    native.changed(); native.changed(); native.reads[0].resolve({ commands: [command('old')] });
    await tick(); assert.equal(native.reads.length, 2);
    assert(!seen.some(value => value?.status === 'ready'));
    native.reads[1].resolve({ commands: [command('new')] }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', commands: [command('new')] });
    watch.reconcile(native.api); await tick(); assert.equal(native.reads.length, 2);
  } finally { watch.dispose(); }
  assert.equal(native.stops(), 1);
});

test('replacement and disconnect reject late results and old events', async () => {
  const first = endpoint(), second = endpoint(), seen: (CommandCatalog | undefined)[] = [];
  const watch = new CommandCatalogWatch(value => seen.push(value));
  try {
    watch.reconcile(first.api); await tick(); watch.reconcile(second.api); await tick();
    first.reads[0].resolve({ commands: [command('old')] }); first.changed();
    second.reads[0].resolve({ commands: [command('new')] }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', commands: [command('new')] });
    assert(!seen.some(value => value?.commands.some(item => item.command_id === 'old')));
    watch.reconcile(); first.changed(); second.changed(); await tick();
    assert.equal(seen.at(-1), undefined); assert.equal(first.stops(), 1); assert.equal(second.stops(), 1);
  } finally { watch.dispose(); }
});

test('unsupported endpoints are untouched and optional catalog failures clear command authority', async () => {
  const old = endpoint(false), native = endpoint(), seen: (CommandCatalog | undefined)[] = [];
  const watch = new CommandCatalogWatch(value => seen.push(value));
  try {
    watch.reconcile(old.api); await tick(); assert.equal(old.subscriptions(), 0); assert.equal(old.reads.length, 0);
    watch.reconcile(native.api); await tick(); native.reads[0].resolve({ commands: [command('known')] }); await tick();
    native.fail(); assert.deepEqual(seen.at(-1), { status: 'unavailable', commands: [] });
    assert.equal(native.stops(), 1);
    native.changed(); await tick(); assert.equal(native.reads.length, 1);
  } finally { watch.dispose(); }
});

test('catalog subscription failure retries independently and ignores late output from the failed attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = endpoint(), seen: (CommandCatalog | undefined)[] = [];
  const watch = new CommandCatalogWatch(value => seen.push(value));
  try {
    watch.reconcile(native.api); await tick(); native.fail();
    context.mock.timers.tick(5000); await tick(); assert.equal(native.subscriptions(), 2);
    native.reads[1].resolve({ commands: [command('recovered')] }); await tick();
    native.reads[0].resolve({ commands: [command('late')] }); await tick();
    assert.deepEqual(seen.at(-1), { status: 'ready', commands: [command('recovered')] });
    native.changed(); await tick(); native.reads[2].reject(new Error('read failed')); await tick();
    assert.deepEqual(seen.at(-1), { status: 'unavailable', commands: [] });
    watch.dispose(); context.mock.timers.tick(15000); await tick(); assert.equal(native.subscriptions(), 2);
  } finally { watch.dispose(); }
});
