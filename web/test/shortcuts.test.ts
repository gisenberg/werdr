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
    assert.ok(match, action); assert.deepEqual(bindings.filter(value => action.startsWith('navigate_') || value.startsWith('prefix+')), match[1] ? [match[1]] : [], action);
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
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 15);
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

test('Navigate owns its separate keys and resolves prefix commands without stealing terminal letters', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  assert.equal(press(mode, 'h').consume, false);
  mode.mode = 'navigate';
  assert.equal(press(mode, 'ArrowDown').action, 'navigate_workspace_down');
  assert.equal(press(mode, 'h').action, 'navigate_pane_left');
  assert.equal(press(mode, 'ArrowRight').action, 'navigate_pane_right');
  assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, 'f').consume, true); assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, '9').index, 8); assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, 'Enter').navigate, 'confirm'); assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, 'Tab', { shiftKey: true }).action, 'cycle_pane_previous'); assert.equal(mode.mode, 'terminal');
  mode.mode = 'navigate'; assert.equal(press(mode, 'N', { shiftKey: true }).action, 'new_workspace'); assert.equal(mode.mode, 'terminal');
  mode.mode = 'navigate'; assert.equal(press(mode, 'r').action, 'resize_mode'); assert.equal(mode.mode, 'resize');
  mode.mode = 'navigate'; assert.equal(prefix(mode).consume, true); assert.equal(mode.mode, 'terminal');
  mode.mode = 'navigate'; press(mode, 'Escape', { altKey: true }); assert.equal(mode.mode, 'terminal');
});

test('Navigate remaps override prefix right-hand keys while general pane focus bindings stay excluded', () => {
  const configured = validateShortcuts({ ...defaultShortcuts, bindings: { ...shortcutDefaults, navigate_workspace_down: ['n'], navigate_pane_left: ['a'] } });
  const mode = new ShortcutMode(configured); mode.mode = 'navigate';
  assert.equal(press(mode, 'n').action, 'navigate_workspace_down'); assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, 'h').action, undefined); assert.equal(mode.mode, 'navigate');
  assert.equal(press(mode, 'a').action, 'navigate_pane_left');
  mode.reset(); prefix(mode); assert.equal(press(mode, 'n').action, 'next_tab');
  for (const binding of ['prefix+a', 'Escape', 'alt+Escape', 'Enter', 'Tab', 'shift+Tab', 'left', 'right', '1', 'ctrl+b', 'ctrl+c', 'ctrl+v', 'up']) {
    assert.throws(() => validateShortcuts({ ...defaultShortcuts, bindings: { ...shortcutDefaults, navigate_workspace_down: [binding] } }), binding);
  }
});

test('held Navigate movement repeats only while the original mode owns the key', () => {
  const mode = new ShortcutMode(defaultShortcuts); mode.mode = 'navigate';
  const down = key('ArrowDown'); assert.equal(mode.down(down).action, 'navigate_workspace_down');
  assert.equal(mode.down({ ...down, repeat: true }).action, 'navigate_workspace_down');
  mode.reset(); assert.deepEqual(mode.down({ ...down, repeat: true }), { consume: true });
  mode.up(down.code); mode.mode = 'navigate';
  assert.deepEqual(mode.down({ ...down, repeat: true }), { consume: true });
  assert.equal(mode.owns(down.code), false);
});

test('version-eight keybindings migrate Navigate defaults while retaining remaps and revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-navigate-')), path = join(directory, 'settings.json');
  try {
    const bindings = Object.fromEntries(Object.entries(shortcutDefaults).filter(([action]) => !action.startsWith('navigate_')));
    bindings.help = ['prefix+f1']; bindings.close_pane = [];
    await writeFile(path, JSON.stringify({ version: 8, revision: 47, preferences: { ...defaults, shortcuts: { prefix: 'ctrl+a', bindings } } }), { mode: 0o600 });
    const store = await settingsStore(path), settings = store.read();
    assert.equal(settings.revision, 47); assert.equal(settings.preferences.shortcuts.prefix, 'ctrl+a');
    assert.deepEqual(settings.preferences.shortcuts.bindings.help, ['prefix+f1']);
    assert.deepEqual(settings.preferences.shortcuts.bindings.close_pane, []);
    assert.deepEqual(settings.preferences.shortcuts.bindings.navigate_workspace_down, ['down']);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 15);
    assert.deepEqual((await settingsStore(path)).read(), settings);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid indexed prefix fallback leaves Navigate active until the controller finds a target', () => {
  const configured = validateShortcuts({ ...defaultShortcuts, bindings: { ...shortcutDefaults, focus_agent: ['prefix+alt+1..9'] } });
  const mode = new ShortcutMode(configured); mode.mode = 'navigate';
  const result = press(mode, '9', { altKey: true });
  assert.equal(result.action, 'focus_agent'); assert.equal(result.index, 8); assert.equal(mode.mode, 'navigate');
});

test('Navigate retains the browser palette and reset ends held movement leases even after reentry', () => {
  const mode = new ShortcutMode(defaultShortcuts); mode.mode = 'navigate';
  assert.equal(press(mode, 'k', { ctrlKey: true }).action, 'command_palette'); assert.equal(mode.mode, 'terminal');
  for (const state of ['navigate', 'resize'] as const) {
    mode.mode = state; const arrow = key('ArrowLeft'); assert.ok(mode.down(arrow).action);
    mode.reset(); mode.mode = state;
    assert.deepEqual(mode.down({ ...arrow, repeat: true }), { consume: true }); mode.up(arrow.code);
  }
});


test('custom native IDs use effective builtin precedence, manifest order, and indexed fallback', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  const commands = [
    { command_id: 'custom_tab', action: 'shell' as const, binding_labels: ['prefix+1', 'prefix+c'] },
    { command_id: 'duplicate', action: 'shell' as const, binding_labels: ['prefix+1'] },
  ];
  mode.updateCommands(commands);
  prefix(mode); assert.equal(press(mode, 'c').action, 'new_tab');
  prefix(mode); assert.equal(press(mode, '1').command, 'custom_tab');
  prefix(mode); assert.equal(press(mode, '2').action, 'switch_tab');
  mode.update(validateShortcuts({ ...defaultShortcuts, bindings: { new_tab: ['prefix+f11'] } }));
  prefix(mode); assert.equal(press(mode, 'c').command, 'custom_tab');
  mode.updateCommands([]); prefix(mode); assert.equal(press(mode, '1').action, 'switch_tab');
});

test('custom commands respect copy and Navigate scopes, composition, repeats and catalog replacement', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  mode.updateCommands([{ command_id: 'native', action: 'shell', binding_labels: ['prefix+f12', 'alt+f12', 'not-a-browser-key'] }]);
  assert.equal(mode.down(key('F12', { altKey: true }), true).consume, false);
  prefix(mode); const event = key('F12'); assert.equal(mode.down(event, true).command, 'native');
  assert.deepEqual(mode.down({ ...event, repeat: true }), { consume: true }); mode.up(event.code);
  mode.mode = 'navigate'; assert.equal(press(mode, 'F12').command, 'native'); assert.equal(mode.mode, 'terminal');
  prefix(mode); mode.updateCommands([{ command_id: 'replacement', action: 'shell', binding_labels: ['prefix+f12'] }]);
  assert.equal(press(mode, 'F12').consume, false);
  prefix(mode); assert.equal(mode.down(key('F12', { isComposing: true })).consume, false);
});


test('effective browser prefix remains reachable when endpoint custom commands use that chord', () => {
  const mode = new ShortcutMode(defaultShortcuts);
  mode.updateCommands([{ command_id: 'native', action: 'shell', binding_labels: ['ctrl+b', 'ctrl+a', 'prefix+ctrl+a'] }]);
  assert.equal(prefix(mode).command, undefined); assert.equal(mode.mode, 'prefix');
  assert.equal(press(mode, 'v').action, 'split_vertical');
  mode.update(validateShortcuts({ ...defaultShortcuts, prefix: 'ctrl+a' }));
  assert.equal(press(mode, 'a', { ctrlKey: true }).command, undefined); assert.equal(mode.mode, 'prefix');
  assert.equal(press(mode, 'a', { ctrlKey: true }).consume, false);
  assert.equal(press(mode, 'b', { ctrlKey: true }).command, 'native');
});
