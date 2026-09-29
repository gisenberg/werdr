import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('idle theme changes repaint default colors without changing explicit colors or terminal identity', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
    await page.goto(url);
    const samples = await page.evaluate(async () => {
      const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
      const library = await import(bundle); await library.init();
      const terminal = new library.Terminal({ cols: 20, rows: 5, cursorBlink: false, theme: { background: '#181825', foreground: '#cdd6f4' } });
      terminal.open(document.querySelector('#terminal'));
      try {
        await new Promise<void>(resolve => terminal.write('\x1b[49m    \r\n\x1b[48;2;17;34;51m    \x1b[0m', resolve));
        const canvas = document.querySelector('canvas')!;
        const textarea = document.querySelector('textarea');
        const dimensions = [canvas.width, canvas.height];
        const metrics = terminal.renderer.getMetrics();
        const sample = async () => {
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          const pixel = (row: number) => [...canvas.getContext('2d')!.getImageData(Math.floor(metrics.width / 2), Math.floor(metrics.height * (row + 0.5)), 1, 1).data].slice(0, 3);
          return { normal: pixel(0), explicit: pixel(1), sameCanvas: canvas === document.querySelector('canvas'), sameInput: textarea === document.querySelector('textarea'), sameDimensions: dimensions.every((value, i) => value === [canvas.width, canvas.height][i]) };
        };
        const before = await sample();
        terminal.options.theme = { background: '#eff1f5', foreground: '#4c4f69' };
        const light = await sample();
        terminal.options.theme = { background: '#181825', foreground: '#cdd6f4' };
        const dark = await sample();
        await new Promise<void>(resolve => terminal.write('\x1b[?2026h', resolve));
        terminal.options.theme = { background: '#eff1f5', foreground: '#4c4f69' };
        const deferred = await sample();
        await new Promise<void>(resolve => terminal.write('\x1b[?2026l', resolve));
        const resumed = await sample();
        return { before, light, dark, deferred, resumed };
      } finally { terminal.dispose(); }
    });
    expect(samples.before.normal).toEqual([24, 24, 37]);
    expect(samples.light.normal).toEqual([239, 241, 245]);
    expect(samples.dark.normal).toEqual([24, 24, 37]);
    expect(samples.deferred.normal).toEqual([24, 24, 37]);
    expect(samples.resumed.normal).toEqual([239, 241, 245]);
    for (const sample of Object.values(samples)) {
      expect(sample.explicit).toEqual([17, 34, 51]);
      expect(sample.sameCanvas && sample.sameInput && sample.sameDimensions).toBe(true);
    }
  } finally { await server.close(); }
});
