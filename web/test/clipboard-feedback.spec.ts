import { test, expect, type Page } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(false, false, false, undefined, process.env.WERDR_TERMINAL_CLIENT_BIN); });
test.afterAll(async () => { await runtime?.close(); });
async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const created = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'workspace.create');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const id = (await (await created).json()).root_pane.pane_id as string;
  await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', id); await expect(page.locator('#shield')).toBeHidden();
  await runtime.cli('pane', 'send-text', id, "printf 'CLIPBOARD_%s\\n' FEEDBACK_東京\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('CLIPBOARD_FEEDBACK_東京');
  return id;
}
async function preferences(page: Page, enabled: boolean, position: string) {
  await page.locator('#settings').click();
  await page.locator('[data-setting=clipboardToast]').setChecked(enabled);
  await page.locator('[data-setting=clipboardToastPosition]').selectOption(position);
  await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}
async function copy(page: Page) {
  await page.keyboard.press('Control+k');
  await page.locator('#command-list').getByRole('button', { name: 'Terminal: search native scrollback', exact: true }).click();
  await page.locator('#panes .copy-search input').fill('CLIPBOARD_FEEDBACK_東京');
  await page.locator('#panes .copy-search input').press('Enter');
  await expect(page.locator('.copy-status')).toContainText('1/1');
  await page.locator('.copy-layer').focus(); await page.keyboard.press('y');
}

test('native clipboard feedback supports all six positions, expires, and keeps the terminal and focus intact', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await create(page);
  await page.locator('.pane-active canvas').first().evaluate(node => { (node as any).clipboardIdentity = 'retained'; });
  const toast = page.locator('#clipboard-feedback');
  for (const position of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    await preferences(page, true, position); await copy(page);
    await expect(toast).toBeVisible(); await expect(toast).toHaveAttribute('data-position', position);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('CLIPBOARD_FEEDBACK_東京');
    const area = (await page.locator('#terminal').boundingBox())!, box = (await toast.boundingBox())!;
    const expectedX = position.endsWith('left') ? area.x : position.endsWith('right') ? area.x + area.width - box.width : area.x + (area.width - box.width) / 2;
    expect(Math.abs(box.x - expectedX)).toBeLessThan(1);
    expect(Math.abs(box.y - (position.startsWith('top') ? area.y : area.y + area.height - box.height))).toBeLessThan(1);
    await expect(page.locator('.pane-active textarea')).toBeFocused();
    expect(await page.locator('.pane-active canvas').first().evaluate(node => (node as any).clipboardIdentity)).toBe('retained');
  }
  await page.screenshot({ path: 'test-results/clipboard-feedback-desktop.png' });
  await expect(toast).toBeHidden({ timeout: 3000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await preferences(page, true, 'bottom-center'); await copy(page); await expect(toast).toBeVisible();
  const area = (await page.locator('#terminal').boundingBox())!, box = (await toast.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(area.x); expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/clipboard-feedback-mobile.png' });
});

test('clipboard success preferences survive restart and cancellation without suppressing copy failures', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await create(page);
  await preferences(page, false, 'top-center');
  await copy(page); await expect(page.locator('.copy-layer')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('CLIPBOARD_FEEDBACK_東京');
  await expect(page.locator('#clipboard-feedback')).toBeHidden();
  await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
  await page.locator('#settings').click();
  await expect(page.locator('[data-setting=clipboardToast]')).not.toBeChecked();
  await expect(page.locator('[data-setting=clipboardToastPosition]')).toHaveValue('top-center');
  await page.locator('[data-setting=clipboardToast]').check();
  await page.locator('[data-setting=clipboardToastPosition]').selectOption('bottom-right');
  await page.locator('#settings-cancel').click(); await copy(page);
  await expect(page.locator('.copy-layer')).toHaveCount(0); await expect(page.locator('#clipboard-feedback')).toBeHidden();
  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new Error('Clipboard denied for test'); }; });
  await copy(page); await expect(page.locator('.copy-notice')).toContainText('Copy failed: Clipboard denied for test');
  await expect(page.locator('#clipboard-feedback')).toBeHidden();
});

test('clipboard feedback avoids a native notification and clears when this browser detaches', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await create(page);
  await preferences(page, true, 'top-right');
  await page.locator('#settings').click(); await page.locator('[data-setting=toastDelivery]').selectOption('browser');
  await page.locator('[data-setting=toastNativeDuration]').uncheck();
  await page.locator('[data-setting=toastSeconds]').fill('60');
  await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click();
  await runtime.cli('notification', 'show', 'Clipboard layout test', '--position', 'top-right');
  await expect(page.locator('#notice-toast')).toBeVisible(); await copy(page);
  await expect(page.locator('#clipboard-feedback')).toBeVisible();
  await expect(page.locator('#notice-toast')).toBeVisible();
  const notice = (await page.locator('#notice-toast').boundingBox())!, feedback = (await page.locator('#clipboard-feedback').boundingBox())!;
  expect(feedback.y).toBeGreaterThanOrEqual(notice.y + notice.height);
  await page.keyboard.press('Control+b'); await page.keyboard.press('q');
  await expect(page.locator('#clipboard-feedback')).toBeHidden();
});
