import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test('underscores stay inside their cells across fonts, styles and device scales', async ({ browser }) => {
  test.setTimeout(120000);
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ deviceScaleFactor });
      try {
        const page = await context.newPage();
        await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
        await page.goto(url);
        const failures = await page.evaluate(async () => {
          const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
          const library = await import(bundle); await library.init();
          const settingsPath = '/shared/settings.ts';
          const { fontFamilies: fonts } = await import(settingsPath);
          const failures: string[] = [];
          for (const [name, fontFamily] of Object.entries(fonts)) {
            for (const fontSize of [10, 12, 14, 18, 24, 32]) {
              const terminal = new library.Terminal({ cols: 5, rows: 5, fontFamily, fontSize, cursorBlink: false, theme: { background: '#000000', foreground: '#ffffff' } });
              terminal.open(document.querySelector('#terminal'));
              try {
                await new Promise<void>(resolve => terminal.write('\x1b[?25l_g\r\n\x1b[1m_g\r\n\x1b[0;3m_g\r\n\x1b[1m_g', resolve));
                await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
                const canvas = document.querySelector('canvas')!;
                const metrics = terminal.renderer.getMetrics();
                const dpr = window.devicePixelRatio;
                const width = Math.round(metrics.width * dpr), height = Math.round(metrics.height * dpr);
                for (const [row, style] of ['', 'bold ', 'italic ', 'italic bold '].entries()) {
                  const reference = document.createElement('canvas'); reference.width = width; reference.height = height + Math.ceil(8 * dpr);
                  const ctx = reference.getContext('2d')!;
                  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, reference.width, reference.height);
                  ctx.scale(dpr, dpr); ctx.font = `${style}${fontSize}px ${fontFamily}`; ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'alphabetic';
                  ctx.fillText('_', 0, metrics.baseline);
                  const expected = ctx.getImageData(0, 0, width, height).data;
                  const overflow = ctx.getImageData(0, height, width, reference.height - height).data;
                  const actual = canvas.getContext('2d')!.getImageData(0, row * height, width, height).data;
                  const label = `${name}/${fontSize}/${dpr}/${style || 'normal'}`;
                  if (!expected.some((value, index) => index % 4 !== 3 && value > 0)) failures.push(`${label}: underscore outside cell`);
                  if (overflow.some((value, index) => index % 4 !== 3 && value > 0)) failures.push(`${label}: glyph crosses next row`);
                  if (!expected.every((value, index) => actual[index] === value)) failures.push(`${label}: painted glyph differs`);
                }
              } finally { terminal.dispose(); }
            }
          }
          return failures;
        });
        expect(failures).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await server.close(); }
});
