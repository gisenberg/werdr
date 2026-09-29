import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

// OSC 52 forwarding needs both a capable owning runtime and terminal companion.
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(false, false, false, undefined, process.env.WERDR_TEST_HERDR_BIN || resolve('../target/release/herdr')); });
test.afterAll(async () => { await runtime?.close(); });

async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const created = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'workspace.create');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const id = (await (await created).json()).root_pane.pane_id as string;
  await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', id); await expect(page.locator('#shield')).toBeHidden();
  return id;
}
// The shell prints a marker after the write so the test can wait for the pane to process it.
const osc52 = (id: string, text: string, marker: string) => runtime.cli('pane', 'send-text', id, `printf '\\033]52;c;%s\\a' "$(printf '%s' '${text}' | base64 -w0)"; printf '${marker}_%s\\n' DONE\n`);
const processed = (id: string, marker: string) => expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain(`${marker}_DONE`);

test('application OSC 52 writes reach the focused browser clipboard with native copy feedback', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const id = await create(page);
  await page.locator('.pane-active canvas').first().evaluate(node => { (node as any).osc52Identity = 'retained'; });
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await osc52(id, 'OSC52 東京 ✓', 'FOCUSED'); await processed(id, 'FOCUSED');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('OSC52 東京 ✓');
  await expect(page.locator('#clipboard-feedback')).toBeVisible();
  await expect(page.locator('.terminal-clipboard-request')).toBeHidden();
  await expect(page.locator('.pane-active textarea')).toBeFocused();
  expect(await page.locator('.pane-active canvas').first().evaluate(node => (node as any).osc52Identity)).toBe('retained');
});

test('rejected background OSC 52 writes become an explicit expiring copy action on desktop and phone', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Model browsers that accept clipboard writes only while dispatching a click,
  // unlike Chromium's multi-second transient activation window.
  await page.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    let clicking = false;
    addEventListener('click', () => { clicking = true; setTimeout(() => { clicking = false; }); }, true);
    navigator.clipboard.writeText = (text: string) => clicking ? write(text) : Promise.reject(new DOMException('Activation required', 'NotAllowedError'));
  });
  const id = await create(page);
  await page.evaluate(() => navigator.clipboard.readText()).catch(() => {});
  await osc52(id, 'first request', 'FIRST'); await processed(id, 'FIRST');
  const request = page.locator('.terminal-clipboard-request');
  await expect(request).toBeVisible(); await expect(request).toContainText('CLIPBOARD REQUEST 13 CHARACTERS');
  // A newer request replaces the older one rather than queueing stale content.
  await osc52(id, 'second 東京', 'SECOND'); await processed(id, 'SECOND');
  await expect(request).toContainText('CLIPBOARD REQUEST 9 CHARACTERS');
  const pane = (await page.locator('.pane-active').boundingBox())!, box = (await request.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(pane.x); expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  await page.screenshot({ path: 'test-results/terminal-osc52-desktop.png' });
  await request.getByRole('button', { name: 'Copy text requested by the terminal' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('second 東京');
  await expect(request).toBeHidden(); await expect(page.locator('#clipboard-feedback')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await osc52(id, 'phone', 'PHONE'); await processed(id, 'PHONE');
  await expect(request).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const phoneBox = (await request.boundingBox())!;
  expect(phoneBox.x).toBeGreaterThanOrEqual(0); expect(phoneBox.x + phoneBox.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/terminal-osc52-mobile.png' });
  await request.getByRole('button', { name: 'Dismiss terminal clipboard request' }).click();
  await expect(request).toBeHidden();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('second 東京');
});
