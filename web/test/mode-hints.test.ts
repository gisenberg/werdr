import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShortcuts } from '../shared/shortcuts';
import { copyModeHints, modeHints } from '../src/mode-hints';

test('copy hints distinguish search cancellation, selection clearing and exit', () => {
  assert.deepEqual(copyModeHints(true, true, true).map(hint => hint.description), ['search', 'cancel search']);
  assert.deepEqual(copyModeHints(false, false, false).at(-1), { keys: 'q / Escape', description: 'exit' });
  assert.deepEqual(copyModeHints(false, true, true).slice(-2).map(hint => hint.description), ['clear', 'exit']);
  assert.equal(copyModeHints(false, true, true)[3].description, 'selecting');
});

test('mode hints preserve native context and omit the ordinary terminal banner', () => {
  assert.deepEqual(modeHints('terminal', defaultShortcuts), []);
  assert.deepEqual(modeHints('prefix', defaultShortcuts).map(hint => hint.description), ['cancel', 'send prefix', 'workspace nav', 'keybinds']);
  assert.deepEqual(modeHints('resize', defaultShortcuts).map(hint => hint.description), ['width', 'height', 'done']);
  assert.equal(modeHints('navigate', defaultShortcuts).at(-1)?.description, 'keybinds');
});

test('hints use configured prefix suffixes and never advertise unavailable direct bindings', () => {
  const shortcuts = structuredClone(defaultShortcuts);
  shortcuts.prefix = 'ctrl+a'; shortcuts.bindings.help = ['ctrl+k', 'prefix+f1'];
  shortcuts.bindings.workspace_picker = []; shortcuts.bindings.navigate_workspace_up = ['k']; shortcuts.bindings.navigate_workspace_down = ['j'];
  assert.equal(modeHints('prefix', shortcuts)[1].keys, 'ctrl+a');
  assert.equal(modeHints('prefix', shortcuts)[2].keys, 'UNBOUND');
  assert.equal(modeHints('prefix', shortcuts)[3].keys, 'f1');
  assert.equal(modeHints('navigate', shortcuts)[1].keys, 'k / j');
});
