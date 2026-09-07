import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(false, false, true); });
test.afterAll(async () => { await runtime?.close(); });
test('native integration installation and removal preserve unrelated agent settings', async ({ page }) => {
  const path = join(runtime.directory, 'claude-config', 'settings.json'); await writeFile(path, JSON.stringify({ env: { RETAIN_FIXTURE: 'yes' } }));
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.locator('#settings').click(); await page.locator('#settings-integrations').click();
  await expect(page.locator('.integration-row')).toHaveCount(17);
  const row = page.locator('.integration-row[data-target=claude]'); await expect(row).toContainText('[NOT INSTALLED]');
  await row.getByRole('button', { name: 'INSTALL', exact: true }).click(); await expect(row).toContainText('[CURRENT]');
  const installed = JSON.parse(await readFile(path, 'utf8')); expect(installed.env.RETAIN_FIXTURE).toBe('yes'); expect(installed.hooks.SessionStart.length).toBeGreaterThan(0);
  await expect(page.locator('#integration-results')).toContainText('claude');
  await row.getByRole('button', { name: 'REINSTALL', exact: true }).click(); await expect(page.locator('#integration-refresh')).toBeEnabled();
  const repeated = JSON.parse(await readFile(path, 'utf8')); expect(repeated.hooks.SessionStart.length).toBe(installed.hooks.SessionStart.length);
  await page.screenshot({ path: 'test-results/integrations-desktop.png' });
  page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'UNINSTALL', exact: true }).click(); await expect(row).toContainText('[NOT INSTALLED]');
  expect(JSON.parse(await readFile(path, 'utf8')).env.RETAIN_FIXTURE).toBe('yes');
  await writeFile(path, '{invalid-json'); await row.getByRole('button', { name: 'INSTALL', exact: true }).click(); await expect(page.locator('#integration-results')).toContainText('[ERROR]'); expect(await readFile(path, 'utf8')).toBe('{invalid-json');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

 test('terminal ownership rejection is visible through the active pane shield', async ({ page, browser }) => {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  const viewer = await browser.newContext();
  try {
    const second = await viewer.newPage(); await second.goto(page.url()); await consoleInput(second, 'token', runtime.token); await expect(second.locator('#boot')).toBeHidden();
    await expect(second.locator('#shield')).toContainText(/already.*attached|already controlled/, { timeout: 30000 });
    await expect(page.locator('#shield')).toBeHidden();
  } finally { await viewer.close(); }
});
