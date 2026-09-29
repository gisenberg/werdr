import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
const exec = promisify(execFile), pluginId = 'example.browser-installed';
let runtime: Awaited<ReturnType<typeof fixture>>, repo: string, commit: string, failCommit: string, marker: string;
const source = 'werdr-fixture/catalog/plugin dir';
const manifest = (fail = false) => `id = "${pluginId}"\nname = "Installed Browser Plugin"\nversion = "${fail ? '0.2.0' : '0.1.0'}"\nmin_herdr_version = "0.7.0"\n[[build]]\ncommand = ["python3", "-c", ${JSON.stringify(fail ? "import sys; print('INSTALL_BUILD_FAILED'); sys.exit(7)" : `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('built'); print('INSTALL_BUILD_OK')`)}]\n[[actions]]\nid = "hello"\ntitle = "Hello installed"\ncommand = ["python3", "-c", "print('INSTALLED_ACTION_OK')"]\n`;
test.beforeAll(async () => {
  runtime = await fixture(); repo = join(runtime.directory, 'git-source'); marker = join(runtime.directory, 'built.txt');
  await mkdir(join(repo, 'plugin dir'), { recursive: true });
  await exec('git', ['init', repo]);
  await writeFile(join(repo, 'plugin dir/herdr-plugin.toml'), manifest());
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Install fixture'); commit = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'plugin dir/herdr-plugin.toml'), manifest(true)); await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Failing build'); failCommit = await git('rev-parse', 'HEAD');
  await mkdir(join(runtime.directory, 'git'));
  await writeFile(join(runtime.directory, 'git/config'), `[url "${pathToFileURL(repo).href}"]\n insteadOf = https://github.com/werdr-fixture/catalog.git\n`);
});
test.afterAll(async () => { await runtime?.close(); });
async function login(page: Page) { await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden(); }
async function open(page: Page) { await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Plugins: management, actions, panes and logs', exact: true }).click(); await expect(page.locator('#plugin-refresh')).toBeEnabled(); }
async function begin(page: Page, ref = commit) {
  await page.locator('#plugin-install-details').evaluate((node: HTMLDetailsElement) => { node.open = true; });
  await page.locator('#plugin-install-source').fill(source); await page.locator('#plugin-install-ref').fill(ref);
  await page.getByRole('button', { name: 'REVIEW INSTALLATION', exact: true }).click();
  await expect(page.locator('#plugin-install-dialog')).toBeVisible(); await expect(page.locator('#plugin-install-output')).toContainText('Install this plugin?');
}
async function answer(page: Page, value: string) { await page.locator('#plugin-install-input').fill(value); await page.locator('#plugin-install-input-form button').click(); }
async function plugins() { return JSON.parse(await runtime.cli('plugin', 'list', '--json')).result.plugins; }

test('native GitHub preview, decline, install, action, failed replacement and uninstall preserve native provenance and user data', async ({ page, browser }) => {
  test.setTimeout(120000); await login(page);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  let pane = await page.locator('.pane-active textarea').elementHandle();
  await open(page); await begin(page);
  await expect(page.locator('#plugin-install-output')).toContainText(commit); await expect(page.locator('#plugin-install-output')).toContainText('INSTALL_BUILD_OK');
  expect(await access(marker).then(() => true, () => false)).toBe(false); expect(await plugins()).toEqual([]);
  const jobs = await (await page.request.get(runtime.url + '/api/plugins/jobs?machine=local')).json(), id = jobs.jobs[0].id;
  const second = await browser.newContext(), other = await second.newPage(); await login(other);
  expect((await other.request.get(runtime.url + '/api/plugins/job?id=' + id)).status()).toBe(404);
  expect((await other.request.post(runtime.url + '/api/plugins/input', { headers: { Origin: runtime.url }, data: { id, input: 'y' } })).status()).toBe(404);
  const concurrent = await other.request.post(runtime.url + '/api/plugins/install', { headers: { Origin: runtime.url }, data: { machine: 'local', operation: 'install', source, ref: commit } }); expect(concurrent.status()).toBe(409);
  expect((await page.request.post(runtime.url + '/api/plugins/input', { headers: { Origin: 'https://foreign.invalid' }, data: { id, input: 'y' } })).status()).toBe(403);
  await second.close();
  await answer(page, 'n'); await expect(page.locator('#plugin-install-status')).toContainText('[FINISHED]'); await expect(page.locator('#plugin-install-output')).toContainText('cancelled');
  expect(await plugins()).toEqual([]); expect(await access(marker).then(() => true, () => false)).toBe(false);
  await page.locator('#plugin-install-done').click(); await begin(page);
  await page.locator('#plugin-install-done').click(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); pane = await page.locator('.pane-active textarea').elementHandle(); await open(page);
  await page.locator('#plugin-install-jobs').getByRole('button', { name: `[RUNNING] INSTALL ${source}`, exact: true }).click();
  await answer(page, 'y'); await expect(page.locator('#plugin-install-status')).toContainText('[FINISHED]'); await expect(page.locator('#plugin-install-output')).toContainText(`Installed ${pluginId}`);
  expect(await readFile(marker, 'utf8')).toBe('built'); const installed = (await plugins())[0]; expect(installed.source.kind).toBe('github'); expect(installed.source.resolved_commit).toBe(commit);
  const config = join(runtime.directory, 'herdr/plugins/config', pluginId); await mkdir(config, { recursive: true }); await writeFile(join(config, 'keep.txt'), 'user config');
  await page.locator('#plugin-install-done').click(); const row = page.locator(`.plugin-row[data-plugin="${pluginId}"]`); await expect(row).toContainText('v0.1.0');
  await row.getByRole('button', { name: 'RUN Hello installed', exact: true }).click(); await expect(page.locator('#plugin-logs summary')).toContainText('[SUCCEEDED]');
  await begin(page, failCommit); await answer(page, 'y'); await expect(page.locator('#plugin-install-status')).toContainText('[FAILED]'); await expect(page.locator('#plugin-install-output')).toContainText('INSTALL_BUILD_FAILED');
  expect((await plugins())[0].source.resolved_commit).toBe(commit); expect(await readFile(installed.manifest_path, 'utf8')).toContain('0.1.0');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/plugin-install-mobile.png' });
  await page.locator('#plugin-install-done').click(); await page.setViewportSize({ width: 1440, height: 900 });
  await begin(page); await page.screenshot({ path: 'test-results/plugin-install-desktop.png' }); await page.locator('#plugin-install-cancel').click(); await expect(page.locator('#plugin-install-status')).toContainText('[CANCELLED]');
  await page.locator('#plugin-install-done').click(); page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'UNINSTALL', exact: true }).click();
  await expect(page.locator('#plugin-install-status')).toContainText('[FINISHED]'); expect(await plugins()).toEqual([]); expect(await access(installed.manifest_path).then(() => true, () => false)).toBe(false); expect(await readFile(join(config, 'keep.txt'), 'utf8')).toBe('user config');
  await page.locator('#plugin-install-done').click(); await expect(row).toHaveCount(0); await page.locator('#plugin-done').click(); await expect(page.locator('#shield')).toBeHidden();
  expect(await pane!.evaluate(node => node.isConnected)).toBe(true);
  await page.locator('.pane-active textarea').focus(); await page.keyboard.type("printf 'INSTALL_SHELL_OK\\n'"); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', new URL(page.url()).searchParams.get('pane')!, '--source', 'recent')).toContain('INSTALL_SHELL_OK');
});

test('revoking the owning browser and restarting the gateway stop pending installers without installing code or ending panes', async ({ page, browser }) => {
  test.setTimeout(60000); await login(page);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  const pane = new URL(page.url()).searchParams.get('pane')!;
  await open(page); await begin(page);
  const before = (await (await page.request.get(runtime.url + '/api/plugins/jobs?machine=local')).json()).jobs;
  const job = before.find((job: any) => job.state === 'running'); expect(job).toBeTruthy();
  await page.request.post(runtime.url + '/api/logout', { headers: { Origin: runtime.url }, data: {} });
  const next = await browser.newContext(), nextPage = await next.newPage(); await login(nextPage); await open(nextPage);
  // The per-host lock remains held until the old child really exits.
  await expect.poll(async () => (await nextPage.request.post(runtime.url + '/api/plugins/install', { headers: { Origin: runtime.url }, data: { machine: 'local', operation: 'install', source, ref: commit } })).status()).toBe(200);
  const jobs = (await (await nextPage.request.get(runtime.url + '/api/plugins/jobs?machine=local')).json()).jobs;
  const pending = jobs.find((job: any) => job.state === 'running'); expect(pending).toBeTruthy();
  await expect.poll(async () => (await (await nextPage.request.get(runtime.url + '/api/plugins/job?id=' + pending.id)).json()).job.output).toContain('Install this plugin?');
  await runtime.restartGateway();
  expect(await plugins()).toEqual([]); expect(await runtime.cli('pane', 'read', pane, '--source', 'recent')).toBeDefined();
  await nextPage.reload(); await expect(nextPage.locator('#boot')).toBeHidden(); await open(nextPage);
  await begin(nextPage); await answer(nextPage, 'n'); await expect(nextPage.locator('#plugin-install-status')).toContainText('[FINISHED]');
  await next.close();
});


test('the published verification fixture loads natively and runs only its fixed platform action', async ({ page }) => {
  await runtime.cli('plugin', 'link', resolve('test/fixtures/github-install'));
  try {
    await login(page); await open(page);
    const row = page.locator('.plugin-row[data-plugin="werdr.verification.github-install"]');
    await expect(row).toContainText('[ENABLED]');
    await row.getByRole('button', { name: 'RUN Verify POSIX installer', exact: true }).click();
    await expect(page.locator('#plugin-logs summary').filter({ hasText: 'posix' })).toContainText('[SUCCEEDED]');
    const response = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'plugin.log.list', plugin_id: 'werdr.verification.github-install' } });
    expect((await response.json()).logs[0].stdout.trim()).toBe('WERDR_GITHUB_INSTALL_OK');
  } finally { await runtime.cli('plugin', 'unlink', 'werdr.verification.github-install'); }
});
