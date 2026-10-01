import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('inverse video swaps default theme colors as well as explicit cell colors', async ({ page }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
    await page.goto(url);
    const samples = await page.evaluate(async () => {
      const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
      const library = await import(bundle); await library.init();
      const terminal = new library.Terminal({ cols: 20, rows: 4, cursorBlink: false, theme: { background: '#181825', foreground: '#cdd6f4', cursor: '#89b4fa' } });
      terminal.open(document.querySelector('#terminal'));
      const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
      try {
        // Spaces expose the painted background; full blocks expose the text color.
        await write('\x1b[?25l \x1b[7m █\x1b[0m \x1b[38;2;10;200;30;7m \x1b[0m \x1b[48;2;200;10;30;7m█\x1b[0m');
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const metrics = terminal.renderer.getMetrics();
        const context = document.querySelector('canvas')!.getContext('2d')!;
        const sample = (column: number) => [...context.getImageData(Math.floor((column + .5) * metrics.width), Math.floor(.5 * metrics.height), 1, 1).data];
        return { plain: sample(0), defaultBackground: sample(1), defaultText: sample(2), explicitBackground: sample(4), explicitText: sample(6) };
      } finally { terminal.dispose(); }
    });
    expect(samples.plain).toEqual([24, 24, 37, 255]);
    expect(samples.defaultBackground).toEqual([205, 214, 244, 255]);
    expect(samples.defaultText).toEqual([24, 24, 37, 255]);
    expect(samples.explicitBackground).toEqual([10, 200, 30, 255]);
    expect(samples.explicitText).toEqual([200, 10, 30, 255]);
  } finally { await server.close(); }
});
