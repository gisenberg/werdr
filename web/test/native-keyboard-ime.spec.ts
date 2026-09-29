import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

// Exercise real DOM dispatch and the bundled native WASM encoder without a
// runtime, shell or user session. Synthetic events verify routing, not OS IMEs.
test('IME and AltGraph text preserve native keyboard protocol routing', async ({ page }) => {
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
      const keyboard = new NativeKeyboard(content, { getMode: () => false }, ghostty.createKeyEncoder(), library, () => true, (text: string) => output.push(text));
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
        for (const type of ['keydown', 'keyup']) content.dispatchEvent(new KeyboardEvent(type, { key: 'é', code: 'KeyE', bubbles: true, cancelable: true }));
        const unicodeOutput = output.slice();
        const altGraphCases = [];
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
        return { ignored, beforeText, output: unicodeOutput, altGraphCases };
      } finally { keyboard.dispose(); }
    });
    expect(result.ignored).toEqual(Array(6).fill(false));
    expect(result.beforeText).toEqual([]);
    expect(result.output).toHaveLength(2);
    expect(result.output[0]).toMatch(/^\x1b\[233.*u$/);
    expect(result.output[1]).toMatch(/^\x1b\[233.*:3.*u$/);
    for (const sample of result.altGraphCases) {
      expect(sample.altGraph, JSON.stringify({ flags: sample.flags, level: sample.level, code: sample.code })).toEqual(sample.literal);
      expect(sample.altGraphWithoutControl).toEqual(sample.literal);
      expect(sample.altGraph.prevented).toEqual([true, true]);
      expect(sample.altGraph.output.length).toBeGreaterThan(0);
    }
  } finally { await server.close(); }
});
