import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollState, scrollbarThumb, scrollbarOffset } from '../shared/scrollbar.ts';
import { PaneScrollWatch } from '../server/pane-scroll-watch.ts';
import type { NativeEndpoint, NativeEvent } from '../server/native-api.ts';

const bottom = { offset_from_bottom: 0, max_offset_from_bottom: 80, viewport_rows: 20, alternate_screen_active: false };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native scrollbar geometry reserves a proportional thumb with exact endpoints and grab offsets', () => {
  assert.deepEqual(scrollbarThumb(bottom, 20), { top: 16, length: 4 });
  assert.deepEqual(scrollbarThumb({ ...bottom, offset_from_bottom: 80 }, 20), { top: 0, length: 4 });
  assert.deepEqual(scrollbarThumb({ ...bottom, offset_from_bottom: 40 }, 20), { top: 8, length: 4 });
  assert.equal(scrollbarOffset(bottom, 20, -10), 80);
  assert.equal(scrollbarOffset(bottom, 20, 30), 0);
  assert.equal(scrollbarOffset(bottom, 20, 10), 40, 'track click centers the thumb');
  assert.equal(scrollbarOffset(bottom, 20, 10, 0), 30, 'drag preserves the grabbed thumb row');
  assert.equal(scrollbarOffset(bottom, 20, 10, 3), 45);
  assert.equal(scrollbarThumb({ ...bottom, max_offset_from_bottom: 0 }, 20), undefined);
  assert.equal(scrollbarOffset(bottom, 1, 0), 0);
  for (const max of [16_777_217, 16_777_219, 1_000_000_007]) { const offset = scrollbarOffset({ ...bottom, max_offset_from_bottom: max }, 20, 30); assert.ok(offset >= 0 && offset <= max, 'large native histories saturate after f32 rounding'); }
  assert.deepEqual(scrollbarThumb({ ...bottom, max_offset_from_bottom: 1_000_000 }, 20), { top: 19, length: 1 });
});
test('scroll metadata validates bounds and preserves unknown screen identity', () => {
  assert.equal(scrollState({ ...bottom, alternate_screen_active: undefined })?.alternate_screen_active, undefined);
  for (const value of [null, {}, { ...bottom, offset_from_bottom: 81 }, { ...bottom, viewport_rows: 0 }, { ...bottom, max_offset_from_bottom: Number.MAX_SAFE_INTEGER }, { ...bottom, offset_from_bottom: .5 }, { ...bottom, alternate_screen_active: 'false' }]) assert.equal(scrollState(value), undefined);
  assert.deepEqual(scrollState(bottom), bottom);
});
class Endpoint implements NativeEndpoint {
  version = 'fixture'; requests = 0; closed = 0;
  event?: (event: NativeEvent) => void; fail?: (error: Error) => void;
  read: () => Promise<unknown> = async () => ({ pane: { scroll: bottom } });
  async request(method: string) { assert.equal(method, 'pane.get'); this.requests++; return this.read(); }
  async subscribe(subscriptions: unknown, receive: (event: NativeEvent) => void, closed: (error: Error) => void) {
    assert.deepEqual(subscriptions, [{ type: 'pane.scroll_changed', pane_id: 'p:one' }]);
    this.event = receive; this.fail = closed; return () => { this.closed++; };
  }
  emit(scroll = bottom) { this.event?.({ event: 'pane.scroll_changed', data: { pane_id: 'p:one', scroll } }); }
  close() {}
}
test('scroll watch uses one bootstrap read, receives deltas and never lets a slow read overwrite a newer event', async () => {
  const endpoint = new Endpoint(), values: unknown[] = [];
  let finish!: (value: unknown) => void;
  endpoint.read = () => new Promise(resolve => { finish = resolve; });
  const watch = new PaneScrollWatch('p:one', value => values.push(value)); watch.reconcile(endpoint); await tick();
  const scrolled = { ...bottom, offset_from_bottom: 40 }; endpoint.emit(scrolled);
  finish({ pane: { scroll: bottom } }); await tick();
  assert.deepEqual(values.at(-1), scrolled);
  for (let offset = 0; offset < 80; offset++) endpoint.emit({ ...bottom, offset_from_bottom: offset });
  assert.equal(endpoint.requests, 1, 'output and scroll deltas never read pane text or fleet snapshots');
  watch.dispose(); const count = values.length; endpoint.emit(); assert.equal(values.length, count); assert.equal(endpoint.closed, 1);
});
test('scroll watch isolates unavailable capabilities and ignores stale endpoint responses during reconnect', async () => {
  const old = new Endpoint(), next = new Endpoint(), values: unknown[] = [];
  let finish!: (value: unknown) => void; old.read = () => new Promise(resolve => { finish = resolve; });
  const watch = new PaneScrollWatch('p:one', value => values.push(value)); watch.reconcile(old); await tick();
  watch.reconcile(undefined); watch.reconcile(next); await tick();
  finish({ pane: { scroll: { ...bottom, offset_from_bottom: 40 } } }); old.emit({ ...bottom, offset_from_bottom: 50 }); await tick();
  assert.deepEqual(values.at(-1), bottom); assert.equal(old.closed, 1);
  next.fail!(new Error('Disconnected')); assert.equal(values.at(-1), undefined);
  const missing = new Endpoint(); missing.subscribe = async () => { throw new Error('Unsupported'); };
  watch.reconcile(missing); await tick(); assert.equal(values.at(-1), undefined); assert.equal(missing.requests, 0);
  watch.dispose();
});
