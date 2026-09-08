import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { defaults, validatePreferences, type SettingsState } from '../shared/settings.ts';
export class SettingsConflict extends Error {}
export async function settingsStore(path: string) {
  const stored = await readPrivateJson(path) as any;
  if (stored !== undefined && (!stored || typeof stored !== 'object' || stored.preferences === undefined || ![1, 2, 3, 4, 5, 6, 7].includes(stored.version) || !Number.isSafeInteger(stored.revision) || stored.revision < 0)) throw new Error('Invalid or unsupported browser settings store');
  let state: SettingsState = { revision: stored?.revision || 0, preferences: validatePreferences(stored === undefined ? defaults : stored.version === 1 ? { ...validatePreferences(stored.preferences), sidebarSectionPercent: defaults.sidebarSectionPercent } : stored.preferences) };
  if (stored && stored.version < 7) await writePrivateJson(path, { version: 7, ...state });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read(): SettingsState { return structuredClone(state); },
    update(revision: unknown, preferences: unknown): Promise<SettingsState> {
      const validated = validatePreferences(preferences);
      const task = queue.then(async () => {
        if (revision !== state.revision) throw new SettingsConflict('Settings changed in another browser. Reload settings before saving.');
        const next = { revision: state.revision + 1, preferences: validated };
        await writePrivateJson(path, { version: 7, ...next }); state = next; return structuredClone(state);
      });
      queue = task.catch(() => {}); return task;
    },
  };
}
