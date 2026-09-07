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
  for (const value of [{ theme: 'missing' }, { fontSize: NaN }, { sidebarWidth: 9999 }, { confirmClose: 'false' }, { customColors: { accent: 'url(example)' } }, { customColors: { unknown: '#123456' } }, { toString: 'unexpected' }, { appearance: 'random' }]) assert.throws(() => validatePreferences(value));
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
    await writeFile(path, JSON.stringify({ version: 2, revision: 1, preferences: defaults })); await assert.rejects(settingsStore(path), /unsupported/);
    await writeFile(path, 'null'); await assert.rejects(settingsStore(path), /unsupported/);
    await writeFile(path, valid); await assert.rejects(store.update(0, defaults), /another browser/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
