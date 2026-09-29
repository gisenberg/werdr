import { test, expect, type Page } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test.use({ contextOptions: { reducedMotion: 'reduce' } });
const focus = (page: Page) => page.locator('.pane-active .pane-content textarea').focus();
async function detach(page: Page) { await focus(page); await page.keyboard.press('Control+b'); await page.keyboard.press('q'); await expect(page.locator('#detached-dialog')).toBeVisible(); }
async function login(page: Page, runtime: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
}
const panes = async (runtime: Awaited<ReturnType<typeof fixture>>) => JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes;

test('detach closes every split connection, stays idle through wakeups, and preserves a second viewer and native terminals', async ({ page, context }) => {
  const runtime = await fixture(); const sockets = new Set<string>(); let opened = 0, requests = 0;
  page.on('websocket', socket => { const id = String(++opened); sockets.add(id); socket.on('close', () => sockets.delete(id)); });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests++; });
  try {
    await login(page, runtime); await focus(page); await page.keyboard.press('Control+d'); await expect(page.locator('.terminal-pane')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
    const selected = page.url(), pane = new URL(selected).searchParams.get('pane')!;
    // The native endpoint grants one controller per terminal. An independent
    // viewer owns a different workspace and must survive this client's detach.
    const other = JSON.parse(await runtime.cli('workspace', 'create', '--cwd', '/tmp', '--label', 'independent-viewer')).result.root_pane;
    const before = await panes(runtime);
    const viewer = await context.newPage(); let output = '';
    viewer.on('websocket', socket => socket.on('framereceived', frame => {
      const value = JSON.parse(String(frame.payload)); if (value.type === 'terminal.frame') output += Buffer.from(value.bytes, 'base64').toString();
    }));
    await viewer.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: other.workspace_id, tab: other.tab_id, pane: other.pane_id })); await expect(viewer.locator('#boot')).toBeHidden(); await expect(viewer.locator('#shield')).toBeHidden();
    await page.clock.install(); await detach(page); await expect(page.locator('.terminal-pane')).toHaveCount(0); await expect.poll(() => sockets.size).toBe(0);
    const detachedOpened = opened, detachedRequests = requests;
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(31_000);
    expect(opened).toBe(detachedOpened); expect(requests).toBe(detachedRequests); await expect(page.locator('#boot')).toBeHidden();
    await page.keyboard.press('Escape'); await expect(page.locator('#detached-dialog')).toBeVisible();
    await runtime.cli('pane', 'send-text', other.pane_id, "printf 'DETACH_%s\\n' 'OTHER_VIEWER'\n");
    await expect.poll(() => output).toContain('DETACH_OTHER_VIEWER');
    expect((await panes(runtime)).map((item: any) => [item.pane_id, item.terminal_id])).toEqual(before.map((item: any) => [item.pane_id, item.terminal_id]));
    await page.screenshot({ path: 'test-results/detach-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/detach-mobile.png' });
    await page.locator('#resume-client').click(); await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    expect(page.url()).toBe(selected); await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', pane);
    await detach(page); await page.keyboard.press('r'); await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    await viewer.close();
  } finally { await runtime.close(); }
});

for (const phase of ['session', 'settings', 'fleet', 'layout', 'action']) test(`detach fences a delayed ${phase} response across explicit resume`, async ({ page }) => {
  const runtime = await fixture(); let release = () => {};
  try {
    await login(page, runtime); const selected = page.url(); let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/${phase}${phase === 'layout' ? '?*' : ''}`, async route => {
      if (held) { await route.continue(); return; }
      held = true; const response = await route.fetch(); await gate;
      // A stale authentication failure is as unsafe as a stale successful read.
      await route.fulfill(phase === 'session' ? { status: 401, json: { error: 'Stale session response' } } : { response }).catch(() => {});
    });
    if (phase === 'action') { await focus(page); await page.keyboard.press('Control+d'); }
    else if (phase === 'layout') { await focus(page); await page.keyboard.press('Control+b'); await page.keyboard.press('r'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Escape'); }
    else await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => held).toBe(true);
    await detach(page); await page.locator('#resume-client').click(); await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    release(); await page.waitForTimeout(200);
    expect(page.url()).toBe(selected); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#detached-dialog')).toBeHidden();
    await expect(page.locator('#status')).not.toContainText('Stale session');
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', new URL(selected).searchParams.get('pane')!);
  } finally { release(); await runtime.close(); }
});

test('resume requires explicit recovery when the saved pane closes and sign-out remains available while detached', async ({ page }) => {
  const runtime = await fixture();
  try {
    await login(page, runtime); const workspace = new URL(page.url()).searchParams.get('workspace')!;
    await detach(page); await runtime.cli('workspace', 'close', workspace);
    await page.locator('#resume-client').click(); await expect(page.locator('#detached-dialog')).toBeHidden();
    await expect(page.locator('#shield')).toContainText('unavailable'); await expect(page.locator('.terminal-pane')).toHaveCount(0);
    await page.locator('#commands').click(); await page.locator('#command-search').fill('Detach this browser');
    await page.locator('#command-list').getByRole('button', { name: 'Detach this browser', exact: true }).click();
    await expect(page.locator('#detached-dialog')).toBeVisible(); await page.locator('#detached-logout').click();
    await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#boot')).toBeVisible();
    await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  } finally { await runtime.close(); }
});

test('expired authentication retains the detached selection guard through sign-in', async ({ page, context }) => {
  const runtime = await fixture(); let attachments = 0;
  page.on('websocket', socket => { if (socket.url().includes('/ws/terminal?')) attachments++; });
  try {
    await login(page, runtime); const original = new URL(page.url()).searchParams.get('workspace')!;
    await detach(page); await runtime.cli('workspace', 'close', original);
    await runtime.cli('workspace', 'create', '--cwd', '/tmp', '--label', 'replacement');
    await context.clearCookies(); const detachedAttachments = attachments;
    await page.locator('#resume-client').click(); await expect(page.locator('#boot')).toBeVisible();
    await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await expect(page.locator('#shield')).toContainText('unavailable');
    expect(attachments).toBe(detachedAttachments); await expect(page.locator('.terminal-pane')).toHaveCount(0);
    await page.locator('#workspaces button').filter({ hasText: 'replacement' }).click(); await expect(page.locator('#shield')).toBeHidden();
  } finally { await runtime.close(); }
});

test('failed resume stays detached and retries only on explicit request', async ({ page }) => {
  const runtime = await fixture();
  try {
    await login(page, runtime); await detach(page);
    await page.route('**/api/session', route => route.abort('failed'), { times: 1 });
    await page.locator('#resume-client').click(); await expect(page.locator('#detached-status')).toContainText('Unable to reconnect');
    await expect(page.locator('#resume-client')).toBeEnabled(); await expect(page.locator('.terminal-pane')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(page.locator('#detached-dialog')).toBeVisible();
    await page.locator('#resume-client').click(); await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
  } finally { await runtime.close(); }
});
