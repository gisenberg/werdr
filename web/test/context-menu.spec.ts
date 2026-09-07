import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('context actions retain their native target and support keyboard dismissal', async ({ page }) => {
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const first = new URL(page.url()).searchParams.get('workspace')!;
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).not.toBe(first);
    const second = new URL(page.url()).searchParams.get('workspace')!;
    const firstRow = page.locator(`#workspaces button[data-id="local/${first}"]`);
    await firstRow.focus(); await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'RENAME', exact: true })).toBeFocused();
    await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'CLOSE WORKSPACE' })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(firstRow).toBeFocused();
    await firstRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'RENAME', exact: true }).click();
    await page.locator('#rename-value').fill('RENAMED INACTIVE WORKSPACE'); await page.locator('#rename-form button[type=submit]').click();
    await expect(firstRow).toContainText('RENAMED INACTIVE WORKSPACE');
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(second);
    await expect(page.locator('#shield')).toBeHidden();
    await page.locator('.pane-active .pane-title').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'SPLIT DOWN' }).click(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    const pane = new URL(page.url()).searchParams.get('pane')!;
    await page.locator('.pane-active .pane-title').click({ button: 'right' });
    await page.screenshot({ path: 'test-results/context-menu-desktop.png' });
    await runtime.cli('pane', 'close', pane); await expect(page.getByRole('menu')).not.toBeVisible();
    await page.locator('#tabs button.active').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'NEW TAB' }).click();
    await expect(page.locator('#tabs button')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.pane-active .pane-title').focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible(); await page.screenshot({ path: 'test-results/context-menu-mobile.png' });
    const bounds = await page.getByRole('menu').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape'); await expect(page.locator('.pane-active .pane-title')).toBeFocused();
  } finally { await runtime.close(); }
});
