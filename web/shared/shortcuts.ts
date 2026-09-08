// Browser-owned bindings use the native keys syntax and action names.
export const shortcutDefaults = {
  help: ['prefix+?'], settings: ['prefix+s'], command_palette: ['ctrl+k', 'super+k'],
  new_workspace: ['prefix+shift+n'], new_worktree: ['prefix+shift+g'], open_worktree: [], remove_worktree: [],
  rename_workspace: ['prefix+shift+w'], close_workspace: ['prefix+shift+d'], workspace_picker: ['prefix+w'], goto: ['prefix+g'],
  previous_workspace: [], next_workspace: [], previous_agent: [], next_agent: [], focus_agent: [],
  new_tab: ['prefix+c'], rename_tab: ['prefix+shift+t'], previous_tab: ['prefix+p'], next_tab: ['prefix+n'],
  move_tab_previous: [], move_tab_next: [], switch_tab: ['prefix+1..9'], switch_workspace: [], close_tab: ['prefix+shift+x'],
  rename_pane: ['prefix+shift+p'], edit_scrollback: ['prefix+e'], copy_mode: ['prefix+['],
  focus_pane_left: ['prefix+h'], focus_pane_down: ['prefix+j'], focus_pane_up: ['prefix+k'], focus_pane_right: ['prefix+l'],
  swap_pane_left: ['prefix+shift+h'], swap_pane_down: ['prefix+shift+j'], swap_pane_up: ['prefix+shift+k'], swap_pane_right: ['prefix+shift+l'],
  cycle_pane_next: ['prefix+tab'], cycle_pane_previous: ['prefix+shift+tab'],
  split_vertical: ['prefix+v', 'ctrl+d', 'super+d'], split_horizontal: ['prefix+minus', 'ctrl+shift+d', 'super+shift+d'],
  close_pane: ['prefix+x'], zoom: ['prefix+z'], resize_mode: ['prefix+r'],
  resize_pane_left: [], resize_pane_down: [], resize_pane_up: [], resize_pane_right: [], toggle_sidebar: ['prefix+b'],
  navigate_workspace_up: ['up'], navigate_workspace_down: ['down'],
  navigate_pane_left: ['h'], navigate_pane_down: ['j'], navigate_pane_up: ['k'], navigate_pane_right: ['l'],
} satisfies Record<string, string[]>;
export type ShortcutAction = keyof typeof shortcutDefaults;
export interface Shortcuts { prefix: string; bindings: Record<ShortcutAction, string[]> }
export const defaultShortcuts: Shortcuts = { prefix: 'ctrl+b', bindings: shortcutDefaults };
export const shortcutActions = Object.keys(shortcutDefaults) as ShortcutAction[];
export function isNavigateAction(action: ShortcutAction) { return action.startsWith('navigate_'); }
export interface Chord { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; prefix: boolean }
const names: Record<string, string> = { esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', bs: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ', minus: '-', plus: '+', comma: ',', period: '.', slash: '/', backslash: '\\', quote: "'", double_quote: '"', 'double-quote': '"', semicolon: ';', colon: ':', percent: '%', ampersand: '&', backtick: '`' };
const modifiers: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta' | 'prefix'> = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', meta: 'alt', super: 'meta', cmd: 'meta', command: 'meta', prefix: 'prefix' };
const shiftedPunctuation = new Set([...`!@#$%^&*()_+{}|:"<>?~`]);
export function parseChord(value: string): Chord {
  const chord: Chord = { key: '', ctrl: false, alt: false, shift: false, meta: false, prefix: false };
  const specified = new Set<string>();
  for (const token of value.split('+').map(part => part.trim())) {
    const lower = token.toLowerCase();
    if (Object.hasOwn(modifiers, lower)) {
      const modifier = modifiers[lower]; if (specified.has(modifier)) throw new Error(`Repeated modifier: ${value}`); specified.add(modifier); chord[modifier] = true;
    } else {
      const key = Object.hasOwn(names, lower) ? names[lower] : /^f([1-9]|1[0-9]|2[0-4])$/.test(lower) ? lower.toUpperCase() : [...token].length === 1 && !/[\s\x00-\x1f]/.test(token) ? token : undefined;
      if (!key || chord.key) throw new Error(`Invalid keybinding: ${value}`);
      chord.key = /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
      if (/^[A-Z]$/.test(key)) chord.shift = true;
    }
  }
  if (!chord.key) throw new Error(`Invalid keybinding: ${value}`);
  return chord;
}
export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat' | 'code' | 'isComposing' | 'keyCode' | 'getModifierState'>;
export function matchesChord(chord: Chord, event: ShortcutKey) {
  // Browsers already report the layout's shifted punctuation, unlike letter keys.
  const implicitShift = shiftedPunctuation.has(chord.key);
  return chord.key.toLowerCase() === event.key.toLowerCase() && chord.ctrl === event.ctrlKey && chord.alt === event.altKey && chord.meta === event.metaKey && (chord.shift === event.shiftKey || implicitShift && event.shiftKey);
}
export interface Binding { chord: Chord; action: ShortcutAction; index?: number }
export function compileShortcuts(value: Shortcuts): { prefix: Chord; bindings: Binding[]; navigate: Binding[] } {
  const all = shortcutActions.flatMap(action => value.bindings[action].flatMap(text => {
    if (text.endsWith('1..9')) return Array.from({ length: 9 }, (_, index) => ({ chord: parseChord(`${text.slice(0, -4)}${index + 1}`), action, index }));
    return [{ chord: parseChord(text), action }];
  }));
  return { prefix: parseChord(value.prefix), bindings: all.filter(binding => !isNavigateAction(binding.action)), navigate: all.filter(binding => isNavigateAction(binding.action)) };
}
export function validateShortcuts(value: unknown): Shortcuts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Keybindings must be an object.');
  const input = value as Shortcuts;
  if (Object.keys(input).some(key => !['prefix', 'bindings'].includes(key)) || typeof input.prefix !== 'string' || input.prefix.length > 80) throw new Error('Invalid prefix setting.');
  const prefix = parseChord(input.prefix);
  if (prefix.prefix || [...prefix.key].length === 1 && !(prefix.ctrl || prefix.alt || prefix.meta)) throw new Error('Prefix must be a modified key or named key, for example ctrl+b or f12.');
  if (!input.bindings || typeof input.bindings !== 'object' || Array.isArray(input.bindings) || Object.keys(input.bindings).some(key => !Object.hasOwn(shortcutDefaults, key))) throw new Error('Unknown keybinding action.');
  const bindings = {} as Shortcuts['bindings'];
  for (const action of shortcutActions) {
    const values = Object.hasOwn(input.bindings, action) ? input.bindings[action] : shortcutDefaults[action];
    if (!Array.isArray(values) || values.length > 8 || values.some(text => typeof text !== 'string' || !text || text.length > 80)) throw new Error(`Invalid bindings: ${action}`);
    if (['switch_tab', 'switch_workspace', 'focus_agent'].includes(action) && values.some(text => !text.trim().endsWith('1..9'))) throw new Error('Indexed switching requires a 1..9 binding.');
    bindings[action] = values.map(text => text.trim());
    if (!['switch_tab', 'switch_workspace', 'focus_agent'].includes(action) && values.some(text => text.includes('1..9'))) throw new Error('1..9 is only available for indexed tab, workspace and agent switching.');
  }
  const out = { prefix: input.prefix.trim(), bindings };
  const compiled = compileShortcuts(out), seen: Chord[] = [], navigateSeen: Chord[] = [];
  const overlaps = (a: Chord, b: Chord) => a.key.toLowerCase() === b.key.toLowerCase() && a.ctrl === b.ctrl && a.alt === b.alt && a.meta === b.meta && a.prefix === b.prefix && (a.shift === b.shift || shiftedPunctuation.has(a.key));
  for (const { chord, action } of [...compiled.bindings, ...compiled.navigate]) {
    const navigate = isNavigateAction(action), scope = navigate ? navigateSeen : seen;
    if (scope.some(previous => overlaps(previous, chord))) throw new Error(`Conflicting keybinding for ${action}.`);
    if (overlaps({ ...chord, prefix: false }, prefix)) throw new Error('A binding cannot also be the prefix or the double-prefix forwarding key.');
    if (navigate && (chord.prefix || chord.key === 'Escape' || !chord.ctrl && !chord.alt && !chord.meta && ((!chord.shift && ['Enter', 'ArrowLeft', 'ArrowRight', ...'123456789'].includes(chord.key)) || chord.key === 'Tab'))) throw new Error('Navigate bindings cannot use prefix syntax or reserved navigation keys.');
    if (!navigate && !chord.prefix && [...chord.key].length === 1 && !chord.ctrl && !chord.alt && !chord.meta) throw new Error('Direct printable bindings would intercept terminal typing. Use prefix+ instead.');
    // Clipboard gestures stay owned by native selection and browser paste.
    if ((chord.ctrl || chord.meta) && !chord.alt && !chord.shift && ['c', 'v'].includes(chord.key)) throw new Error('Ctrl/Super+C and Ctrl/Super+V are reserved for clipboard access.');
    scope.push(chord);
  }
  if ((prefix.ctrl || prefix.meta) && !prefix.alt && !prefix.shift && ['c', 'v'].includes(prefix.key)) throw new Error('Clipboard gestures cannot be the prefix.');
  return out;
}
