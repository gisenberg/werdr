import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test.describe('ghostty-web upstream fixes', () => {
  test.use({ deviceScaleFactor: 1.1 });
  test('fractional scale stays idle, empty writes complete and pastes cannot leave their brackets', async ({ page }) => {
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    try {
      await server.listen();
      const url = server.resolvedUrls!.local[0];
      await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="terminal"></div>' }));
      await page.goto(url);
      const result = await page.evaluate(async () => {
        const bundle = '/node_modules/ghostty-web/dist/ghostty-web.es.js';
        const library = await import(bundle); await library.init();
        const terminal = new library.Terminal({ cols: 83, rows: 29, cursorBlink: false });
        terminal.open(document.querySelector('#terminal'));
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
          await new Promise<void>(resolve => terminal.write('ready\r\n', resolve)); await frames();
          let resizes = 0; const resize = terminal.renderer.resize.bind(terminal.renderer);
          terminal.renderer.resize = (cols: number, rows: number) => { resizes++; resize(cols, rows); };
          for (let index = 0; index < 5; index++) { await new Promise<void>(resolve => terminal.write(`line ${index}\r\n`, resolve)); await frames(); }
          let emptyCompleted = false, emptyError = '';
          try { await new Promise<void>(resolve => terminal.write('', () => { emptyCompleted = true; resolve(); })); } catch (error) { emptyError = String(error); }
          const sent: string[] = []; terminal.onData((data: string) => sent.push(data));
          await new Promise<void>(resolve => terminal.write('\x1b[?2004h', resolve));
          terminal.paste('ls\x1b[201~id\r');
          return { ratio: window.devicePixelRatio, resizes, emptyCompleted, emptyError, sent };
        } finally { terminal.dispose(); }
      });
      // Chrome reports the emulated ratio as a float such as 1.100000023841858.
      expect(result.ratio).toBeCloseTo(1.1, 5);
      expect(result.resizes).toBe(0);
      expect(result).toMatchObject({ emptyCompleted: true, emptyError: '' });
      expect(result.sent).toEqual(['\x1b[200~ls [201~id\r\x1b[201~']);
    } finally { await server.close(); }
  });
});

test('native panes re-measure their cells when the device scale changes', async ({ page }) => {
  const runtime = await fixture();
  try {
    const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id }));
    await consoleInput(page, 'token', runtime.token);
    await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    const canvas = page.locator('.pane-active canvas').first();
    const backing = () => canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, css: node.getBoundingClientRect().width, ratio: window.devicePixelRatio }));
    const initial = await backing();
    expect(initial.width).toBe(Math.round(initial.css * initial.ratio));
    const session = await page.context().newCDPSession(page);
    const viewport = page.viewportSize()!;
    // Browser zoom changes the CSS viewport along with the ratio; CDP fires the
    // resize event only when the emulated size changes too.
    for (const [index, deviceScaleFactor] of [2, 1.25].entries()) {
      await session.send('Emulation.setDeviceMetricsOverride', { width: viewport.width - 40 * (index + 1), height: viewport.height, deviceScaleFactor, mobile: false });
      await expect.poll(async () => { const current = await backing(); return Math.abs(current.ratio - deviceScaleFactor) < 1e-5 && Math.abs(current.width - current.css * deviceScaleFactor) <= 1; }).toBe(true);
    }
  } finally { await runtime.close(); }
});
