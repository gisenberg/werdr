import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture';

async function candidate() {
  const binary = process.env.WERDR_TERMINAL_CLIENT_BIN || process.env.WERDR_TEST_HERDR_BIN;
  if (!binary) throw new Error('Notification capability tests require a candidate native runtime.');
  const runtime = await fixture(false, false, false, undefined, binary);
  try {
    const status = JSON.parse(await runtime.cli('status', '--json'));
    expect(status.server.capabilities.semantic_notifications).toBe(true);
    return runtime;
  } catch (error) { await runtime.close(); throw error; }
}
async function login(page: Page, runtime: Awaited<ReturnType<typeof fixture>>, preferences: object = {}) {
  expect((await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } })).ok()).toBe(true);
  const settings = await (await page.request.get(runtime.url + '/api/settings')).json();
  expect((await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { ...settings, preferences: { ...settings.preferences, toastDelivery: 'browser', toastDelaySeconds: 0, ...preferences } } })).ok()).toBe(true);
}
async function openVisible(page: Page) { await page.keyboard.press('Control+b'); await page.keyboard.press('o'); }
const read = (runtime: Awaited<ReturnType<typeof fixture>>, pane: string) => runtime.cli('pane', 'read', pane, '--source', 'recent-unwrapped');

test('native custom notifications reach a browser without a terminal client and honor position, dismissal, literal text and persistence', async ({ page }) => {
  const runtime = await candidate();
  try {
    await login(page, runtime, { toastDelaySeconds: 60, notificationSound: true });
    await page.goto(runtime.url); await expect(page.locator('#boot')).toBeHidden();
    await page.locator('body').click({ position: { x: 1000, y: 500 } });
    const sound = page.waitForResponse(/request-.*\.mp3/);
    const result = JSON.parse(await runtime.cli('notification', 'show', '<b>build complete</b>', '--body', 'A native custom message', '--position', 'top-left', '--sound', 'request'));
    const audio = await sound; expect(audio.headers()['content-type']).toBe('audio/mpeg');
    expect(await audio.body()).toEqual(await readFile('../assets/sounds/request.mp3'));
    expect(result.result.shown).toBe(true);
    const toast = page.locator('#notice-toast');
    await expect(toast).toContainText('<b>build complete</b>'); await expect(toast).toContainText('A native custom message');
    await expect(toast.locator('b')).toHaveCount(0); await expect(toast).toHaveAttribute('data-position', 'top-left');
    const desktop = await toast.boundingBox(); expect(desktop!.x).toBe(12);
    await page.screenshot({ path: 'test-results/notifications-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toast).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/notifications-mobile.png' });
    await page.locator('body').click({ position: { x: 380, y: 500 } }); await openVisible(page);
    await expect(toast).toBeHidden();
    for (const position of ['top-right', 'bottom-left', 'bottom-right']) {
      await expect.poll(async () => JSON.parse(await runtime.cli('notification', 'show', position, '--position', position)).result.shown).toBe(true);
      await expect(toast).toHaveAttribute('data-position', position);
      const box = await toast.boundingBox(); expect(box).not.toBeNull();
      expect(position.endsWith('left') ? box!.x : 390 - box!.x - box!.width).toBe(12);
      expect(position.startsWith('bottom') ? 844 - box!.y - box!.height : box!.y).toBe(position.startsWith('bottom') ? 60 : 88);
      await toast.click(); await expect(toast).toBeHidden();
    }
    await page.locator('#host-toggle').click(); await page.locator('#activity').click();
    await expect(page.locator('#notice-list .notice-row')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'NO PANE TARGET', exact: true }).first()).toBeDisabled();
    await expect(page.locator('#notice-list .notice-row[data-read=false]')).toHaveCount(0);
    await page.locator('#activity-done').click();
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden();
    await expect(toast).toBeHidden();
    const persisted = JSON.parse(await readFile(runtime.directory + '/notifications.json', 'utf8'));
    expect(persisted.version).toBe(2); expect(persisted.notices).toHaveLength(4);
    expect(JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes).toHaveLength(0);
  } finally { await page.close(); await runtime.close(); }
});

test('native attention queue targets the visible pane, retains offline alerts, and preserves pending terminal input', async ({ page }) => {
  const runtime = await candidate();
  let offline = false;
  try {
    await page.routeWebSocket('**/ws/fleet*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        const event = JSON.parse(message.toString());
        if (offline && event.type === 'fleet.host') event.host.connection = 'offline';
        if (offline && event.type === 'fleet.snapshot') for (const host of event.state.hosts) host.connection = 'offline';
        socket.send(JSON.stringify(event));
      });
    });
    const panes: { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string }[] = [];
    for (let i = 0; i < 3; i++) panes.push(JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane);
    const report = (index: number, state: string, seq: number) => runtime.cli('pane', 'report-agent', panes[index].pane_id, '--source', 'notification-test', '--agent', 'Claude', '--state', state, '--seq', String(seq));
    await report(1, 'working', 1); await report(2, 'working', 1);
    await login(page, runtime);
    const first = panes[0];
    const url = runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: first.workspace_id, tab: first.tab_id, pane: first.pane_id });
    await page.goto(url); await expect(page.locator('#shield')).toBeHidden();
    await expect(page.locator('#agents button')).toHaveCount(2);
    const input = await page.locator('.pane-active textarea').elementHandle();
    await page.locator('.pane-active textarea').focus(); await page.keyboard.type("printf 'NOTIFICATION_INPUT_OK\\n'");
    await report(1, 'blocked', 2); await expect(page.locator('#notice-toast')).toBeVisible();
    const firstNotice = await page.locator('#notice-toast').getAttribute('data-notice');
    await report(2, 'blocked', 2); await expect(page.locator('#activity')).toContainText('[2]');
    await expect(page.locator('#notice-toast')).toHaveAttribute('data-notice', firstNotice!);
    expect(await input!.evaluate(node => node.isConnected)).toBe(true); expect(page.url()).toBe(url);
    await page.keyboard.press('Enter'); await expect.poll(() => read(runtime, first.pane_id)).toContain('NOTIFICATION_INPUT_OK');
    offline = true; await runtime.cli('workspace', 'rename', first.workspace_id, 'Offline notification fixture');
    await expect(page.locator('#hosts button').first()).toHaveAttribute('data-badge', 'OFFLINE');
    await openVisible(page); await expect(page.locator('#status')).toContainText('is unavailable');
    await expect(page.locator('#notice-toast')).toHaveAttribute('data-notice', firstNotice!);
    await expect(page.locator('#activity')).toContainText('[2]'); expect(page.url()).toBe(url);
    offline = false; await runtime.cli('workspace', 'rename', first.workspace_id, 'Online notification fixture');
    await expect(page.locator('#hosts button').first()).toHaveAttribute('data-badge', 'ONLINE');
    await openVisible(page);
    await expect(page).toHaveURL(new RegExp(`pane=${encodeURIComponent(panes[1].pane_id)}`));
    await expect(page.locator('#notice-toast')).not.toHaveAttribute('data-notice', firstNotice!);
    await openVisible(page); await expect(page).toHaveURL(new RegExp(`pane=${encodeURIComponent(panes[2].pane_id)}`));
    await expect(page.locator('#notice-toast')).toBeHidden();
    await expect(page.locator('.pane-active textarea')).toBeFocused();
    expect(JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.map((pane: any) => pane.terminal_id).sort()).toEqual(panes.map(pane => pane.terminal_id).sort());
  } finally { await page.close(); await runtime.close(); }
});

test('delayed native completion is cancelled when work resumes and detach drops queued presentation', async ({ page }) => {
  const runtime = await candidate();
  try {
    const first = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    const background = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    const report = (state: string, seq: number) => runtime.cli('pane', 'report-agent', background.pane_id, '--source', 'notification-delay-test', '--agent', 'Claude', '--state', state, '--seq', String(seq));
    await report('working', 1); await login(page, runtime, { toastDelaySeconds: 2 });
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: first.workspace_id, tab: first.tab_id, pane: first.pane_id }));
    await expect(page.locator('#shield')).toBeHidden(); await expect(page.locator('#agents button')).toHaveCount(1);
    await runtime.cli('notification', 'show', 'Dismiss and keep typing');
    await expect(page.locator('#notice-toast')).toContainText('Dismiss and keep typing');
    await page.locator('#notice-toast').click(); await expect(page.locator('.pane-active textarea')).toBeFocused();
    await page.keyboard.type("printf 'DISMISS_INPUT_OK\\n'"); await page.keyboard.press('Enter');
    await expect.poll(() => read(runtime, first.pane_id)).toContain('DISMISS_INPUT_OK');
    await report('idle', 2); await expect(page.locator('#activity')).toContainText('[1]');
    await report('working', 3); await expect(page.locator('#agents button')).toHaveAttribute('data-badge', 'WORKING');
    await page.waitForTimeout(2200); await expect(page.locator('#notice-toast')).toBeHidden();
    await report('blocked', 4); await expect(page.locator('#activity')).toContainText('[2]');
    await page.locator('.pane-active textarea').focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('q');
    await expect(page.locator('#detached-dialog')).toBeVisible(); await page.waitForTimeout(2200); await expect(page.locator('#notice-toast')).toBeHidden();
    await page.locator('#resume-client').click(); await expect(page.locator('#shield')).toBeHidden();
    await expect(page.locator('#notice-toast')).toBeHidden();
    await page.locator('#activity').click(); await expect(page.locator('#notice-list .notice-row')).toHaveCount(3);
  } finally { await page.close(); await runtime.close(); }
});
