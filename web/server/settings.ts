import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { defaults, validatePreferences, type SettingsState } from '../shared/settings.ts';
import { shortcutDefaults } from '../shared/shortcuts.ts';
export class SettingsConflict extends Error {}
export async function settingsStore(path: string) {
  const stored = await readPrivateJson(path) as any;
  if (stored !== undefined && (!stored || typeof stored !== 'object' || stored.preferences === undefined || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(stored.version) || !Number.isSafeInteger(stored.revision) || stored.revision < 0)) throw new Error('Invalid or unsupported browser settings store');
  if (stored?.preferences?.shortcuts?.bindings) {
    // Consider new defaults independently so a collision on one action cannot
    // disable another action when migrating across several schema versions.
    const bindings = stored.preferences.shortcuts.bindings;
    const additions = ([['detach', 11], ['reload_config', 12]] as const).filter(([action, version]) => stored.version < version && !Object.hasOwn(bindings, action));
    for (const [action] of additions) bindings[action] = [];
    for (const [action] of additions) {
      bindings[action] = shortcutDefaults[action];
      try { validatePreferences(stored.preferences); }
      catch { bindings[action] = []; }
    }
  }
  let state: SettingsState = { revision: stored?.revision || 0, preferences: validatePreferences(stored === undefined ? defaults : stored.version === 1 ? { ...validatePreferences(stored.preferences), sidebarSectionPercent: defaults.sidebarSectionPercent } : stored.preferences) };
  if (stored && stored.version < 12) await writePrivateJson(path, { version: 12, ...state });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read(): SettingsState { return structuredClone(state); },
    update(revision: unknown, preferences: unknown): Promise<SettingsState> {
      const validated = validatePreferences(preferences);
      const task = queue.then(async () => {
        if (revision !== state.revision) throw new SettingsConflict('Settings changed in another browser. Reload settings before saving.');
        const next = { revision: state.revision + 1, preferences: validated };
        await writePrivateJson(path, { version: 12, ...next }); state = next; return structuredClone(state);
      });
      queue = task.catch(() => {}); return task;
    },
  };
}
