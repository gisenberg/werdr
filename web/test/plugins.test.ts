import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginAction } from '../server/plugin-actions.ts';

test('plugin actions preserve the host-native context and never accept executable or environment substitutions', async () => {
  const calls: { method: string; params: object }[] = [];
  const request = async (method: string, params: object = {}) => { calls.push({ method, params }); return {}; };
  await pluginAction({ action: 'plugin.action.invoke', plugin_id: 'example.workflow', action_id: 'inspect', pane_id: 'pane:2', selected_text: 'selected\ntext', context: { cwd: '/wrong', focused_pane_id: 'pane:1' }, command: ['bad'], env: { BAD: 'yes' } }, request);
  assert.deepEqual(calls, [{ method: 'pane.focus', params: { pane_id: 'pane:2' } }, { method: 'plugin.action.invoke', params: { plugin_id: 'example.workflow', action_id: 'inspect', context: { invocation_source: 'browser', selected_text: 'selected\ntext' } } }]);
  calls.length = 0;
  await pluginAction({ action: 'plugin.link', path: '/a plugin', enabled: false, source: { kind: 'github' }, command: ['bad'] }, request);
  assert.deepEqual(calls, [{ method: 'plugin.link', params: { path: '/a plugin', enabled: false } }]);
  await assert.rejects(pluginAction({ action: 'plugin.action.invoke', plugin_id: 'bad/path', action_id: 'a' }, request));
  await assert.rejects(pluginAction({ action: 'plugin.action.invoke', plugin_id: 'ok', action_id: 'qualified.action' }, request));
  await assert.rejects(pluginAction({ action: 'plugin.action.invoke', plugin_id: 'ok', action_id: 'a', selected_text: 'x'.repeat(32769) }, request));
});

test('pane placement uses the current native manifest and rejects unsupported popups before creating a process', async () => {
  const calls: { method: string; params: any }[] = [];
  const request = async (method: string, params: object = {}) => { calls.push({ method, params }); return { plugins: [{ plugin_id: 'example.workflow', panes: [{ id: 'board', placement: 'overlay' }, { id: 'popup', placement: 'popup' }] }] }; };
  const input = { action: 'plugin.pane.open', plugin_id: 'example.workflow', entrypoint: 'board', pane_id: 'pane:2', workspace_id: 'ws:1', command: ['bad'], env: { BAD: 'yes' } };
  await pluginAction(input, request);
  assert.deepEqual(calls.map(call => call.method), ['plugin.list', 'pane.focus', 'plugin.pane.open']);
  assert.deepEqual(calls.at(-1)?.params, { plugin_id: 'example.workflow', entrypoint: 'board', placement: 'overlay', focus: true });
  for (const placement of ['split', 'zoomed', 'tab']) {
    calls.length = 0; await pluginAction({ ...input, placement, direction: 'down' }, request);
    assert.deepEqual(calls.at(-1)?.params, { plugin_id: 'example.workflow', entrypoint: 'board', placement, focus: true, ...(placement === 'tab' ? { workspace_id: 'ws:1' } : { target_pane_id: 'pane:2', direction: 'down' }) });
  }
  calls.length = 0; await assert.rejects(pluginAction({ ...input, entrypoint: 'popup' }, request), /not available/);
  assert.deepEqual(calls.map(call => call.method), ['plugin.list']);
  calls.length = 0; await assert.rejects(pluginAction({ ...input, entrypoint: 'gone' }, request), /no longer available/);
  assert.deepEqual(calls.map(call => call.method), ['plugin.list']);
});

test('plugin logs are bounded and registry methods retain native authority', async () => {
  const calls: any[] = []; const request = async (...args: any[]) => { calls.push(args); return {}; };
  await pluginAction({ action: 'plugin.log.list', plugin_id: 'example.workflow' }, request);
  assert.deepEqual(calls, [['plugin.log.list', { plugin_id: 'example.workflow', limit: 50 }, false]]);
  await assert.rejects(pluginAction({ action: 'plugin.log.list', limit: 1000000 }, request), /between 1 and 200/);
  await pluginAction({ action: 'plugin.log.list', limit: 200 }, request);
  assert.deepEqual(calls.at(-1), ['plugin.log.list', { limit: 200 }, false]);
  await assert.rejects(pluginAction({ action: 'plugin.anything', plugin_id: 'example.workflow' }, request), /Unsupported/);
  for (const action of ['plugin.enable', 'plugin.disable', 'plugin.unlink']) { await pluginAction({ action, plugin_id: 'example.workflow', path: '/ignored' }, request); assert.deepEqual(calls.at(-1), [action, { plugin_id: 'example.workflow' }]); }
});
