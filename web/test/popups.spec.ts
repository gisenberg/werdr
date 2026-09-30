import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('native popups attach on desktop and mobile with application keys, retained underlying panes, and exact close', async ({ page }) => {
  test.setTimeout(120000);
  const binary = process.env.WERDR_TEST_HERDR_BIN;
  if (!binary) throw new Error('Popup tests require the candidate native runtime.');
  const runtime = await fixture(false, false, false, undefined, binary);
  try {
    let disconnectPopup: (() => void) | undefined;
    await page.routeWebSocket('**/ws/terminal?*', socket => {
      socket.connectToServer();
      if (new URL(socket.url()).searchParams.get('target') === 'popup') disconnectPopup = () => socket.close();
    });
    let frame: { width: number; height: number } | undefined;
    page.on('websocket', socket => { if (socket.url().includes('target=popup')) socket.on('framereceived', event => { try { const value = JSON.parse(String(event.payload)); if (value.type === 'terminal.frame') frame = value; } catch {} }); });
    const status = JSON.parse(await runtime.cli('status', '--json'));
    expect(status.server.capabilities.popup_sessions).toBe(true);
    const directory = join(runtime.directory, 'popup-plugin'), capture = join(runtime.directory, 'popup-input');
    await mkdir(directory);
    const script = join(directory, 'popup.py');
    await writeFile(script, `import os, tty\ntty.setraw(0)\nprint("NATIVE_POPUP_READY", flush=True)\nwith open(${JSON.stringify(capture)}, "ab", buffering=0) as output:\n while True:\n  value = os.read(0, 1)\n  if not value: break\n  output.write(value)\n  if value == b"q": break\n`);
    await writeFile(join(directory, 'herdr-plugin.toml'), `id = "example.popup-test"\nname = "Popup test"\nversion = "0.1.0"\nmin_herdr_version = "0.7.0"\n[[panes]]\nid = "popup"\ntitle = "Popup"\nplacement = "popup"\ncommand = ["python3", ${JSON.stringify(script)}]\n`);
    await runtime.cli('plugin', 'link', directory);
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const underlying = await page.locator('#terminal textarea').elementHandle();
    const originalUrl = page.url();
    await runtime.cli('plugin', 'pane', 'open', '--plugin', 'example.popup-test', '--entrypoint', 'popup', '--width', '80%', '--height', '70%');
    const popup = page.locator('#native-popup');
    await expect(popup).toBeVisible(); await expect(popup.locator('.pane-shield')).toBeHidden(); await expect(popup.locator('.terminal-pane textarea')).toBeFocused();
    await expect(popup.getByRole('button', { name: '[R] RETRY', exact: true })).toBeHidden();
    await expect(popup.getByRole('button', { name: '[T] TAKE CONTROL', exact: true })).toBeHidden();
    await expect.poll(() => [frame?.width, frame?.height]).toEqual([Number(await popup.getAttribute('data-cols')), Number(await popup.getAttribute('data-rows'))]);
    await page.keyboard.press('Escape'); await page.keyboard.press('Control+b'); await page.keyboard.press('PageUp');
    await expect.poll(async () => (await readFile(capture)).toString('hex')).toContain('1b021b5b357e');
    await expect(popup).toBeVisible(); expect(page.url()).toBe(originalUrl);
    expect(await underlying!.evaluate(node => node.isConnected)).toBe(true);
    await expect(popup.locator('.copy-layer, .native-scrollbar')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/popup-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(popup.locator('.pane-shield')).toBeHidden();
    await expect.poll(async () => { const box = await popup.boundingBox(); return box ? box.x + box.width : Infinity; }).toBeLessThanOrEqual(391);
    await expect.poll(() => [frame?.width, frame?.height]).toEqual([Number(await popup.getAttribute('data-cols')), Number(await popup.getAttribute('data-rows'))]);
    const box = await popup.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    // The modal popup carries its own key row over the inert page row.
    const popupKeys = popup.locator('.terminal-keys'), pageKeys = page.locator('#terminal-key-row');
    await expect(popupKeys).toBeVisible();
    await expect.poll(async () => JSON.stringify(await popupKeys.boundingBox())).toBe(JSON.stringify(await pageKeys.boundingBox()));
    expect(box!.y + box!.height).toBeLessThanOrEqual((await pageKeys.boundingBox())!.y + 1);
    await popupKeys.getByRole('button', { name: 'Escape' }).click(); await popupKeys.getByRole('button', { name: 'Up arrow' }).click();
    await expect.poll(async () => (await readFile(capture)).toString('hex')).toContain('1b021b5b357e1b1b5b41');
    await expect(popup.locator('.terminal-pane textarea')).toBeFocused();
    await page.screenshot({ path: 'test-results/popup-mobile.png' });
    const fleet = await (await page.request.get(runtime.url + '/api/fleet')).json();
    const nativePopup = fleet.hosts.find((host: any) => host.machine.id === 'local').popup.popup;
    const rejected = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'popup.close_exact', terminal_id: nativePopup.terminal_id, owner_tab_id: 'wrong-tab' } });
    expect(rejected.ok()).toBe(false); await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: '[X] CLOSE', exact: true }).click(); await expect(popup).not.toBeVisible();
    expect(await underlying!.evaluate(node => node.isConnected)).toBe(true);
    await runtime.cli('plugin', 'pane', 'open', '--plugin', 'example.popup-test', '--entrypoint', 'popup', '--width', '6', '--height', '4');
    await expect(popup).toBeVisible(); await expect(popup.locator('.pane-shield')).toBeHidden(); await expect(popup.locator('.terminal-pane textarea')).toBeFocused();
    await expect.poll(() => frame && { width: frame.width, height: frame.height }).toEqual({ width: 4, height: 2 });
    const close = popup.getByRole('button', { name: '[X] CLOSE', exact: true });
    await expect(close).toBeVisible();
    await expect(close.locator('.popup-button-label')).toBeHidden();
    expect(await popup.locator('.popup-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(disconnectPopup).toBeDefined(); disconnectPopup!();
    const retry = popup.getByRole('button', { name: '[R] RETRY', exact: true });
    await expect(retry).toBeVisible();
    const takeover = popup.getByRole('button', { name: '[T] TAKE CONTROL', exact: true });
    await expect(takeover).toBeVisible();
    for (const button of [retry, takeover, close]) {
      await button.focus();
      const geometry = await button.evaluate(element => {
        const bounds = element.getBoundingClientRect(), toolbar = element.parentElement!.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, height: bounds.height, toolbarLeft: toolbar.left, toolbarRight: toolbar.right, toolbarHeight: toolbar.height };
      });
      expect(geometry.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.toolbarLeft - 1);
      expect(geometry.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.toolbarRight + 1);
      expect(geometry.height).toBeLessThanOrEqual(geometry.toolbarHeight);
    }
    await retry.click();
    await expect(popup.locator('.pane-shield')).toBeHidden();
    await expect(retry).toBeHidden();
    await popup.locator('.terminal-pane textarea').focus();
    await page.keyboard.type('q'); await expect(popup).not.toBeVisible();
    await expect(page.locator('#terminal textarea')).toBeFocused();
  } finally { await runtime.close(); }
});
