import { expect, type Page } from '@playwright/test';
export async function consoleInput(page: Page, stage: 'username' | 'password' | 'token', value: string, submit = true) {
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', stage);
  await page.locator('#boot textarea').focus();
  await page.keyboard.insertText(value);
  if (submit) await page.keyboard.press('Enter');
}
