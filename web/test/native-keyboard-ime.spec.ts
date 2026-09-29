import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('mounted terminal leaves dead-key defaults intact and delivers committed text once', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
    await page.goto(url);
    const samples = await page.evaluate(async () => {
      const loader = '/src/terminal-loader.ts', source = '/src/native-keyboard.ts';
      const library = await (await import(loader)).loadGhostty();
      const { NativeKeyboard } = await import(source);
      const samples = [];
      for (const [flags, level] of [[0, 0], [1, 0], [31, 0], [0, 2]]) {
        const content = document.querySelector('#terminal')!;
        const term = new library.Terminal({ cols: 40, rows: 10 }); term.open(content);
        const output: string[] = [];
        const subscription = term.onData((text: string) => output.push(text));
        const keyboard = new NativeKeyboard(content, term, term.createInputEncoder(), library, () => true, (text: string) => output.push(text));
        try {
          keyboard.update(flags, level);
          const prevented = [];
          // X11 US international emits Dead then e without compositionstart or
          // isComposing. The browser commits é through beforeinput instead.
          for (const [key, code] of [['Dead', 'Quote'], ['Shift', 'ShiftLeft'], ['e', 'KeyE']]) {
            for (const type of ['keydown', 'keyup']) {
              const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
              term.textarea.dispatchEvent(event); prevented.push(event.defaultPrevented);
            }
          }
          const beforeCommit = output.slice();
          term.textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'é', bubbles: true, cancelable: true }));
          const committed = output.slice();
          output.length = 0;
          for (const type of ['keydown', 'keyup']) term.textarea.dispatchEvent(new KeyboardEvent(type, { key: 'x', code: 'KeyX', bubbles: true, cancelable: true }));
          samples.push({ flags, level, prevented, beforeCommit, committed, recovered: output.slice() });
        } finally { keyboard.dispose(); subscription.dispose(); term.dispose(); }
      }
      return samples;
    });
    for (const sample of samples) {
      expect(sample.prevented, JSON.stringify(sample)).toEqual(Array(6).fill(false));
      expect(sample.beforeCommit).toEqual([]);
      expect(sample.committed).toEqual(['é']);
      expect(sample.recovered.length).toBeGreaterThan(0);
    }
  } finally { await server.close(); }
});

// Exercise real DOM dispatch and the bundled native WASM encoder without a
// runtime, shell or user session. Synthetic events verify routing, not OS IMEs.
test('IME, AltGraph and named keys preserve native keyboard protocol routing', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><textarea></textarea>' }));
    await page.goto(url);
    const result = await page.evaluate(async () => {
      // These paths are served by the local Vite server, not Node imports.
      const source = '/src/native-keyboard.ts';
      const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
      const { NativeKeyboard } = await import(source);
      const library = await import(bundle);
      const ghostty = await library.Ghostty.load('/node_modules/ghostty-web/ghostty-vt.wasm');
      const content = document.querySelector('textarea')!;
      const output: string[] = [];
      let applicationModes = false;
      const keyboard = new NativeKeyboard(content, { getMode: (mode: number) => applicationModes && (mode === 1 || mode === 66) }, ghostty.createKeyEncoder(), library, () => true, (text: string) => output.push(text));
      try {
        keyboard.update(31, 0);
        const ignored: boolean[] = [];
        for (const key of ['Process', 'Unidentified', 'Dead']) {
          for (const type of ['keydown', 'keyup']) {
            const event = new KeyboardEvent(type, { key, code: 'KeyA', bubbles: true, cancelable: true });
            content.dispatchEvent(event); ignored.push(event.defaultPrevented);
          }
        }
        const beforeText = output.slice();
        content.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
        for (const type of ['keydown', 'keyup']) content.dispatchEvent(new KeyboardEvent(type, { key: 'é', code: 'KeyE', bubbles: true, cancelable: true }));
        const unicodeOutput = output.slice();
        const altGraphCases = [];
        const namedKeyCases = [];
        const reference = ghostty.createKeyEncoder();
        reference.setOption(library.KeyEncoderOption.ALT_ESC_PREFIX, true);
        try {
          for (const [flags, level] of [[1, 0], [31, 0], [0, 2]]) {
            keyboard.update(flags, level);
            reference.setOption(library.KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
            reference.setOption(library.KeyEncoderOption.MODIFY_OTHER_KEYS_STATE_2, level === 2);
            for (const [code, key, nativeKey] of [
              ['ArrowLeft', 'ArrowLeft', 'LEFT'], ['ArrowUp', 'ArrowUp', 'UP'],
              ['Home', 'Home', 'HOME'], ['End', 'End', 'END'],
              ['PageUp', 'PageUp', 'PAGE_UP'], ['PageDown', 'PageDown', 'PAGE_DOWN'],
              ['Insert', 'Insert', 'INSERT'], ['Delete', 'Delete', 'DELETE'],
              ['Backspace', 'Backspace', 'BACKSPACE'], ['Tab', 'Tab', 'TAB'],
              ['Enter', 'Enter', 'ENTER'], ['Escape', 'Escape', 'ESCAPE'],
              ['F1', 'F1', 'F1'], ['F12', 'F12', 'F12'], ['F24', 'F24', 'F24'],
              ['NumpadEnter', 'Enter', 'KP_ENTER'], ['Numpad0', '0', 'KP_0'],
              ['Numpad9', '9', 'KP_9'], ['NumpadAdd', '+', 'KP_PLUS'],
              ['NumpadSubtract', '-', 'KP_MINUS'], ['NumpadMultiply', '*', 'KP_MULTIPLY'],
              ['NumpadDivide', '/', 'KP_DIVIDE'], ['NumpadDecimal', '.', 'KP_PERIOD'],
              ['NumpadEqual', '=', 'KP_EQUAL'], ['NumpadComma', ',', 'KP_COMMA'],
              ['IntlBackslash', '\\', 'INTL_BACKSLASH'], ['IntlYen', '¥', 'INTL_YEN'],
              ['IntlRo', 'ろ', 'INTL_RO'], ['Backquote', '`', 'GRAVE'],
            ]) {
              for (const application of [false, true]) for (const modified of [false, true]) {
                applicationModes = application;
                reference.setOption(library.KeyEncoderOption.CURSOR_KEY_APPLICATION, application);
                reference.setOption(library.KeyEncoderOption.KEYPAD_KEY_APPLICATION, application);
                output.length = 0;
                const expected = [];
                const prevented = [];
                for (const [type, action, repeat] of [
                  ['keydown', library.KeyAction.PRESS, false],
                  ['keydown', library.KeyAction.REPEAT, true],
                  ['keyup', library.KeyAction.RELEASE, false],
                ] as const) {
                  const event = new KeyboardEvent(type, { key, code, repeat, ctrlKey: modified, shiftKey: modified, bubbles: true, cancelable: true });
                  content.dispatchEvent(event); prevented.push(event.defaultPrevented);
                  const utf8 = [...key].length === 1 ? key : undefined;
                  const bytes = reference.encode({ key: library.Key[nativeKey], action,
                    mods: modified ? library.Mods.CTRL | library.Mods.SHIFT : 0,
                    utf8, unshiftedCodepoint: utf8?.toLowerCase().codePointAt(0) });
                  if (bytes.length) expected.push(new TextDecoder().decode(bytes));
                }
                namedKeyCases.push({ flags, level, code, modified, application, output: output.slice(), expected, prevented });
              }
            }
          }
        } finally { applicationModes = false; reference.dispose(); }
        for (const [flags, level] of [[1, 0], [31, 0], [0, 2]]) {
          keyboard.update(flags, level);
          for (const code of ['KeyQ', 'KeyV']) {
            const tap = (altGraph: boolean, ctrlKey = altGraph) => {
              output.length = 0;
              const prevented = [];
              for (const type of ['keydown', 'keyup']) {
                const event = new KeyboardEvent(type, { key: '@', code, ctrlKey, altKey: altGraph, modifierAltGraph: altGraph, bubbles: true, cancelable: true });
                content.dispatchEvent(event); prevented.push(event.defaultPrevented);
              }
              return { output: output.slice(), prevented };
            };
            altGraphCases.push({ flags, level, code, literal: tap(false), altGraph: tap(true), altGraphWithoutControl: tap(true, false) });
          }
        }
        return { ignored, beforeText, output: unicodeOutput, altGraphCases, namedKeyCases };
      } finally { keyboard.dispose(); }
    });
    expect(result.ignored).toEqual(Array(6).fill(false));
    expect(result.beforeText).toEqual([]);
    expect(result.output).toHaveLength(2);
    expect(result.output[0]).toMatch(/^\x1b\[233.*u$/);
    expect(result.output[1]).toMatch(/^\x1b\[233.*:3.*u$/);
    for (const sample of result.namedKeyCases) {
      const label = JSON.stringify({ flags: sample.flags, level: sample.level, code: sample.code, modified: sample.modified, application: sample.application });
      expect(sample.prevented, label).toEqual([true, true, true]);
      expect(sample.output, label).toEqual(sample.expected);
    }
    for (const sample of result.altGraphCases) {
      expect(sample.altGraph, JSON.stringify({ flags: sample.flags, level: sample.level, code: sample.code })).toEqual(sample.literal);
      expect(sample.altGraphWithoutControl).toEqual(sample.literal);
      expect(sample.altGraph.prevented).toEqual([true, true]);
      expect(sample.altGraph.output.length).toBeGreaterThan(0);
    }
  } finally { await server.close(); }
});
