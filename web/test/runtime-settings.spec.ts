import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

test('runtime settings preserve TOML, reload new-pane cwd, and reject concurrent edits', async ({ page }) => {
  test.skip(!process.env.WERDR_TERMINAL_CLIENT_BIN, 'Requires the configuration companion.');
  const runtime = await fixture();
  try {
    expect((await page.request.get(runtime.url + '/api/runtime-settings?machine=local')).status()).toBe(401);
    const config = resolve(runtime.directory, 'herdr/config.toml');
    await mkdir(resolve(runtime.directory, 'herdr'), { recursive: true });
    await writeFile(config, "# retain native customization\n[theme]\nname = 'nord' # user theme\n");
    const cwd = resolve(runtime.directory, 'new-terminal-directory'); await mkdir(cwd);
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.keyboard.press('Control+k'); await page.getByRole('button', { name: 'Host: runtime settings', exact: true }).click();
    await expect(page.locator('#runtime-settings-fields')).toBeEnabled();
    await page.locator('#runtime-new-cwd').fill(cwd);
    await page.locator('#runtime-scrollback').fill('123456');
    await page.locator('#runtime-resume').uncheck();
    await page.getByRole('button', { name: 'SAVE AND RELOAD', exact: true }).click();
    await expect(page.locator('#runtime-settings-result')).toContainText('[OK]');
    expect(await readFile(config, 'utf8')).toContain("name = 'nord' # user theme");
    const original = await readFile(config, 'utf8');
    await writeFile(config, original + '\n# concurrent editor change\n');
    await page.locator('#runtime-default-shell').fill('/bin/bash');
    await page.getByRole('button', { name: 'SAVE AND RELOAD', exact: true }).click();
    await expect(page.locator('#runtime-settings-error')).toContainText('Configuration changed');
    expect(await readFile(config, 'utf8')).toBe(original + '\n# concurrent editor change\n');
    await page.getByRole('button', { name: 'RELOAD SETTINGS', exact: true }).click();
    await expect(page.locator('#runtime-settings-fields')).toBeEnabled();
    await expect(page.locator('#runtime-resume')).not.toBeChecked();
    await page.screenshot({ path: 'test-results/runtime-settings-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#runtime-new-cwd')).toHaveValue(cwd);
    await page.screenshot({ path: 'test-results/runtime-settings-mobile.png' });
    await page.getByRole('button', { name: 'DONE', exact: true }).click();
    const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
    await runtime.cli('pane', 'send-text', pane, "printf 'CONFIG_CWD=%s\\n' \"$PWD\"\n");
    await expect.poll(() => runtime.cli('pane', 'read', pane)).toContain('CONFIG_CWD=' + cwd);
  } finally { await runtime.close(); }
});

test('runtime settings reject invalid input and report a saved file when reload fails', async ({ request }) => {
  test.skip(!process.env.WERDR_TERMINAL_CLIENT_BIN, 'Requires the configuration companion.');
  const runtime = await fixture();
  try {
    await request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    const state = await (await request.get(runtime.url + '/api/runtime-settings?machine=local')).json();
    const send = (settings: object, origin = runtime.url) => request.post(runtime.url + '/api/runtime-settings', { headers: { Origin: origin }, data: { machine: 'local', revision: state.revision, settings } });
    expect((await send(state.settings, 'https://untrusted.invalid')).status()).toBe(403);
    expect((await send({ ...state.settings, shell_mode: 'invalid' })).status()).toBe(409);
    expect((await (await request.get(runtime.url + '/api/runtime-settings?machine=local')).json()).revision).toBe(state.revision);
    await runtime.cli('server', 'stop');
    const response = await send({ ...state.settings, resume_agents_on_restore: false });
    expect(response.ok()).toBe(true);
    const saved = await response.json(); expect(saved.saved).toBe(true); expect(saved.reload.error.message).toBeTruthy();
    expect(saved.settings.resume_agents_on_restore).toBe(false);
    expect(await readFile(resolve(runtime.directory, 'herdr/config.toml'), 'utf8')).toContain('resume_agents_on_restore = false');
  } finally { await runtime.close(); }
});
