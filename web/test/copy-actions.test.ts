import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAction } from '../server/browser-actions.ts';
import { copyContext } from '../server/copy-actions.ts';

const cursor = { row: 200, col: 3 };
const selection = { action: 'pane.selection.read', id: 'pane-1', anchor: { row: 190, col: 0 }, cursor, content_revision: 24 };
test('browser copies require a stable, exact content revision', () => {
  assert.deepEqual(browserAction(selection), { method: 'pane.selection.read', params: { pane_id: 'pane-1', anchor: selection.anchor, cursor, content_revision: 24 } });
  for (const content_revision of [undefined, null, -2, 1, 1.5, '24', Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => browserAction({ ...selection, content_revision }));
  for (const position of [null, [], {}, { row: -1, col: 0 }, { row: 2 ** 32, col: 0 }, { row: 0, col: 65536 }, { row: 0, col: '1' }]) assert.throws(() => browserAction({ ...selection, cursor: position }));
});
test('native revision acquisition allows only bounded, nonmutating motions', () => {
  const value = { action: 'pane.copy_motion', id: 'pane-1', cursor, motion: 'line_end' };
  assert.deepEqual(browserAction(value).params, { pane_id: 'pane-1', cursor, motion: 'line_end' });
  assert.throws(() => browserAction({ ...value, motion: 'execute' }));
});
test('search preserves native coordinates and validates UTF-8 byte limits and repeat ranges', () => {
  const previous = { start: { row: 4, col: 1 }, end: { row: 4, col: 5 } };
  const value = { action: 'pane.copy_search', id: 'pane-1', cursor, query: '東京', direction: 'backward', content_revision: 24, previous };
  assert.deepEqual(browserAction(value).params, { pane_id: 'pane-1', cursor, query: '東京', direction: 'backward', content_revision: 24, previous });
  for (const query of ['', '\0', '界'.repeat(1366)]) assert.throws(() => browserAction({ ...value, query }));
  for (const range of [null, [], {}, { start: cursor }]) assert.throws(() => browserAction({ ...value, previous: range }));
  assert.throws(() => browserAction({ ...value, direction: 'sideways' }));
});
test('scroll accepts only bounded absolute native offsets', () => {
  assert.deepEqual(browserAction({ action: 'pane.scroll', id: 'pane-1', offset_from_bottom: 0 }).params, { pane_id: 'pane-1', offset_from_bottom: 0 });
  for (const offset_from_bottom of [-1, .5, '100', Infinity]) assert.throws(() => browserAction({ action: 'pane.scroll', id: 'pane-1', offset_from_bottom }));
});

test('copy context brackets native geometry and exposes only scroll fields', async () => {
  const calls: { method: string; params: any; invalidate?: boolean }[] = [];
  const result = await copyContext({ id: 'pane-1' }, async (method, params, invalidate) => {
    calls.push({ method, params, invalidate });
    return method === 'pane.get' ? { pane: { revision: 0, cwd: '/private', scroll: { offset_from_bottom: 5, max_offset_from_bottom: 200, viewport_rows: 24 } } } : method === 'pane.read' ? { read: { text: 'visible\n', truncated: false } } : { content_revision: 42 };
  });
  assert.deepEqual(result, { pane_id: 'pane-1', content_revision: 42, viewport_text: 'visible\n', scroll: { offset_from_bottom: 5, max_offset_from_bottom: 200, viewport_rows: 24 } });
  assert.deepEqual(calls.map(call => call.method), ['pane.copy_motion', 'pane.get', 'pane.read', 'pane.get', 'pane.copy_motion']);
  assert.equal(calls[4].params.content_revision, 42); assert.ok(calls.every(call => call.invalidate === false));
});
test('copy context fails when content changes during geometry acquisition', async () => {
  let reads = 0;
  await assert.rejects(copyContext({ id: 'pane-1' }, async method => {
    if (method === 'pane.get') return { pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 200, viewport_rows: 24 } } };
    if (method === 'pane.read') return { read: { text: 'visible\n', truncated: false } };
    if (++reads === 2) throw new Error('stale_content');
    return { content_revision: 42 };
  }), /stale_content/);
  await assert.rejects(copyContext({ id: 'pane-1' }, async () => ({ content_revision: 43 })), /changing/);
});

test('copy context rejects viewport movement during the native text read', async () => {
  let reads = 0;
  await assert.rejects(copyContext({ id: 'pane-1' }, async method => {
    if (method === 'pane.get') return { pane: { scroll: { offset_from_bottom: reads++, max_offset_from_bottom: 200, viewport_rows: 24 } } };
    if (method === 'pane.read') return { read: { text: 'visible\n', truncated: false } };
    return { content_revision: 42 };
  }), /viewport changed/);
});
