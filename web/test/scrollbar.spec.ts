import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('native scrollbars preserve history, row geometry, keyboard and drag behavior across screen modes and settings', async ({ page }) => {
  test.setTimeout(90000);
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = page.locator('.pane-active'), content = pane.locator('.pane-content'), bar = pane.getByRole('scrollbar');
    const id = new URL(page.url()).searchParams.get('pane')!, original = await pane.locator('textarea').elementHandle();
    const geometry = async () => {
      const value = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((entry: any) => entry.pane_id === id);
      return value.scroll;
    };
    const margin = () => content.evaluate(node => parseFloat(getComputedStyle(node).marginRight));
    await expect.poll(margin).toBeGreaterThan(0);
    const gutter = await margin();
    await pane.locator('textarea').focus();
    await page.keyboard.type("for i in $(seq 1 300); do printf 'SCROLL_ROW_%03d\\n' \"$i\"; done"); await page.keyboard.press('Enter');
    await expect.poll(async () => (await geometry()).max_offset_from_bottom).toBeGreaterThan(200);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-valuetext', '0 lines above bottom');
    await bar.focus(); await page.keyboard.press('Home');
    await expect.poll(async () => { const scroll = await geometry(); return scroll.offset_from_bottom === scroll.max_offset_from_bottom; }).toBe(true);
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('End'); await expect(bar).toHaveAttribute('aria-valuetext', '0 lines above bottom');
    // Coalesce a burst while the first command is blocked, without losing steps.
    let release!: () => void, first = true; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'pane.scroll' && first) { first = false; await gate; }
      await route.continue();
    });
    for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowUp');
    release(); await expect.poll(async () => (await geometry()).offset_from_bottom).toBe(5);
    await expect(bar).toHaveAttribute('aria-valuetext', '5 lines above bottom'); await page.unroute('**/api/action');
    await page.keyboard.press('PageUp');
    await expect.poll(async () => { const scroll = await geometry(); return scroll.offset_from_bottom === 5 + scroll.viewport_rows; }).toBe(true);
    // Track click and thumb drag must reach both native endpoints.
    let box = (await bar.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await geometry()).offset_from_bottom).toBeGreaterThan(80);
    const thumb = (await pane.locator('.pane-scrollbar-thumb').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, thumb.y + 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 20, { steps: 5 }); await page.mouse.up();
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await bar.focus(); await page.keyboard.press('End'); await expect(bar).toHaveAttribute('aria-valuetext', '0 lines above bottom');
    // The gutter follows the native active screen, not mouse mode or history size.
    await pane.locator('textarea').focus();
    await page.keyboard.type("printf '\\033[?1049hALT_SCROLL_TEST'; read -r SCROLL_ALT_EXIT; printf '\\033[?1049l'"); await page.keyboard.press('Enter');
    await expect.poll(async () => (await geometry()).alternate_screen_active).toBe(true);
    await expect.poll(margin).toBe(0); await expect(bar).toBeHidden();
    await pane.locator('textarea').focus(); await page.keyboard.press('Enter');
    await expect.poll(async () => (await geometry()).alternate_screen_active).toBe(false);
    await expect.poll(margin).toBeCloseTo(gutter, 1); await expect(bar).toBeVisible();
    const normalWidth = (await content.boundingBox())!.width;
    await page.locator('#settings').click(); await expect(page.locator('#settings-dialog')).toBeVisible(); await page.locator('[data-setting=paneScrollbars]').uncheck();
    await expect.poll(margin).toBe(0);
    await expect.poll(async () => (await content.boundingBox())!.width).toBeCloseTo(normalWidth + gutter, 1);
    await page.locator('#settings-cancel').click(); await expect.poll(margin).toBeCloseTo(gutter, 1);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await page.locator('#settings').click(); await expect(page.locator('#settings-dialog')).toBeVisible(); await page.locator('[data-setting=paneScrollbars]').uncheck();
    await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click(); await expect(page.locator('#settings-dialog')).toBeHidden();
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
    await expect.poll(margin).toBe(0);
    await page.locator('#settings').click(); await expect(page.locator('#settings-dialog')).toBeVisible(); await expect(page.locator('[data-setting=paneScrollbars]')).not.toBeChecked();
    await page.locator('[data-setting=paneScrollbars]').check(); await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click();
    await expect.poll(margin).toBeCloseTo(gutter, 1); await expect(bar).toBeVisible();
    await page.screenshot({ path: 'test-results/scrollbar-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(bar).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/scrollbar-phone.png' });
  } finally { await runtime.close(); }
});

test('older native scroll records keep terminals usable without guessing alternate-screen gutters', async ({ page }) => {
  const runtime = await fixture();
  let records = 0;
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === 'terminal.scroll-state' && value.scroll) { delete value.scroll.alternate_screen_active; records++; socket.send(JSON.stringify(value)); }
      else socket.send(message);
    });
  });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = page.locator('.pane-active'), id = new URL(page.url()).searchParams.get('pane')!;
    await expect.poll(() => records).toBeGreaterThan(0);
    await expect(pane.locator('.pane-content')).toHaveCSS('margin-right', '0px');
    await expect(pane.getByRole('scrollbar')).toBeHidden();
    await pane.locator('textarea').focus(); await page.keyboard.type("printf 'LEGACY_%s\\n' INPUT"); await page.keyboard.press('Enter');
    await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('LEGACY_INPUT');
  } finally { await runtime.close(); }
});

test('initial reveal waits for scroll metadata and an API outage retains terminal geometry', async ({ page }) => {
  const runtime = await fixture();
  let mode: 'hold' | 'live' | 'offline' = 'hold'; const queued: (() => void)[] = [];
  let sendState: ((value: unknown) => void) | undefined;
  let latest: any;
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    sendState = value => socket.send(JSON.stringify(value));
    const server = socket.connectToServer();
    server.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === 'terminal.scroll-state' && value.ready !== false) {
        latest = value;
        if (mode === 'hold') { queued.push(() => socket.send(message)); return; }
        if (mode === 'offline') return;
      }
      socket.send(message);
    });
  });
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect.poll(() => queued.length).toBeGreaterThan(0);
    await expect(page.locator('.pane-active canvas')).toBeAttached();
    await expect(page.locator('.pane-active .pane-shield')).toBeVisible();
    mode = 'live'; for (const send of queued.splice(0)) send();
    await expect(page.locator('#shield')).toBeHidden();
    const pane = page.locator('.pane-active'), content = pane.locator('.pane-content'), id = new URL(page.url()).searchParams.get('pane')!;
    await expect.poll(() => content.evaluate(node => parseFloat(getComputedStyle(node).marginRight))).toBeGreaterThan(0);
    const original = await content.boundingBox();
    mode = 'offline'; sendState!({ type: 'terminal.scroll-state', scroll: null, ready: true });
    await expect.poll(() => content.evaluate(node => parseFloat(getComputedStyle(node).marginRight))).toBeGreaterThan(0);
    expect(await content.boundingBox()).toEqual(original);
    await pane.locator('textarea').focus(); await page.keyboard.type("printf 'SCROLL_METADATA_%s\n' OUTAGE"); await page.keyboard.press('Enter');
    await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('SCROLL_METADATA_OUTAGE');
    mode = 'live'; sendState!(latest); expect(await content.boundingBox()).toEqual(original);
  } finally { await runtime.close(); }
});

test('a delayed scroll reply cannot restore a normal-screen gutter over a newer alternate screen', async ({ page }) => {
  const runtime = await fixture();
  let release = () => {};
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = page.locator('.pane-active'), content = pane.locator('.pane-content'), id = new URL(page.url()).searchParams.get('pane')!;
    await runtime.cli('pane', 'send-text', id, "for i in $(seq 1 200); do printf 'OFFSET_%s\\n' \"$i\"; done\n");
    await expect(pane.getByRole('scrollbar')).toBeVisible();
    let held = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'pane.scroll' && !held) {
        const response = await route.fetch(); held = true; await gate; await route.fulfill({ response });
      } else await route.continue();
    });
    await pane.getByRole('scrollbar').focus(); await page.keyboard.press('Home');
    await expect.poll(() => held).toBe(true);
    await runtime.cli('pane', 'send-text', id, "printf '\\033[?1049h'; read -r SCROLL_REPLY_EXIT; printf '\\033[?1049l'\n");
    await expect(content).toHaveCSS('margin-right', '0px');
    const delivered = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'pane.scroll');
    release(); await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(content).toHaveCSS('margin-right', '0px'); await expect(pane.getByRole('scrollbar')).toBeHidden();
    await runtime.cli('pane', 'send-text', id, '\n');
    await expect.poll(() => content.evaluate(node => parseFloat(getComputedStyle(node).marginRight))).toBeGreaterThan(0);
  } finally { release(); await runtime.close(); }
});
