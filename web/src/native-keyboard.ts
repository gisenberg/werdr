import type { KeyEncoder, KeyEvent, Terminal } from 'ghostty-web';
type Library = typeof import('ghostty-web');

/** Use Ghostty's native encoder for protocols requested by the attached application. */
export class NativeKeyboard {
  private flags = 0;
  private level = 0;
  private held = new Map<string, KeyEvent>();
  private decoder = new TextDecoder();
  constructor(private content: HTMLElement, private terminal: Terminal, private encoder: KeyEncoder, private library: Library, private available: () => boolean, private send: (text: string) => void) {
    content.addEventListener('keydown', this.down, true);
    content.addEventListener('keyup', this.up, true);
    content.addEventListener('focusout', this.blur);
    window.addEventListener('blur', this.blur);
    encoder.setOption(library.KeyEncoderOption.ALT_ESC_PREFIX, true);
  }
  update(flags: number, level: number) {
    if (!Number.isInteger(flags) || flags < 0 || flags > 31 || !Number.isInteger(level) || level < 0 || level > 2) throw new Error('Invalid keyboard mode');
    if (flags === this.flags && level === this.level) return;
    this.release(); this.flags = flags; this.level = level;
    this.encoder.setOption(this.library.KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
    this.encoder.setOption(this.library.KeyEncoderOption.MODIFY_OTHER_KEYS_STATE_2, level === 2);
  }
  release() { for (const event of this.held.values()) this.emit({ ...event, action: this.library.KeyAction.RELEASE }); this.held.clear(); }
  dispose() {
    this.release(); this.encoder.dispose();
    this.content.removeEventListener('keydown', this.down, true); this.content.removeEventListener('keyup', this.up, true);
    this.content.removeEventListener('focusout', this.blur); window.removeEventListener('blur', this.blur);
  }
  private emit(event: KeyEvent) { const bytes = this.encoder.encode(event); if (bytes.length) this.send(this.decoder.decode(bytes)); }
  private blur = () => this.release();
  private key(code: string) {
    const aliases: Record<string, string> = { Backquote: 'GRAVE', Equal: 'EQUAL', NumpadAdd: 'KP_PLUS', NumpadSubtract: 'KP_MINUS', NumpadDecimal: 'KP_PERIOD' };
    const digits = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    const name = aliases[code] ?? (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? digits[Number(code[5])] : code.replace(/^Arrow/, '').replace(/^Numpad/, 'Kp').replace(/([a-z])([A-Z0-9])/g, '$1_$2').toUpperCase());
    const value = this.library.Key[name as keyof typeof this.library.Key];
    return typeof value === 'number' ? value : undefined;
  }
  private modifiers(event: KeyboardEvent) {
    const { Mods } = this.library;
    return (event.shiftKey ? Mods.SHIFT : 0) | (event.ctrlKey ? Mods.CTRL : 0) | (event.altKey ? Mods.ALT : 0) | (event.metaKey ? Mods.SUPER : 0)
      | (event.getModifierState('CapsLock') ? Mods.CAPSLOCK : 0) | (event.getModifierState('NumLock') ? Mods.NUMLOCK : 0);
  }
  private down = (event: KeyboardEvent) => {
    if ((!this.flags && this.level !== 2) || !this.available() || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === 'Dead') return;
    // Let the browser and existing clipboard handler complete paste/copy gestures.
    if (((event.ctrlKey || event.metaKey) && event.code === 'KeyV') || (event.metaKey && event.code === 'KeyC')) return;
    const key = this.key(event.code); if (key === undefined) return;
    const { KeyAction, KeyEncoderOption } = this.library;
    const mods = this.modifiers(event);
    const utf8 = [...event.key].length === 1 ? event.key : undefined;
    const input: KeyEvent = { key, mods, action: event.repeat ? KeyAction.REPEAT : KeyAction.PRESS, utf8, unshiftedCodepoint: utf8?.toLowerCase().codePointAt(0) };
    this.encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, this.terminal.getMode(1));
    this.encoder.setOption(KeyEncoderOption.KEYPAD_KEY_APPLICATION, this.terminal.getMode(66));
    event.preventDefault(); event.stopImmediatePropagation(); this.held.set(event.code, input); this.emit(input);
  };
  private up = (event: KeyboardEvent) => {
    const input = this.held.get(event.code); if (!input) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.held.delete(event.code);
    this.emit({ ...input, mods: this.modifiers(event), action: this.library.KeyAction.RELEASE });
  };
}
