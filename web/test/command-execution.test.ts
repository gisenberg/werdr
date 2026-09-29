import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAction } from '../server/browser-actions.ts';
import { commandEffect } from '../shared/commands.ts';
const target = { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term1' };
const selection = { pane_id: 'w1:p1', anchor: { row: 1, col: 0 }, cursor: { row: 1, col: 3 }, content_revision: 8 };
test('browser execution sends only opaque command authority, exact target and versioned selection', () => {
  assert.deepEqual(browserAction({ action: 'command.execute', command_id: 'opaque', target: { ...target, argv: ['bad'] }, selection: { ...selection, text: 'forged' }, command: 'bad', env: { BAD: 'yes' } }), { method: 'command.execute', params: { command_id: 'opaque', target, selection } });
  assert.deepEqual(browserAction({ action: 'command.execute', command_id: 'opaque', target: null }), { method: 'command.execute', params: { command_id: 'opaque', target: null } });
  for (const extra of [{ target: undefined }, { target: { ...target, terminal_id: undefined } }, { selection: { ...selection, pane_id: 'other' } }, { selection: { ...selection, content_revision: undefined } }, { command_id: 'echo unsafe;' }]) assert.throws(() => browserAction({ action: 'command.execute', command_id: 'opaque', target, ...extra }));
});
test('only typed producer outcomes become command navigation targets', () => {
  assert.deepEqual(commandEffect({ type: 'pane_created', pane: { ...target, command: 'private' } }), { type: 'pane_created', pane: target });
  assert.deepEqual(commandEffect({ type: 'shell_started', pane: target }), { type: 'shell_started' });
  assert.deepEqual(commandEffect({ type: 'future', pane: target }), { type: 'unknown' });
  assert.throws(() => commandEffect({ type: 'pane_created', pane: { ...target, terminal_id: undefined } }));
  assert.throws(() => commandEffect({ type: 'popup_opened', popup: null }));
});
