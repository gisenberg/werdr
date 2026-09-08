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
    await writeFile(path, JSON.stringify({ version: 6, revision: 1, preferences: defaults })); await assert.rejects(settingsStore(path), /unsupported/);
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
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 5);
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
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 5);
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
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 5);
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
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 5);
    await store.update(19, { ...store.read().preferences, copyOnSelect: false });
    assert.equal((await settingsStore(path)).read().preferences.copyOnSelect, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
