import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

const command = 'Reload host configuration and browser preferences';
async function login(page: Page, runtime: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  return new URL(page.url()).searchParams.get('pane')!;
}
async function reload(page: Page) { await page.keyboard.press('Control+k'); await page.locator('#command-search').fill(command); await page.getByRole('button', { name: command, exact: true }).click(); }
async function close(page: Page, runtime: Awaited<ReturnType<typeof fixture>>) {
  try { await page.unrouteAll({ behavior: 'wait' }); await page.close(); } finally { await runtime.close(); }
}

test('native reload reads existing configuration, refreshes browser preferences and preserves typed input and terminal identity', async ({ page }) => {
  const runtime = await fixture();
  try {
    expect((await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'server.reload_config' } })).status()).toBe(401);
    const pane = await login(page, runtime), selected = page.url();
    const input = await page.locator('.pane-active textarea').elementHandle();
    const original = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((item: any) => item.pane_id === pane);
    const cwd = join(runtime.directory, 'reloaded-cwd'); await mkdir(cwd);
    const config = join(runtime.directory, 'herdr/config.toml'); await mkdir(join(runtime.directory, 'herdr'), { recursive: true });
    const source = `# retain this file byte for byte\n[terminal]\nnew_cwd = ${JSON.stringify(cwd)}\n`;
    await writeFile(config, source);
    const state = await (await page.request.get(runtime.url + '/api/settings')).json();
    let fresh = false;
    await page.route('**/api/settings', route => fresh ? route.continue() : route.fulfill({ json: state }));
    const preferences = { ...state.preferences, theme: 'nord' };
    expect((await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { revision: state.revision, preferences } })).ok()).toBe(true);
    expect((await page.request.post(runtime.url + '/api/action', { headers: { Origin: 'https://untrusted.invalid' }, data: { machine: 'local', action: 'server.reload_config' } })).status()).toBe(403);
    await page.locator('.pane-active textarea').focus(); await page.keyboard.type("printf 'KEEP_%s\\n' 'RELOAD'");
    fresh = true; await page.keyboard.press('Control+b'); await page.keyboard.press('Shift+r');
    await expect(page.locator('#status')).toContainText('HOST [OK] / BROWSER [OK]');
    await expect(page.locator('#status')).toContainText('Configuration reloaded. / Preferences reloaded.');
    const themes = JSON.parse(await readFile('shared/native-themes.json', 'utf8'));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--herdr-panel-bg').trim())).toBe(themes.nord.panel_bg);
    expect(page.url()).toBe(selected); expect(await input!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator('.pane-active textarea')).toBeFocused(); await page.keyboard.press('Enter');
    await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent-unwrapped')).toContain('KEEP_RELOAD');
    const current = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((item: any) => item.pane_id === pane);
    expect(current.terminal_id).toBe(original.terminal_id); expect(await readFile(config, 'utf8')).toBe(source);
    const created = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await runtime.cli('pane', 'send-text', created.pane_id, "printf 'RELOADED_CWD=%s\\n' \"$PWD\"\n");
    await expect.poll(() => runtime.cli('pane', 'read', created.pane_id, '--source', 'recent-unwrapped')).toContain('RELOADED_CWD=' + cwd);
    expect(page.url()).toBe(selected);
    await reload(page); await expect(page.locator('#status')).toContainText('HOST [OK]');
    await page.screenshot({ path: 'test-results/configuration-reload-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await reload(page);
    await expect(page.locator('#status')).toContainText('BROWSER [OK]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('#status').evaluate(element => {
      const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 'HOST [OK] / BROWSER [OK]'.length);
      return range.getBoundingClientRect().right <= element.getBoundingClientRect().right;
    })).toBe(true);
    await page.screenshot({ path: 'test-results/configuration-reload-mobile.png' });
  } finally { await close(page, runtime); }
});

test('native configuration failure and browser read failure remain separate outcomes', async ({ page }) => {
  const runtime = await fixture();
  try {
    await login(page, runtime);
    const config = join(runtime.directory, 'herdr/config.toml'); await mkdir(join(runtime.directory, 'herdr'), { recursive: true });
    await writeFile(config, '[terminal\ninvalid TOML');
    await reload(page); await expect(page.locator('#status')).toContainText('HOST [ERROR]'); await expect(page.locator('#status')).toContainText('BROWSER [OK]');
    expect(await readFile(config, 'utf8')).toBe('[terminal\ninvalid TOML');
    await writeFile(config, '# valid configuration\n');
    await page.route('**/api/settings', route => route.fulfill({ status: 503, json: { error: 'Preference read unavailable' } }));
    await reload(page); await expect(page.locator('#status')).toContainText('HOST [OK] / BROWSER [ERROR]'); await expect(page.locator('#status')).toContainText('Preference read unavailable');
    await page.unrouteAll({ behavior: 'wait' });
    const catalog = join(runtime.directory, 'state/herdr/client'); await mkdir(catalog, { recursive: true });
    await writeFile(join(catalog, 'endpoints.json'), JSON.stringify({ version: 1, ssh: [{ id: 'b'.repeat(32), label: 'Offline reload host', target: '127.0.0.1', session: 'reload-offline', enabled: true }] }));
    await page.locator('#hosts button').filter({ hasText: 'Offline reload host' }).click();
    await reload(page); await expect(page.locator('#status')).toContainText('HOST [ERROR] / BROWSER [OK] / Offline reload host:');
  } finally { await close(page, runtime); }
});

test('a delayed reload preserves an open settings preview and does not steal focus', async ({ page }) => {
  const runtime = await fixture(); let release = () => {};
  try {
    await login(page, runtime); const selected = page.url(); let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/settings', async route => {
      if (held) { await route.continue(); return; }
      held = true; const response = await route.fetch(); await gate; await route.fulfill({ response });
    });
    await reload(page); await expect.poll(() => held).toBe(true);
    await page.locator('#settings').click(); await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.locator('[data-setting=theme]').selectOption('dracula'); await page.locator('[data-setting=fontSize]').focus();
    const preview = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--herdr-panel-bg'));
    release(); await expect(page.locator('#status')).toContainText('BROWSER [WARN]'); await expect(page.locator('#status')).toContainText('Settings editor is open; preview preserved.');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--herdr-panel-bg'))).toBe(preview);
    await expect(page.locator('[data-setting=fontSize]')).toBeFocused(); await expect(page.locator('[data-setting=theme]')).toHaveValue('dracula');
    expect(page.url()).toBe(selected);
    await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
  } finally { release(); await close(page, runtime); }
});

test('detach discards delayed reload results and resume can reload again', async ({ page }) => {
  const runtime = await fixture(); let release = () => {};
  try {
    await login(page, runtime); const selected = page.url(); let held = false, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action !== 'server.reload_config') { await route.continue(); return; }
      ++calls;
      if (held) { await route.continue(); return; }
      held = true; await route.fetch(); await gate;
      await route.fulfill({ json: { status: 'partial', diagnostics: ['STALE RELOAD RESULT'] } }).catch(() => {});
    });
    await reload(page); await expect.poll(() => held).toBe(true);
    await page.keyboard.press('Control+b'); await page.keyboard.press('Shift+r'); expect(calls).toBe(1);
    await page.keyboard.press('Control+b'); await page.keyboard.press('q'); await expect(page.locator('#detached-dialog')).toBeVisible();
    await page.locator('#resume-client').click(); await expect(page.locator('#detached-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await reload(page); await expect(page.locator('#status')).toContainText('HOST [OK]'); await expect(page.locator('#status')).not.toContainText('STALE'); expect(page.url()).toBe(selected);
  } finally { release(); await close(page, runtime); }
});
