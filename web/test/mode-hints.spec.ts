import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

for (const width of [1440, 390]) test(`contextual hints remain readable across palettes at ${width}px`, async ({ page }, testInfo) => {
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token);
    await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.locator('#shield')).toBeHidden();
    await page.setViewportSize({ width, height: 900 });
    const input = page.locator('.pane-active .pane-content textarea');
    const original = await input.elementHandle();
    for (const palette of ['catppuccin', 'catppuccin-latte']) {
      await page.locator('#settings').click();
      await page.locator('[data-setting=appearance]').selectOption('theme');
      await page.locator('[data-setting=theme]').selectOption(palette);
      await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click();
      await expect(page.locator('#settings-dialog')).toBeHidden();
      await input.focus(); await page.keyboard.press('Control+b');
      const bar = page.locator('#shortcut-status');
      await expect(bar).toBeVisible(); await expect(bar).toHaveAttribute('data-mode', 'prefix');
      await page.screenshot({ path: testInfo.outputPath(`${palette}-prefix.png`) });
      for (const item of await bar.locator('.mode-hint, .mode-hint-label').all()) await expect(item).toBeInViewport();
      const box = (await bar.boundingBox())!, footer = (await page.locator('footer').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
      await page.keyboard.press('Escape'); await expect(bar).toBeHidden(); await expect(bar).toBeEmpty();
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      await expect(input).toBeFocused();
    }
  } finally { await runtime.close(); }
});
