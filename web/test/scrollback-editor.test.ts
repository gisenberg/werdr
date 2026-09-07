import test from 'node:test';
import assert from 'node:assert/strict';
import { openScrollbackEditor, paneExists } from '../server/scrollback-editor.ts';
import { NativeApiError } from '../server/native-api.ts';

const source = { pane_id: 'pane:1', workspace_id: 'workspace:1', tab_id: 'tab:1' };
const editor = { ...source, pane_id: 'pane:2', cwd: '/private' };
test('scrollback editor uses the selected native pane and never accepts executable substitutions', async () => {
  const calls: { method: string; params?: object; invalidate?: boolean }[] = []; let reads = 0;
  const result = await openScrollbackEditor({ id: source.pane_id, command: ['bad'], editor: 'bad', env: { EDITOR: 'bad' } }, async (method, params, invalidate) => {
    calls.push({ method, params, invalidate });
    if (method === 'pane.get') return { pane: source };
    if (method === 'pane.list') return { panes: ++reads === 1 ? [source] : [source, editor] };
    return {};
  });
  assert.deepEqual(calls.map(call => call.method), ['pane.get', 'pane.list', 'pane.focus', 'pane.edit_scrollback', 'pane.list']);
  assert.deepEqual(calls[2].params, { pane_id: source.pane_id }); assert.deepEqual(calls[3].params, { pane_id: source.pane_id });
  assert.deepEqual(result, { pane: { pane_id: 'pane:2', workspace_id: 'workspace:1', tab_id: 'tab:1' } });
});
test('graphical or short-lived editors and concurrent pane creation never select arbitrary terminals', async () => {
  for (const added of [[], [editor, { ...editor, pane_id: 'pane:3' }], [{ ...editor, tab_id: 'tab:other' }]]) {
    let reads = 0;
    const result = await openScrollbackEditor({ id: source.pane_id }, async method => method === 'pane.get' ? { pane: source } : method === 'pane.list' ? { panes: ++reads === 1 ? [source] : [source, ...added] } : {});
    assert.ok(result.notice); assert.equal(result.pane, undefined);
  }
});
test('native editor rejection stops discovery and remains visible to the caller', async () => {
  const calls: string[] = [];
  await assert.rejects(openScrollbackEditor({ id: source.pane_id }, async method => {
    calls.push(method);
    if (method === 'pane.get') return { pane: source };
    if (method === 'pane.list') return { panes: [source] };
    if (method === 'pane.edit_scrollback') throw new NativeApiError('pane is no longer focused', 'stale_pane_target');
    return {};
  }), /no longer focused/);
  assert.equal(calls.at(-1), 'pane.edit_scrollback');
});
test('pane existence distinguishes authoritative removal from connectivity failures', async () => {
  assert.deepEqual(await paneExists({ id: 'pane:1' }, async () => ({})), { exists: true });
  assert.deepEqual(await paneExists({ id: 'pane:1' }, async () => { throw new NativeApiError('gone', 'pane_not_found'); }), { exists: false });
  await assert.rejects(paneExists({ id: 'pane:1' }, async () => { throw new NativeApiError('offline', 'offline'); }), /offline/);
});
