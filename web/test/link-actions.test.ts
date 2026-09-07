import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activatePaneLink } from '../server/link-actions.ts';

test('link activation focuses the explicit pane and forwards the exact viewport revision', async () => {
  const calls: unknown[] = [];
  const result = await activatePaneLink({ id: 'pane-1', viewport_row: 2, col: 9, content_revision: 10, offset_from_bottom: 30 }, async (method, params) => { calls.push({ method, params }); return { handled: true }; });
  assert.deepEqual(calls, [{ method: 'pane.focus', params: { pane_id: 'pane-1' } }, { method: 'pane.link.activate', params: { pane_id: 'pane-1', viewport_row: 2, col: 9, content_revision: 10, offset_from_bottom: 30 } }]);
  assert.equal(result.handled, true);
});

test('invalid link coordinates, missing revision and missing offset cannot change native focus', async () => {
  const valid = { id: 'pane-1', viewport_row: 2, col: 9, content_revision: 10, offset_from_bottom: 30 };
  for (const patch of [{ viewport_row: -1 }, { viewport_row: 65536 }, { col: .5 }, { col: 65536 }, { content_revision: undefined }, { content_revision: 11 }, { offset_from_bottom: undefined }, { offset_from_bottom: -1 }]) {
    let calls = 0;
    await assert.rejects(activatePaneLink({ ...valid, ...patch }, async () => { ++calls; })); assert.equal(calls, 0);
  }
});
