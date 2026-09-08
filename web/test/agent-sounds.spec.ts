import { test, expect } from '@playwright/test';
import { fixture } from './fixture';

test('native per-agent sound overrides preserve visual alerts, global mute, cancellation and restart persistence', async ({ page }) => {
  test.setTimeout(90000);
  const binary = process.env.WERDR_TERMINAL_CLIENT_BIN;
  if (!binary) throw new Error('Agent sound tests require a candidate native runtime.');
  const runtime = await fixture(false, false, false, undefined, binary);
  try {
    await page.addInitScript(() => {
      (window as any).soundPlays = [];
      HTMLMediaElement.prototype.play = function () { (window as any).soundPlays.push(this.src); return Promise.resolve(); };
    });
    const panes: { pane_id: string; workspace_id: string; tab_id: string }[] = [];
    for (let i = 0; i < 3; i++) panes.push(JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane);
    const report = (index: number, agent: string, state: string, seq: number) => runtime.cli('pane', 'report-agent', panes[index].pane_id, '--source', 'agent-sound-test', '--agent', agent, '--state', state, '--seq', String(seq));
    await report(1, 'Droid', 'working', 1); await report(2, 'Claude', 'working', 1);
    expect((await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } })).ok()).toBe(true);
    const settings = await (await page.request.get(runtime.url + '/api/settings')).json();
    expect((await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { ...settings, preferences: { ...settings.preferences, notificationSound: true, toastDelivery: 'browser', toastDelaySeconds: 0 } } })).ok()).toBe(true);
    await page.goto(runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: panes[0].workspace_id, tab: panes[0].tab_id, pane: panes[0].pane_id }));
    await expect(page.locator('#shield')).toBeHidden();
    const count = () => page.evaluate(() => (window as any).soundPlays.length);
    const open = async () => { await page.locator('#settings').click(); await page.locator('#settings-agent-sounds summary').click(); };
    const save = async () => { await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click(); await expect(page.locator('#settings-dialog')).toBeHidden(); };

    await report(1, 'Droid', 'blocked', 2); await expect(page.locator('#notice-toast')).toBeVisible();
    expect(await count()).toBe(0);
    await report(2, 'Claude', 'blocked', 2); await expect.poll(count).toBe(1);
    expect(await page.evaluate(() => (window as any).soundPlays[0])).toMatch(/request-.*\.mp3$/);

    await open(); await expect(page.locator('[data-agent-sound=droid]')).toHaveValue('off');
    await page.locator('[data-agent-sound=droid]').selectOption('on');
    await page.locator('[data-agent-sound=claude]').selectOption('off'); await save();
    await report(1, 'Droid', 'working', 3); await report(1, 'Droid', 'blocked', 4); await expect.poll(count).toBe(2);

    await open(); await page.locator('[data-agent-sound=claude]').selectOption('on'); await page.locator('#settings-cancel').click();
    await report(2, 'Claude', 'working', 3); await report(2, 'Claude', 'blocked', 4);
    await expect(page.locator('#activity')).toContainText('[4]'); expect(await count()).toBe(2);
    await open(); await page.locator('[data-setting=notificationSound]').uncheck(); await save();
    await report(1, 'Droid', 'working', 5); await report(1, 'Droid', 'blocked', 6);
    await expect(page.locator('#activity')).toContainText('[5]'); expect(await count()).toBe(2);

    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await open();
    await expect(page.locator('[data-setting=notificationSound]')).not.toBeChecked();
    await expect(page.locator('[data-agent-sound=droid]')).toHaveValue('on');
    await expect(page.locator('[data-agent-sound=claude]')).toHaveValue('off');
    expect(await page.locator('[data-agent-sound]').count()).toBe(21);
    await page.locator('[data-agent-sound=claude]').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/agent-sounds-mobile.png' });
  } finally { await page.close(); await runtime.close(); }
});
