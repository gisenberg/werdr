import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('fitting forwards geometry even when a native frame already resized the renderer', async ({ page }) => {
  const runtime = await fixture();
  let latest: any, sendFrame: ((value: unknown) => void) | undefined;
  const sizes: { cols: number; rows: number }[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const initial = new URL(socket.url()).searchParams;
    sizes.push({ cols: Number(initial.get('cols')), rows: Number(initial.get('rows')) });
    sendFrame = value => socket.send(JSON.stringify(value));
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === 'terminal.resize') sizes.push(value);
      server.send(message);
    });
    server.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === 'terminal.frame') latest = value;
      socket.send(message);
    });
  });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    await expect.poll(() => sizes.length).toBeGreaterThan(0);
    await expect.poll(() => latest.width).toBe(sizes.at(-1)!.cols);
    const width = latest.width, height = latest.height;
    const cell = (await page.locator('.pane-active canvas').boundingBox())!.width / width;
    expect(cell).toBeGreaterThan(0);
    // A native frame changes the renderer without changing requested geometry.
    sendFrame!({ ...latest, width: width + 1, bytes: '', full: false });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    sizes.length = 0;
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ ...viewport, width: viewport.width + Math.ceil(cell) });
    await expect.poll(() => sizes.some(size => size.cols === width + 1 && size.rows === height)).toBe(true);
    await expect.poll(() => latest.width).toBe(width + 1);
    await expect(page.locator('#shield')).toBeHidden();
    // Two consecutive animation frames can resize inside FitAddon's guard.
    // The final geometry must not wait for another unrelated metadata event.
    sizes.length = 0;
    await page.locator('.pane-active .pane-content').evaluate(async node => {
      (node as HTMLElement).style.width = '600px';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      (node as HTMLElement).style.width = '400px';
    });
    await expect.poll(() => sizes.at(-1)?.cols).toBe(Math.max(2, Math.floor((400 - 15) / cell)));
    await expect.poll(() => latest.width).toBe(sizes.at(-1)!.cols);
  } finally { await runtime.close(); }
});

test('all desktop panes recover after exhausting attachment retries during a gateway outage', async ({ page }) => {
  test.setTimeout(90000);
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    await page.locator('#commands').click(); await page.locator('#command-list').getByRole('button', { name: 'Split right', exact: true }).click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2); await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0);
    const panes = await page.locator('.terminal-pane').elementHandles();
    for (const pane of panes) {
      const textarea = await pane.$('textarea'); await textarea!.focus(); await page.keyboard.type('export RECOVERY_FIXTURE=native_shell_survived'); await page.keyboard.press('Enter');
      const id = await pane.getAttribute('data-pane'); await expect.poll(() => runtime.cli('pane', 'read', id!, '--source', 'recent')).toContain('RECOVERY_FIXTURE');
    }
    await runtime.stopGateway();
    await expect(page.locator('.pane-shield').filter({ hasText: 'Retry or use TAKE CONTROL' })).toHaveCount(2, { timeout: 45000 });
    await expect(page.locator('#boot')).toBeHidden();
    await runtime.startGateway();
    await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('#shield')).toBeHidden();
    for (const pane of panes) {
      expect(await pane.evaluate(node => node.isConnected)).toBe(true);
      const textarea = await pane.$('textarea'); await textarea!.focus(); await page.keyboard.type('printf "RECOVERED_%s\\n" "$RECOVERY_FIXTURE"'); await page.keyboard.press('Enter');
      const id = await pane.getAttribute('data-pane'); await expect.poll(() => runtime.cli('pane', 'read', id!, '--source', 'recent')).toContain('RECOVERED_native_shell_survived');
    }
  } finally { await runtime.close(); }
});
