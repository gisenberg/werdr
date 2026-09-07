import { test, expect } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('palette searches native targets, moves by keyboard, and focuses selected panes', async ({ page }) => {
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const first = new URL(page.url()).searchParams.get('pane')!;
    const original = await page.locator('.pane-active textarea').elementHandle();
    await page.keyboard.press('Control+d'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    const second = new URL(page.url()).searchParams.get('pane')!; expect(second).not.toBe(first);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Pane:');
    const results = page.locator('#command-list button'); await expect(results).toHaveCount(2);
    await page.keyboard.press('ArrowDown'); await expect(results.nth(0)).toBeFocused();
    await page.keyboard.press('End'); await expect(results.nth(1)).toBeFocused();
    await page.keyboard.press('Home'); await expect(results.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(page.locator('#command-search')).toBeFocused();
    await page.locator('#command-search').fill('local/' + first + ';'); await expect(results).toHaveCount(1);
    await page.keyboard.press('Enter'); await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', first);
    await expect(page.locator('.pane-active textarea')).toBeFocused(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Pane:'); await expect(results).toHaveCount(2);
    await runtime.cli('pane', 'close', second); await expect(results).toHaveCount(1);
    await expect(page.locator('#command-search')).toHaveValue('Pane:');
    await page.locator('#command-search').fill('nonexistent-navigation-target'); await expect(page.locator('#command-list')).toContainText('No matching');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Workspace:'); await expect(results).toHaveCount(1);
    await page.keyboard.press('Enter'); await expect(page.locator('#command-dialog')).not.toBeVisible();
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Tab:'); await expect(results).toHaveCount(1);
    await page.screenshot({ path: 'test-results/navigation-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/navigation-mobile.png' });
    await page.keyboard.press('Enter'); await expect(page.locator('.pane-active textarea')).toBeFocused();
  } finally { await runtime.close(); }
});
