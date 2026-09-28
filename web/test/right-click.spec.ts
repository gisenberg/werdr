import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('missing native ownership metadata keeps menu access without offering an unsupported toggle', async ({ page }) => {
  const runtime = await fixture();
  const strip = (host: any) => { for (const pane of host.snapshot?.panes || []) delete pane.right_click_passthrough; };
  try {
    await page.route('**/api/fleet', async route => {
      const response = await route.fetch(), state = await response.json(); state.hosts.forEach(strip); await route.fulfill({ response, json: state });
    });
    await page.routeWebSocket('**/ws/fleet', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        const event = JSON.parse(String(message));
        if (event.type === 'fleet.snapshot') event.state.hosts.forEach(strip);
        else if (event.type === 'fleet.catalog') event.hosts.forEach(strip);
        else if (event.type === 'fleet.host') strip(event.host);
        socket.send(JSON.stringify(event));
      });
    });
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    await page.locator('.pane-active canvas').click({ button: 'right', position: { x: 30, y: 30 } });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem').filter({ hasText: 'RIGHT CLICK:' })).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(page.locator('.pane-active textarea')).toBeFocused();
  } finally { await page.unrouteAll({ behavior: 'wait' }); await runtime.close(); }
});

test('right-click ownership, exact modifier routing and keyboard menus follow native pane policy', async ({ page }) => {
  test.setTimeout(120_000);
  const runtime = await fixture(); const inputs: string[] = []; let reporting = false;
  try {
    await page.routeWebSocket('**/ws/terminal?*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => { const value = JSON.parse(String(message)); if (value.type === 'terminal.mouse') reporting = value.enabled; socket.send(message); });
      socket.onMessage(message => { const value = JSON.parse(String(message)); if (value.type === 'terminal.input') inputs.push(value.text); else server.send(message); });
    });
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const pane = new URL(page.url()).searchParams.get('pane')!;
    const read = async () => JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((item: any) => item.pane_id === pane);
    expect((await read()).right_click_passthrough).toBe(false);
    const menu = page.getByRole('menu'), canvas = page.locator('.pane-active canvas'), input = page.locator('.pane-active textarea');
    const right = () => canvas.click({ button: 'right', position: { x: 30, y: 30 } });
    await right(); await expect(menu).toBeVisible(); await page.keyboard.press('Escape'); await expect(input).toBeFocused();
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[?1000h\\033[?1006h\\033[>31u'\n");
    await expect.poll(() => reporting).toBe(true);
    inputs.length = 0; await right(); await expect(menu).toBeVisible();
    expect(inputs.filter(text => /^\x1b\[<2;/.test(text))).toEqual([]);
    await menu.getByRole('menuitem', { name: 'RIGHT CLICK: MENU (SWITCH TO APPLICATION)', exact: true }).click();
    await expect.poll(async () => (await read()).right_click_passthrough).toBe(true);
    await expect.poll(async () => (await (await page.request.get(runtime.url + '/api/fleet')).json()).hosts[0].snapshot.panes.find((item: any) => item.pane_id === pane).right_click_passthrough).toBe(true);
    inputs.length = 0; await right(); await expect(menu).toBeHidden();
    await expect.poll(() => inputs.filter(text => /^\x1b\[<2;/.test(text)).length).toBe(2);
    await page.keyboard.down('Shift'); inputs.length = 0; await right(); await page.keyboard.up('Shift'); await expect(menu).toBeVisible();
    expect(inputs.filter(text => { const code = /^\x1b\[<(\d+);/.exec(text); return code && (Number(code[1]) & 3) === 2; })).toEqual([]);
    await menu.getByRole('menuitem', { name: 'RIGHT CLICK: APPLICATION (SWITCH TO MENU)', exact: true }).click();
    await expect.poll(async () => (await read()).right_click_passthrough).toBe(false);
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await page.locator('[data-setting=rightClickPassthroughModifier]').selectOption('ctrl+alt');
    await page.locator('#settings-form button[type=submit]').click(); await expect(page.locator('#settings-dialog')).toBeHidden();
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); inputs.length = 0;
    await right(); await expect(menu).toBeHidden();
    await expect.poll(() => inputs.filter(text => /^\x1b\[<2;/.test(text)).length).toBe(2);
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    // Extra and missing modifiers cannot accidentally route to the application.
    for (const modifiers of [['Control'], ['Control', 'Alt', 'Shift']]) {
      for (const modifier of modifiers) await page.keyboard.down(modifier);
      inputs.length = 0; await right(); await expect(menu).toBeVisible();
      expect(inputs.filter(text => { const code = /^\x1b\[<(\d+);/.exec(text); return code && (Number(code[1]) & 3) === 2; })).toEqual([]);
      for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier);
      await page.keyboard.press('Escape');
    }
    // Strip the routing chord for the whole gesture, including an outside release.
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    const bounds = (await canvas.boundingBox())!; await page.mouse.move(bounds.x + 30, bounds.y + 30); inputs.length = 0;
    await page.mouse.down({ button: 'right' }); await page.mouse.move(bounds.x + 70, bounds.y + 50);
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.mouse.move(1, 1); await page.mouse.up({ button: 'right' });
    const rightReports = inputs.filter(text => { const code = /^\x1b\[<(\d+);/.exec(text); return code && (Number(code[1]) & 3) === 2; });
    expect(rightReports[0]).toMatch(/^\x1b\[<2;\d+;\d+M$/);
    expect(rightReports.some(text => /^\x1b\[<34;/.test(text))).toBe(true);
    expect(rightReports.at(-1)).toBe('\x1b[<2;1;1m');
    await input.focus(); inputs.length = 0; await page.keyboard.press('Shift+F10'); await expect(menu).toBeVisible();
    // Kitty may report the physical Shift key, but never the menu's F10 key.
    expect(inputs).toEqual(['\x1b[57441;2u', '\x1b[57441;2:3u']); await page.keyboard.press('Escape'); await expect(input).toBeFocused();
    inputs.length = 0; await page.keyboard.press('ContextMenu'); await expect(menu).toBeVisible();
    expect(inputs).toEqual([]); await page.keyboard.press('Escape'); await expect(input).toBeFocused();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await page.locator('[data-setting=rightClickPassthroughModifier]').selectOption('alt');
    await page.locator('#settings-cancel').click(); await expect(page.locator('#settings-dialog')).toBeHidden();
    expect((await (await page.request.get(runtime.url + '/api/settings')).json()).preferences.rightClickPassthroughModifier).toBe('ctrl+alt');
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(page.locator('[data-setting=rightClickPassthroughModifier]')).toHaveValue('ctrl+alt');
    await page.locator('#settings-cancel').click();
    await runtime.cli('pane', 'send-text', pane, "printf '\\033[?1000l\\033[?1006l\\033[<u'\n");
    await expect.poll(() => reporting).toBe(false); await right(); await expect(menu).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('right-click-desktop.png') });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#shield')).toBeHidden(); await right(); await expect(menu).toBeVisible();
    for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('right-click-phone.png') });
  } finally { await runtime.close(); }
});
