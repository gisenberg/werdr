import { parseChord, type ShortcutAction, type Shortcuts } from '../shared/shortcuts';
import type { ShortcutMode } from './shortcut-mode';

export type ModeHint = { keys: string; description: string };
export function copyModeHints(search: boolean, clearable: boolean, selecting: boolean): ModeHint[] {
  if (search) return [{ keys: 'Enter', description: 'search' }, { keys: 'Escape', description: 'cancel search' }];
  return [
    { keys: 'h/j/k/l · w/b/e · { }', description: 'move' },
    { keys: '/ · ?', description: 'search' },
    { keys: 'n / N', description: 'repeat' },
    { keys: 'v / Space', description: selecting ? 'selecting' : 'select' },
    { keys: 'y / Enter', description: 'copy' },
    ...(clearable ? [{ keys: 'Escape', description: 'clear' }, { keys: 'q', description: 'exit' }] : [{ keys: 'q / Escape', description: 'exit' }]),
  ];
}
/** Client presentation only. Labels follow the bindings accepted in the active mode. */
export function modeHints(mode: ShortcutMode['mode'], shortcuts: Shortcuts): ModeHint[] {
  const suffix = (action: ShortcutAction) => shortcuts.bindings[action]
    .filter(binding => parseChord(binding).prefix)
    .map(binding => binding.split('+').filter(token => token.trim().toLowerCase() !== 'prefix').join('+'))
    .join(' / ') || 'UNBOUND';
  if (mode === 'terminal') return [];
  if (mode === 'prefix') return [
    { keys: 'Escape', description: 'cancel' },
    { keys: shortcuts.prefix, description: 'send prefix' },
    { keys: suffix('workspace_picker'), description: 'workspace nav' },
    { keys: suffix('help'), description: 'keybinds' },
  ];
  if (mode === 'navigate') return [
    { keys: 'Escape', description: 'back' },
    { keys: [...shortcuts.bindings.navigate_workspace_up, ...shortcuts.bindings.navigate_workspace_down].join(' / ') || 'UNBOUND', description: 'workspace' },
    { keys: 'Enter / 1-9', description: 'select' },
    { keys: 'Tab / Shift+Tab', description: 'pane' },
    { keys: suffix('help'), description: 'keybinds' },
  ];
  return [
    { keys: 'h / l / ← / →', description: 'width' },
    { keys: 'j / k / ↓ / ↑', description: 'height' },
    { keys: 'Escape / Enter', description: 'done' },
  ];
}
