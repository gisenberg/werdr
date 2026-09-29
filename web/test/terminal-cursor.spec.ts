import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('cursor-only visibility changes erase painted cursor pixels without cell output', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
    await page.goto(url);
    const samples = await page.evaluate(async () => {
      const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
      const library = await import(bundle); await library.init();
      const terminal = new library.Terminal({ cols: 20, rows: 8, cursorBlink: false, theme: { background: '#181825', foreground: '#cdd6f4', cursor: '#89b4fa' } });
      terminal.open(document.querySelector('#terminal'));
      const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
      const sample = async () => {
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const canvas = document.querySelector('canvas')!;
        const metrics = terminal.renderer.getMetrics();
        return [...canvas.getContext('2d')!.getImageData(Math.floor(8.5 * metrics.width), Math.floor(5.5 * metrics.height), 1, 1).data];
      };
      try {
        await write('\x1b[6;9H\x1b[?25l'); const initial = await sample();
        await write('\x1b[?2026h\x1b[?25l\x1b[6;9H\x1b[?25h\x1b[?2026l'); const shown = await sample();
        await write('\x1b[?2026h\x1b[?25l\x1b[6;9H\x1b[?25l\x1b[?2026l'); const hidden = await sample();
        await write('\x1b[?25h'); const restored = await sample();
        await write('\x1b[6 q'); const bar = await sample();
        await write('\x1b[4 q'); const underline = await sample();
        await write('\x1b[2 q'); const block = await sample();
        await write('\x1b[?2026h\x1b[?25l'); const deferred = await sample();
        await write('\x1b[?2026l'); const resumed = await sample();
        return { initial, shown, hidden, restored, bar, underline, block, deferred, resumed };
      } finally { terminal.dispose(); }
    });
    expect(samples.initial).toEqual([24, 24, 37, 255]);
    expect(samples.shown).toEqual([137, 180, 250, 255]);
    expect(samples.hidden).toEqual(samples.initial);
    expect(samples.restored).toEqual(samples.shown);
    expect(samples.bar).toEqual(samples.initial);
    expect(samples.underline).toEqual(samples.initial);
    expect(samples.block).toEqual(samples.shown);
    expect(samples.deferred).toEqual(samples.shown);
    expect(samples.resumed).toEqual(samples.initial);
  } finally { await server.close(); }
});
