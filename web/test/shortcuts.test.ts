import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultShortcuts, shortcutDefaults, validateShortcuts, parseChord, matchesChord, type ShortcutKey } from '../shared/shortcuts.ts';
import { ShortcutMode } from '../src/shortcut-mode.ts';
import { defaults } from '../shared/settings.ts';
import { settingsStore } from '../server/settings.ts';
const key = (key: string, extra: Partial<ShortcutKey> = {}): ShortcutKey => ({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, getModifierState: () => false, ...extra });
const press = (mode: ShortcutMode, name: string, extra: Partial<ShortcutKey> = {}) => { const event = key(name, extra); const result = mode.down(event); mode.up(event.code); return result; };
const prefix = (mode: ShortcutMode) => press(mode, 'b', { ctrlKey: true });

test('browser prefix defaults match native actions and retain browser aliases', async () => {
  const native = (await readFile('../src/config/model.rs', 'utf8')).split('impl Default for KeysConfig {')[1].split('impl Default for WorktreesConfig')[0];
  for (const [action, bindings] of Object.entries(shortcutDefaults)) {
    if (action === 'command_palette') continue;
    const match = native.match(new RegExp(`${action}: BindingConfig::(?:one\\("([^"]+)"\\)|empty\\(\\))`));
    assert.ok(match, action); assert.deepEqual(bindings.filter(value => value.startsWith('prefix+')), match[1] ? [match[1]] : [], action);
  }
  assert.deepEqual(validateShortcuts(defaultShortcuts), defaultShortcuts);
});
test('prefix is one-shot, swallows unknown keys, preserves modifiers, and forwards double prefix', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  assert.equal(prefix(mode).consume, true); assert.equal(mode.mode, 'prefix');
  assert.equal(press(mode, 'Shift').consume, false); assert.equal(mode.mode, 'prefix');
  assert.equal(press(mode, 'N', { shiftKey: true }).action, 'new_workspace'); assert.equal(mode.mode, 'terminal');
  prefix(mode); assert.equal(press(mode, 'f').consume, true); assert.equal(mode.mode, 'terminal');
  prefix(mode); assert.equal(prefix(mode).consume, false); assert.equal(mode.mode, 'terminal');
  prefix(mode); assert.equal(press(mode, 'Escape').consume, true); assert.equal(mode.mode, 'terminal');
  prefix(mode); assert.equal(press(mode, '?', { shiftKey: true }).action, 'help');
  prefix(mode); assert.equal(press(mode, '9').index, 8);
  prefix(mode); assert.equal(press(mode, 'k', { ctrlKey: true }).action, undefined);
  assert.equal(press(mode, 'k', { ctrlKey: true }).action, 'command_palette');
});
test('resize persists, accepts modified arrows and exits through native keys', () => {
  const mode = new ShortcutMode(defaultShortcuts); prefix(mode); assert.equal(press(mode, 'r').action, 'resize_mode');
  for (const event of [key('h'), key('ArrowLeft', { altKey: true }), key('ArrowLeft', { shiftKey: true })]) { assert.equal(mode.down(event).action, 'resize_pane_left'); mode.up(event.code); assert.equal(mode.mode, 'resize'); }
  assert.equal(press(mode, 'q').consume, true); assert.equal(mode.mode, 'resize'); press(mode, 'r'); assert.equal(mode.mode, 'terminal');
  for (const exit of ['Enter', 'Escape']) { prefix(mode); press(mode, 'r'); press(mode, exit); assert.equal(mode.mode, 'terminal'); }
});
test('held commands cannot enter twice, repeat mutations, or leak after a context reset', () => {
  const mode = new ShortcutMode(defaultShortcuts), chord = key('b', { ctrlKey: true }); mode.down(chord);
  assert.deepEqual(mode.down({ ...chord, repeat: true }), { consume: true }); assert.equal(mode.mode, 'prefix'); mode.up(chord.code);
  const split = key('v'); assert.equal(mode.down(split).action, 'split_vertical');
  mode.reset(); assert.deepEqual(mode.down({ ...split, repeat: true }), { consume: true }); assert.equal(mode.up(split.code), true);
  prefix(mode); press(mode, 'r'); const arrow = key('ArrowLeft'); mode.down(arrow);
  assert.equal(mode.down({ ...arrow, repeat: true }).action, 'resize_pane_left'); mode.reset(); assert.equal(mode.down({ ...arrow, repeat: true }).action, undefined);
});
test('composition and AltGraph bypass commands and disarm pending modes', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { key: 'Dead' }, { getModifierState: (name: string) => name === 'AltGraph' }]) {
    prefix(mode); assert.equal(mode.down(key('v', extra)).consume, false); assert.equal(mode.mode, 'terminal');
  }
});
test('bindings reject ambiguous, oversized, indexed misuse and clipboard assignments', () => {
  for (const value of [null, { ...defaultShortcuts, prefix: 'b' }, { ...defaultShortcuts, prefix: 'ctrl+v' }, { ...defaultShortcuts, prefix: 'prefix+b' }, { ...defaultShortcuts, bindings: { ...shortcutDefaults, help: ['ctrl+k'] } }, { ...defaultShortcuts, bindings: { ...shortcutDefaults, help: ['ctrl+c'] } }, { ...defaultShortcuts, bindings: { ...shortcutDefaults, help: ['prefix+1..9'] } }, { ...defaultShortcuts, bindings: { ...shortcutDefaults, help: ['shift++'] } }, { ...defaultShortcuts, bindings: { ...shortcutDefaults, nope: [] } }]) assert.throws(() => validateShortcuts(value));
  const custom = validateShortcuts({ prefix: 'ctrl+a', bindings: { help: ['prefix+f1'], close_pane: [] } });
  const mode = new ShortcutMode(custom); assert.equal(prefix(mode).consume, false); press(mode, 'a', { ctrlKey: true }); assert.equal(press(mode, 'F1').action, 'help');
  assert.equal(matchesChord(parseChord('prefix+shift+tab'), key('Tab', { shiftKey: true })), true);
});
test('version-seven preferences migrate keybindings privately without resetting revision or existing preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-keys-')), path = join(directory, 'settings.json');
  try {
    const { shortcuts, ...previous } = { ...defaults, theme: 'nord', collapsedWorkspaceGroups: ['saved'] };
    await writeFile(path, JSON.stringify({ version: 7, revision: 31, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path); assert.deepEqual(store.read(), { revision: 31, preferences: { ...previous, shortcuts } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 8);
    const changed = structuredClone(store.read()); changed.preferences.shortcuts.prefix = 'ctrl+a';
    await store.update(31, changed.preferences); changed.preferences.shortcuts.bindings.help.length = 0;
    assert.deepEqual((await settingsStore(path)).read().preferences.shortcuts.bindings.help, ['prefix+?']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('copy mode retains its direct keys while allowing prefix commands and browser palette', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  assert.equal(mode.down(key('d', { ctrlKey: true }), true).consume, false);
  assert.equal(mode.down(key('k', { ctrlKey: true }), true).action, 'command_palette'); mode.up('KeyK');
  assert.equal(mode.down(key('b', { ctrlKey: true }), true).consume, true); mode.up('KeyB');
  assert.equal(mode.down(key('s'), true).action, 'settings');
});

test('native modifier aliases, uppercase bindings and named prefixes normalize without ambiguous matches', () => {
  assert.deepEqual(parseChord('N+control'), parseChord('ctrl+shift+n'));
  assert.deepEqual(parseChord('command+option+x'), parseChord('super+alt+x'));
  assert.deepEqual(parseChord('meta+bs'), parseChord('alt+backspace'));
  const mode = new ShortcutMode(validateShortcuts({ ...defaultShortcuts, prefix: 'esc' }));
  assert.equal(press(mode, 'Escape').consume, true); assert.equal(press(mode, 'Escape').consume, false);
  for (const bindings of [{ ...shortcutDefaults, help: null }, { ...shortcutDefaults, help: ['prefix+?', 'prefix+shift+?'] }, { ...shortcutDefaults, help: ['prefix+ctrl+c'] }, { ...shortcutDefaults, help: ['prefix+ctrl+b'] }]) assert.throws(() => validateShortcuts({ ...defaultShortcuts, bindings }));
  assert.deepEqual(validateShortcuts({ ...defaultShortcuts, bindings: { ...shortcutDefaults, switch_tab: ['prefix+1..9 '] } }).bindings.switch_tab, ['prefix+1..9']);

});

test('repeats already held by terminal input never become new commands or steal their release', () => {
  const mode = new ShortcutMode(defaultShortcuts); prefix(mode);
  assert.deepEqual(mode.down(key('v', { repeat: true })), { consume: true }); assert.equal(mode.mode, 'prefix'); assert.equal(mode.up('KeyV'), false);
  mode.blur(); assert.deepEqual(mode.down(key('d', { ctrlKey: true, repeat: true })), { consume: true }); assert.equal(mode.up('KeyD'), false);
  assert.deepEqual(parseChord('N+shift'), parseChord('shift+n'));
  assert.equal(parseChord('backslash').key.length, 1);
});
