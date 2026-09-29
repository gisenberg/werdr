import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPaneScroll } from '../src/initial-pane-scroll.ts';

const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 5, viewport_rows: 24, alternate_screen_active: false };
test('initial pane scroll retains native identity and validates optional screen metadata', async () => {
  assert.deepEqual(await initialPaneScroll(async () => ({ terminal_id: 'terminal-a', scroll })), { terminalId: 'terminal-a', scroll });
  assert.deepEqual(await initialPaneScroll(async () => ({ scroll: { ...scroll, alternate_screen_active: true } })), { terminalId: undefined, scroll: { ...scroll, alternate_screen_active: true } });
  const { alternate_screen_active: _, ...legacy } = scroll;
  assert.deepEqual(await initialPaneScroll(async () => ({ scroll: legacy })), { terminalId: undefined, scroll: legacy });
  assert.deepEqual(await initialPaneScroll(async () => ({ terminal_id: 5, scroll: { ...scroll, viewport_rows: -1 } })), { terminalId: undefined, scroll: undefined });
});
test('unavailable optional pane metadata does not reject attachment', async () => {
  assert.equal(await initialPaneScroll(async () => { throw new Error('unsupported'); }), undefined);
  assert.equal(await initialPaneScroll(async () => null), undefined);
});
test('initial metadata has a bounded deadline and ignores late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (value: unknown) => void;
  const pending = initialPaneScroll(() => new Promise(done => { resolve = done; }), 2000);
  t.mock.timers.tick(2000);
  assert.equal(await pending, undefined);
  resolve({ terminal_id: 'late', scroll });
  assert.equal(await pending, undefined);
});
