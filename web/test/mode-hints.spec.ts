import { test, expect, type Locator } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

for (const width of [1440, 390]) test(`contextual hints remain readable across palettes at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token);
    await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.locator('#shield')).toBeHidden();
    await page.setViewportSize({ width, height: 900 });
    const input = page.locator('.pane-active .pane-content textarea');
    const original = await input.elementHandle();
    const readable = async (hints: Locator, name: string) => {
      await expect(hints).toBeVisible();
      for (const item of await hints.locator('.mode-hint, .mode-hint-label').all()) await expect(item).toBeInViewport();
      const box = (await hints.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await hints.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(name + '.png') });
    };
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
      for (const mode of ['navigate', 'resize'] as const) {
        await page.keyboard.press('Control+b'); await page.keyboard.press(mode === 'navigate' ? 'w' : 'r');
        const hints = mode === 'navigate' && width === 390 ? page.locator('.switcher-hints') : bar;
        await readable(hints, `${palette}-${mode}`);
        await expect(hints).toContainText(mode === 'navigate' ? 'workspace' : 'width');
        await page.keyboard.press('Escape');
        await expect(bar).toBeHidden();
        await expect(input).toBeFocused();
        expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      }
      await page.keyboard.press('Control+b'); await page.keyboard.press('[');
      const copyHints = page.locator('.copy-hints');
      await readable(copyHints, `${palette}-copy`);
      await expect(copyHints).toContainText('q / Escape exit');
      await page.keyboard.press('v'); await expect(copyHints).toContainText('selecting');
      await readable(copyHints, `${palette}-copy-selection`);
      await page.keyboard.press('Escape'); await page.keyboard.press('/');
      await expect(copyHints).toHaveText('Enter searchEscape cancel search');
      await readable(copyHints, `${palette}-copy-search`);
      await expect(page.locator('.copy-search input')).toBeFocused();
      await page.keyboard.press('Escape'); await page.keyboard.press('q');
      await expect(copyHints).toHaveCount(0); await expect(input).toBeFocused();
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    }
  } finally { await runtime.close(); }
});
