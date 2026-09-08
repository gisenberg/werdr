import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('late action failures identify their original host after selection changes', async ({ page }) => {
  const runtime = await fixture(); let release = () => {};
  try {
    const catalog = join(runtime.directory, 'state/herdr/client'); await mkdir(catalog, { recursive: true });
    await writeFile(join(catalog, 'endpoints.json'), JSON.stringify({ version: 1, ssh: [{ id: 'a'.repeat(32), label: 'Unavailable fixture', target: '127.0.0.1', session: 'status-unavailable', enabled: true }] }), { mode: 0o600 });
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const source = await page.locator('#hosts button').first().getAttribute('aria-label');
    let requested = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON().action !== 'pane.resize') { await route.continue(); return; }
      requested = true; await gate;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Delayed fixture rejection' }) });
    });
    await page.locator('.pane-active textarea').focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('r'); await page.keyboard.press('ArrowLeft');
    await expect.poll(() => requested).toBe(true);
    const target = page.locator('#hosts button').filter({ hasText: 'Unavailable fixture' });
    await target.click(); await expect(target).toHaveClass(/active/); release();
    await expect(page.locator('#status')).toHaveText(`[ERROR] ${source}: Delayed fixture rejection`);
    await expect(page.locator('#status')).toHaveAttribute('title', `[ERROR] ${source}: Delayed fixture rejection`);
    await expect(target).toHaveClass(/active/);
    await page.screenshot({ path: 'test-results/status-line-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/status-line-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#hosts button').first().click();
    await expect(page.locator('#status')).not.toContainText('Delayed fixture rejection');
  } finally { release(); await runtime.close(); }
});
