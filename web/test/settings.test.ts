import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settingsStore } from '../server/settings.ts';
import { defaults, palette, themeNames, validatePreferences } from '../shared/settings.ts';

test('browser palettes match native source and all theme tokens resolve to colors', async () => {
  await promisify(execFile)(process.execPath, ['../werdr/export-themes.mjs', '--check']);
  assert.equal(themeNames.length, 18);
  for (const theme of themeNames) for (const color of Object.values(palette({ ...defaults, theme }, false))) assert.match(color, /^#[a-f0-9]{6}$/i, theme);
  assert.equal(palette({ ...defaults, appearance: 'system' }, true).panel_bg, '#eff1f5');
  assert.equal(palette({ ...defaults, customColors: { accent: '#123456' } }, false).accent, '#123456');
});
test('settings reject malformed values, unsafe CSS and unexpected fields', () => {
  for (const value of [{ theme: 'missing' }, { fontSize: NaN }, { sidebarSectionPercent: 9 }, { sidebarSectionPercent: 91 }, { sidebarSectionPercent: 50.5 }, { sidebarSectionPercent: null }, { sidebarWidth: 9999 }, { confirmClose: 'false' }, { customColors: { accent: 'url(example)' } }, { customColors: { unknown: '#123456' } }, { toString: 'unexpected' }, { appearance: 'random' }, { tabBarPosition: 'left' }, { paneBorders: 'false' }, { paneGaps: null }, { paneScrollbars: 'false' }, { copyOnSelect: 'false' }]) assert.throws(() => validatePreferences(value));
});
test('settings serialize concurrent edits, persist privately, and reject future/corrupt stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-test-')), path = join(directory, 'settings.json');
  try {
    const store = await settingsStore(path);
    const results = await Promise.allSettled([store.update(0, { ...defaults, theme: 'nord' }), store.update(0, { ...defaults, theme: 'dracula' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const state = (await settingsStore(path)).read(); assert.equal(state.revision, 1); assert.equal(state.preferences.theme, 'nord');
    state.preferences.customColors.accent = '#ffffff'; assert.equal(store.read().preferences.customColors.accent, undefined);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const valid = await readFile(path, 'utf8');
    await writeFile(path, JSON.stringify({ version: 11, revision: 1, preferences: defaults })); await assert.rejects(settingsStore(path), /unsupported/);
    await writeFile(path, 'null'); await assert.rejects(settingsStore(path), /unsupported/);
    await writeFile(path, valid); await assert.rejects(store.update(0, defaults), /another browser/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('version-one settings migrate once without losing revision or preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-migration-')), path = join(directory, 'settings.json');
  try {
    const { sidebarSectionPercent, ...previous } = { ...defaults, theme: 'nord', sidebarWidth: 320 };
    await writeFile(path, JSON.stringify({ version: 1, revision: 7, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.equal(store.read().revision, 7);
    assert.deepEqual(store.read().preferences, { ...previous, sidebarSectionPercent: 50 });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    await store.update(7, { ...store.read().preferences, sidebarSectionPercent: 65 });
    assert.equal((await settingsStore(path)).read().preferences.sidebarSectionPercent, 65);
    await writeFile(path, JSON.stringify({ version: 1, revision: 7, preferences: null }));
    await assert.rejects(settingsStore(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('version-two sidebar settings acquire native pane chrome defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-v2-')), path = join(directory, 'settings.json');
  try {
    const { paneBorders, paneOuterBorders, paneGaps, showAgentLabelsOnPaneBorders, tabBarPosition, ...previous } = { ...defaults, sidebarSectionPercent: 65, theme: 'nord' };
    await writeFile(path, JSON.stringify({ version: 2, revision: 11, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.deepEqual(store.read(), { revision: 11, preferences: { ...previous, paneBorders: true, paneOuterBorders: true, paneGaps: true, showAgentLabelsOnPaneBorders: false, tabBarPosition: 'top' } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    await store.update(11, { ...store.read().preferences, paneOuterBorders: false, tabBarPosition: 'bottom' });
    assert.deepEqual((await settingsStore(path)).read(), store.read());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('version-three chrome settings migrate scrollbar defaults and preserve saved changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-v3-')), path = join(directory, 'settings.json');
  try {
    const { paneScrollbars, ...previous } = { ...defaults, theme: 'nord', paneBorders: false };
    await writeFile(path, JSON.stringify({ version: 3, revision: 12, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.deepEqual(store.read(), { revision: 12, preferences: { ...previous, paneScrollbars: true } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    await store.update(12, { ...store.read().preferences, paneScrollbars: false });
    assert.equal((await settingsStore(path)).read().preferences.paneScrollbars, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('version-four settings acquire native copy policy and preserve explicit retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-v4-')), path = join(directory, 'settings.json');
  try {
    const { copyOnSelect, ...previous } = { ...defaults, theme: 'nord', paneScrollbars: false };
    await writeFile(path, JSON.stringify({ version: 4, revision: 19, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.deepEqual(store.read(), { revision: 19, preferences: { ...previous, copyOnSelect: true } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    await store.update(19, { ...store.read().preferences, copyOnSelect: false });
    assert.equal((await settingsStore(path)).read().preferences.copyOnSelect, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('version-five settings migrate bounded independent group state without resetting other preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-v5-')), path = join(directory, 'settings.json');
  try {
    const { collapsedWorkspaceGroups, ...previous } = { ...defaults, theme: 'nord', copyOnSelect: false };
    await writeFile(path, JSON.stringify({ version: 5, revision: 20, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.deepEqual(store.read(), { revision: 20, preferences: { ...previous, collapsedWorkspaceGroups: [] } });
    const key = JSON.stringify(['host', 'user@host', 'session', '/repo']);
    await store.update(20, { ...store.read().preferences, collapsedWorkspaceGroups: [key] });
    assert.deepEqual((await settingsStore(path)).read().preferences.collapsedWorkspaceGroups, [key]);
    const snapshot = store.read(); snapshot.preferences.collapsedWorkspaceGroups.length = 0;
    assert.deepEqual(store.read().preferences.collapsedWorkspaceGroups, [key]);
    const migrated = JSON.parse(await readFile(path, 'utf8')); assert.equal(migrated.version, 10);
    const future = JSON.stringify({ ...migrated, version: 11 }); await writeFile(path, future);
    await assert.rejects(settingsStore(path)); assert.equal(await readFile(path, 'utf8'), future);
  } finally { await rm(directory, { recursive: true, force: true }); }
  for (const collapsedWorkspaceGroups of [null, {}, [''], [42], ['same', 'same'], ['a\n'], ['x'.repeat(8193)], Array.from({ length: 257 }, (_, index) => String(index)), Array.from({ length: 5 }, (_, index) => String(index) + '界'.repeat(3000))]) assert.throws(() => validatePreferences({ collapsedWorkspaceGroups }));
});

test('version-six settings add native agent row defaults and retain nested rules across private saves and migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-settings-v6-')), path = join(directory, 'settings.json');
  try {
    const { agentRows, ...previous } = { ...defaults, theme: 'nord', agentSort: 'native', collapsedWorkspaceGroups: ['group'] };
    await writeFile(path, JSON.stringify({ version: 6, revision: 23, preferences: previous }), { mode: 0o600 });
    const store = await settingsStore(path);
    assert.deepEqual(store.read(), { revision: 23, preferences: { ...previous, agentRows } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    const layout = { rows: [['state_icon', '$load']], rows_by_agent: { claude: [[{ token: '$load', rules: [{ gt: 80, fg: '#f44', bold: false }] }]] }, row_gap: 2 };
    await store.update(23, { ...store.read().preferences, agentRows: layout });
    layout.rows_by_agent.claude[0][0].rules[0].fg = '#000';
    const expected = store.read(); assert.equal((expected.preferences.agentRows.rows_by_agent.claude[0][0] as any).rules[0].fg, '#f44');
    expected.preferences.agentRows.rows.length = 0;
    assert.deepEqual((await settingsStore(path)).read(), store.read());
    const future = JSON.stringify({ version: 11, ...store.read() }); await writeFile(path, future);
    await assert.rejects(settingsStore(path)); assert.equal(await readFile(path, 'utf8'), future);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('version-nine bindings gain an unbound last-pane action without resetting custom keys or revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-last-pane-settings-')), path = join(directory, 'settings.json');
  try {
    const { last_pane, ...bindings } = defaults.shortcuts.bindings;
    const preferences = { ...defaults, shortcuts: { prefix: 'ctrl+a', bindings: { ...bindings, help: ['prefix+f1'] } } };
    await writeFile(path, JSON.stringify({ version: 9, revision: 29, preferences }), { mode: 0o600 });
    const store = await settingsStore(path), state = store.read();
    assert.equal(state.revision, 29); assert.equal(state.preferences.shortcuts.prefix, 'ctrl+a');
    assert.deepEqual(state.preferences.shortcuts.bindings.help, ['prefix+f1']);
    assert.deepEqual(state.preferences.shortcuts.bindings.last_pane, []);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 10);
    assert.deepEqual((await settingsStore(path)).read(), state);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
