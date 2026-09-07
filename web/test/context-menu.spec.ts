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
    await page.locator('#panes > button.active').focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'CLEAR PANE NAME' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'RENAME', exact: true }).click();
    await page.locator('#rename-value').fill('MANUAL PANE NAME'); await page.locator('#rename-form button[type=submit]').click();
    await expect(page.locator('.pane-active .pane-title')).toContainText('MANUAL PANE NAME');
    await page.locator('#panes > button.active').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'CLEAR PANE NAME' }).click();
    await expect(page.locator('.pane-active .pane-title')).not.toContainText('MANUAL PANE NAME');
    const paneState = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((item: { pane_id: string }) => item.pane_id === new URL(page.url()).searchParams.get('pane'));
    expect(paneState.label ?? null).toBe(null);
    await page.locator('#panes > button.active').focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'CLEAR PANE NAME' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'SPLIT DOWN' }).click(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    const pane = new URL(page.url()).searchParams.get('pane')!;
    await expect(page.locator('#shield')).toBeHidden();
    const other = await page.locator('.terminal-pane:visible:not(.pane-active)').getAttribute('data-pane');
    const before = await page.locator(`.terminal-pane[data-pane="${other}"]`).boundingBox();
    await page.locator(`#panes button[data-id="${other}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'SWAP WITH FOCUSED PANE' }).click();
    await expect.poll(async () => (await page.locator(`.terminal-pane[data-pane="${other}"]`).boundingBox())!.y).toBeGreaterThan(before!.y);

    await page.locator('.pane-active .pane-title').click({ button: 'right' });
    await page.screenshot({ path: 'test-results/context-menu-desktop.png' });
    await runtime.cli('pane', 'close', pane); await expect(page.getByRole('menu')).not.toBeVisible();
    await page.locator('#tabs button.active').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'NEW TAB' }).click();
    await expect(page.locator('#tabs button')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => new Promise(requestAnimationFrame)); await page.locator('#panes > button.active').focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible(); await page.screenshot({ path: 'test-results/context-menu-mobile.png' });
    const bounds = await page.getByRole('menu').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape'); await expect(page.locator('#panes > button.active')).toBeFocused();
  } finally { await runtime.close(); }
});
