import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });
test('sidebar split persists, scrolls independently and preserves the terminal', async ({ page }) => {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  const original = await page.locator('#terminal textarea').elementHandle();
  const terminalBox = await page.locator('#terminal').boundingBox();
  const divider = page.getByRole('separator', { name: 'Workspace and agent section sizes' });
  const saved = async () => (await (await page.request.get(runtime.url + '/api/settings')).json()).preferences;
  await divider.focus(); await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await saved()).sidebarSectionPercent).toBe(55);
  await expect(divider).not.toHaveAttribute('aria-disabled', 'true');
  const box = await divider.boundingBox(), sections = await page.locator('#rail-sections').boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + 3); await page.mouse.down();
  await page.mouse.move(box!.x + 30, sections!.y + sections!.height * .7); await page.mouse.up();
  await expect.poll(async () => (await saved()).sidebarSectionPercent).toBe(70);
  expect(await page.locator('#terminal').boundingBox()).toEqual(terminalBox);
  expect(await original!.evaluate(node => node === document.querySelector('#terminal textarea'))).toBe(true);
  // A concurrent browser's unrelated preference is retained by the drag save.
  const latest = await (await page.request.get(runtime.url + '/api/settings')).json();
  const changed = await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { revision: latest.revision, preferences: { ...latest.preferences, theme: 'nord' } } });
  expect(changed.ok()).toBe(true);
  await divider.focus(); await page.keyboard.press('Home');
  await expect.poll(async () => (await saved()).sidebarSectionPercent).toBe(10);
  expect((await saved()).theme).toBe('nord');
  await expect(divider).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('End'); await expect.poll(async () => (await saved()).sidebarSectionPercent).toBe(90);
  await expect(divider).not.toHaveAttribute('aria-disabled', 'true');
  const endBox = await divider.boundingBox();
  await page.mouse.move(endBox!.x + 30, endBox!.y + 3); await page.mouse.down();
  await page.mouse.move(endBox!.x + 30, sections!.y + sections!.height * .5);
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '90');
  expect((await saved()).sidebarSectionPercent).toBe(90);
  await page.route('**/api/settings', route => route.request().method() === 'POST' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Concurrent settings edit' }) }) : route.continue());
  await divider.focus(); await page.keyboard.press('Home');
  await expect(page.locator('#status')).toContainText('Concurrent settings edit');
  await expect(divider).toHaveAttribute('aria-valuenow', '90');
  await page.unroute('**/api/settings');
  await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
  await expect(divider).toHaveAttribute('aria-valuenow', '90');
  await page.locator('#settings').click(); await page.locator('[data-setting=sidebarSectionPercent]').fill('50');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await page.locator('#settings-cancel').click(); await expect(divider).toHaveAttribute('aria-valuenow', '90');
  await page.locator('#terminal textarea').focus(); await page.keyboard.type("printf 'SIDEBAR_%s\\n' KEPT_SHELL"); await page.keyboard.press('Enter');
  const pane = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes[0].pane_id;
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('SIDEBAR_KEPT_SHELL');
  // Populate presentation rows without spawning dozens of fixture processes.
  await page.evaluate(() => {
    for (const id of ['workspaces', 'agents']) {
      const nav = document.getElementById(id)!;
      for (let i = 0; i < 50; i++) { const button = document.createElement('button'); button.textContent = `${id} ${i}`; nav.append(button); }
    }
  });
  const scroll = (id: string) => page.locator(`#${id}`).evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, content: node.scrollHeight }));
  expect((await scroll('agents')).content).toBeGreaterThan((await scroll('agents')).height);
  await page.locator('#agents').evaluate(node => { node.scrollTop = 200; });
  expect((await scroll('agents')).top).toBe(200); expect((await scroll('workspaces')).top).toBe(0);
  await page.screenshot({ path: 'test-results/sidebar-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#host-toggle').click();
  await expect(divider).toBeHidden(); await expect(page.locator('#rail')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/sidebar-mobile.png' });
});
