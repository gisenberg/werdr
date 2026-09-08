import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('all desktop panes recover after exhausting attachment retries during a gateway outage', async ({ page }) => {
  test.setTimeout(90000);
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    await page.locator('#commands').click(); await page.locator('#command-list').getByRole('button', { name: 'Split right', exact: true }).click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2); await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0);
    const panes = await page.locator('.terminal-pane').elementHandles();
    for (const pane of panes) {
      const textarea = await pane.$('textarea'); await textarea!.focus(); await page.keyboard.type('export RECOVERY_FIXTURE=native_shell_survived'); await page.keyboard.press('Enter');
      const id = await pane.getAttribute('data-pane'); await expect.poll(() => runtime.cli('pane', 'read', id!, '--source', 'recent')).toContain('RECOVERY_FIXTURE');
    }
    await runtime.stopGateway();
    await expect(page.locator('.pane-shield').filter({ hasText: 'Retry or use TAKE CONTROL' })).toHaveCount(2, { timeout: 45000 });
    await expect(page.locator('#boot')).toBeHidden();
    await runtime.startGateway();
    await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('#shield')).toBeHidden();
    for (const pane of panes) {
      expect(await pane.evaluate(node => node.isConnected)).toBe(true);
      const textarea = await pane.$('textarea'); await textarea!.focus(); await page.keyboard.type('printf "RECOVERED_%s\\n" "$RECOVERY_FIXTURE"'); await page.keyboard.press('Enter');
      const id = await pane.getAttribute('data-pane'); await expect.poll(() => runtime.cli('pane', 'read', id!, '--source', 'recent')).toContain('RECOVERED_native_shell_survived');
    }
  } finally { await runtime.close(); }
});
