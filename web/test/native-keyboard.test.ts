import test from 'node:test';
import assert from 'node:assert/strict';
import * as library from 'ghostty-web';
import type { KeyEncoder, KeyEvent, Terminal } from 'ghostty-web';
import { NativeKeyboard } from '../src/native-keyboard.ts';

function fixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const windowTarget = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  const content = new EventTarget();
  const events: KeyEvent[] = [];
  const options = new Map<number, boolean | number>();
  const encoder = {
    setOption: (option: number, value: boolean | number) => options.set(option, value),
    encode: (event: KeyEvent) => { events.push(event); return new Uint8Array(); },
    dispose: () => {},
  } as unknown as KeyEncoder;
  const keyboard = new NativeKeyboard(content as HTMLElement, { getMode: () => false } as unknown as Terminal, encoder, library, () => true, () => {});
  keyboard.update(31, 0);
  const dispatch = (type: string, key: string, code: string, extra: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { key, code, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, getModifierState: () => false, ...extra });
    content.dispatchEvent(event);
    return event;
  };
  return { keyboard, content, windowTarget, events, options, dispatch, close() {
    keyboard.dispose();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  } };
}

test('native keyboard leaves IME sentinel keys and unfinished composition to the browser', () => {
  const f = fixture();
  try {
    for (const [key, extra] of [
      ['Dead', {}], ['Process', {}], ['Unidentified', {}],
      ['a', { isComposing: true }], ['a', { keyCode: 229 }],
    ] as const) {
      assert.equal(f.dispatch('keydown', key, 'KeyA', extra).defaultPrevented, false, key);
      assert.equal(f.dispatch('keyup', key, 'KeyA', extra).defaultPrevented, false, key);
      f.keyboard.sendKey({ key, code: 'KeyA', ...extra } as KeyboardEvent);
    }
    assert.equal(f.events.length, 0);
    assert.equal(f.dispatch('keydown', 'é', 'KeyE').defaultPrevented, true);
    assert.equal(f.events[0].utf8, 'é');
  } finally { f.close(); }
});

test('native keyboard preserves layout text and physical key identity independently', () => {
  const f = fixture();
  try {
    for (const [key, code, physical] of [
      ['z', 'KeyY', library.Key.Y], ['ч', 'KeyX', library.Key.X],
      ['é', 'Digit2', library.Key.TWO], ['😀', 'KeyA', library.Key.A],
      ['1', 'Numpad1', library.Key.KP_1], ['+', 'NumpadAdd', library.Key.KP_PLUS],
    ] as const) {
      f.dispatch('keydown', key, code);
      const event = f.events.at(-1)!;
      assert.equal(event.key, physical); assert.equal(event.utf8, key);
      f.dispatch('keyup', key, code);
      assert.equal(f.events.at(-1)!.action, library.KeyAction.RELEASE);
    }
  } finally { f.close(); }
});

test('native keyboard releases held keys exactly once on blur and protocol changes', () => {
  const f = fixture();
  try {
    f.dispatch('keydown', 'A', 'KeyA', { shiftKey: true });
    f.dispatch('keydown', 'A', 'KeyA', { shiftKey: true, repeat: true });
    f.content.dispatchEvent(new Event('focusout'));
    f.windowTarget.dispatchEvent(new Event('blur'));
    assert.equal(f.dispatch('keyup', 'a', 'KeyA').defaultPrevented, false);
    assert.deepEqual(f.events.map(event => event.action), [library.KeyAction.PRESS, library.KeyAction.REPEAT, library.KeyAction.RELEASE]);
    f.dispatch('keydown', 'b', 'KeyB');
    f.keyboard.update(0, 2);
    assert.equal(f.events.at(-1)!.action, library.KeyAction.RELEASE);
    assert.equal(f.options.get(library.KeyEncoderOption.MODIFY_OTHER_KEYS_STATE_2), true);
    assert.equal(f.dispatch('keyup', 'b', 'KeyB').defaultPrevented, false);
  } finally { f.close(); }
});
