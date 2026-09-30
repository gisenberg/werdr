/** Modifiers a touch key row can latch for the next terminal key. */
export interface KeyModifiers { ctrl: boolean; alt: boolean }
export interface KeyTap { key: string; code: string; shift?: boolean }
/** A terminal that accepts synthesized taps, pasted text, and latched modifiers. */
export interface KeyTarget {
  readonly acceptsKeys: boolean;
  tap(tap: KeyTap, modifiers: KeyModifiers): void;
  paste(text: string): void;
  latch(modifiers: KeyModifiers | undefined, consumed: () => void): void;
  focus(): void;
}

const punctuation: Record<string, [string, boolean]> = {
  ' ': ['Space', false], '-': ['Minus', false], _: ['Minus', true], '=': ['Equal', false], '+': ['Equal', true], '[': ['BracketLeft', false], '{': ['BracketLeft', true],
  ']': ['BracketRight', false], '}': ['BracketRight', true], '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true],
  "'": ['Quote', false], '"': ['Quote', true], ',': ['Comma', false], '<': ['Comma', true], '.': ['Period', false], '>': ['Period', true], '/': ['Slash', false], '?': ['Slash', true],
  '`': ['Backquote', false], '~': ['Backquote', true], '!': ['Digit1', true], '@': ['Digit2', true], '#': ['Digit3', true], $: ['Digit4', true], '%': ['Digit5', true], '^': ['Digit6', true],
  '&': ['Digit7', true], '*': ['Digit8', true], '(': ['Digit9', true], ')': ['Digit0', true],
};
/** Map one soft-keyboard character to the US physical key a hardware keyboard would report. */
export function characterTap(text: string): KeyTap | undefined {
  if ([...text].length !== 1) return;
  if (/^[a-z]$/i.test(text)) return { key: text, code: `Key${text.toUpperCase()}`, shift: text !== text.toLowerCase() };
  if (/^[0-9]$/.test(text)) return { key: text, code: `Digit${text}` };
  const known = punctuation[text];
  return known && { key: text, code: known[0], shift: known[1] };
}
/** Legacy bytes for a latched chord whose character has no physical key. */
export function legacyChord(text: string, modifiers: KeyModifiers): string {
  const code = text.codePointAt(0) ?? 0;
  const control = modifiers.ctrl && [...text].length === 1 && code >= 0x40 && code <= 0x7e ? String.fromCharCode(code & 0x1f) : text;
  return modifiers.alt ? `\x1b${control}` : control;
}

const keys: { label: string; name: string; tap: KeyTap }[] = [
  { label: 'ESC', name: 'Escape', tap: { key: 'Escape', code: 'Escape' } },
  { label: 'TAB', name: 'Tab', tap: { key: 'Tab', code: 'Tab' } },
  { label: '←', name: 'Left arrow', tap: { key: 'ArrowLeft', code: 'ArrowLeft' } },
  { label: '↓', name: 'Down arrow', tap: { key: 'ArrowDown', code: 'ArrowDown' } },
  { label: '↑', name: 'Up arrow', tap: { key: 'ArrowUp', code: 'ArrowUp' } },
  { label: '→', name: 'Right arrow', tap: { key: 'ArrowRight', code: 'ArrowRight' } },
];

/**
 * Touch keyboards lack Escape, Tab, arrows, and chord modifiers. The row sends
 * them through the pane's native key encoder without taking focus from the
 * terminal, so the soft keyboard stays open.
 */
export class TerminalKeyRow {
  readonly element = document.createElement('div');
  private modifiers: KeyModifiers = { ctrl: false, alt: false };
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly modifierButtons: Record<keyof KeyModifiers, HTMLButtonElement>;
  private latchedTarget?: KeyTarget;
  constructor(private target: () => KeyTarget | undefined, private report: (message: string, failed?: boolean) => void) {
    this.element.className = 'terminal-keys'; this.element.setAttribute('role', 'toolbar'); this.element.setAttribute('aria-label', 'Terminal keys');
    // Keep focus in the terminal textarea; buttons remain keyboard-activatable.
    this.element.addEventListener('pointerdown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); });
    this.element.addEventListener('mousedown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); });
    const button = (label: string, name: string, run: () => void) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.setAttribute('aria-label', name); node.onclick = run;
      this.element.append(node); return node;
    };
    this.modifierButtons = {
      ctrl: button('CTRL', 'Control modifier', () => this.toggle('ctrl')),
      alt: button('ALT', 'Alt modifier', () => this.toggle('alt')),
    };
    for (const item of keys) {
      const node = button(item.label, item.name, () => this.send(item.tap));
      if (item.tap.code.startsWith('Arrow')) node.classList.add('terminal-key-arrow');
      this.buttons.set(item.name, node);
    }
    this.buttons.set('Paste', button('PASTE', 'Paste clipboard text', () => void this.paste()));
    this.sync();
  }
  /** Refresh availability after attachment, focus, or copy-mode changes. */
  update() {
    const target = this.target();
    if (this.latchedTarget && this.latchedTarget !== target) this.reset();
    const disabled = !target?.acceptsKeys;
    for (const node of [...this.buttons.values(), ...Object.values(this.modifierButtons)]) node.disabled = disabled;
    if (disabled && (this.modifiers.ctrl || this.modifiers.alt)) this.reset();
  }
  reset() { this.latchedTarget?.latch(undefined, () => {}); this.latchedTarget = undefined; this.modifiers = { ctrl: false, alt: false }; this.sync(); }
  private toggle(name: keyof KeyModifiers) {
    const target = this.target(); if (!target?.acceptsKeys) return;
    this.modifiers = { ...this.modifiers, [name]: !this.modifiers[name] };
    if (this.modifiers.ctrl || this.modifiers.alt) { this.latchedTarget = target; target.latch({ ...this.modifiers }, () => { this.latchedTarget = undefined; this.modifiers = { ctrl: false, alt: false }; this.sync(); }); }
    else this.reset();
    this.sync(); target.focus();
  }
  private send(tap: KeyTap) {
    const target = this.target(); if (!target?.acceptsKeys) return;
    const modifiers = this.modifiers; this.reset();
    target.tap(tap, modifiers); target.focus();
  }
  private async paste() {
    const target = this.target(); if (!target?.acceptsKeys) return;
    this.reset();
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard paste requires a secure browser connection.');
      const text = await navigator.clipboard.readText();
      if (this.target() !== target || !target.acceptsKeys) return;
      if (text) target.paste(text);
    } catch (error) { this.report((error as Error).message || 'Clipboard paste failed.', true); }
    target.focus();
  }
  private sync() {
    for (const [name, node] of Object.entries(this.modifierButtons)) node.setAttribute('aria-pressed', String(this.modifiers[name as keyof KeyModifiers]));
  }
}
