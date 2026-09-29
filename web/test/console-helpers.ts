import { expect, type Page } from '@playwright/test';
export async function consoleInput(page: Page, stage: 'username' | 'password' | 'token', value: string, submit = true) {
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', stage);
  await page.locator('#boot textarea').focus();
  await page.keyboard.insertText(value);
  if (submit) await page.keyboard.press('Enter');
}

export async function terminalGeometry(page: Page) {
  // Copy mode only exposes its caret after native content and browser cells match.
  await page.keyboard.press('Control+k');
  await page.locator('#command-list').getByRole('button', { name: 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/);
  const caret = (await page.locator('.copy-caret').boundingBox())!, canvas = (await page.locator('.pane-active canvas').first().boundingBox())!;
  await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  return { canvas, point: (row: number, col: number) => ({ x: canvas.x + (col + .5) * caret.width, y: canvas.y + (row + .5) * caret.height }) };
}
