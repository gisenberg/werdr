import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>, directory: string;
test.beforeAll(async () => {
  runtime = await fixture(); directory = join(runtime.directory, 'test plugin'); await mkdir(directory);
  const action = join(directory, 'context.py'), pane = join(directory, 'pane.py');
  await writeFile(action, 'import os\nprint(os.environ["HERDR_PLUGIN_CONTEXT_JSON"], flush=True)\n');
  await writeFile(pane, 'import sys\nprint("PLUGIN_READY", flush=True)\nfor line in sys.stdin:\n print("PLUGIN_ECHO:" + line.strip(), flush=True)\n if line.strip() == "exit": break\n');
  await writeFile(join(directory, 'herdr-plugin.toml'), `id = "example.browser-test"\nname = "Browser Plugin"\nversion = "0.1.0"\nmin_herdr_version = "0.7.0"\nplatforms = ["linux", "macos", "windows"]\n[[actions]]\nid = "context"\ntitle = "Inspect context"\ncontexts = ["pane"]\ncommand = ["python3", ${JSON.stringify(action)}]\n[[actions]]\nid = "fail"\ntitle = "Fail visibly"\ncontexts = ["global"]\ncommand = ["python3", "-c", "import sys; print('fixture-error', file=sys.stderr); sys.exit(7)"]\n[[panes]]\nid = "board"\ntitle = "Plugin Board"\nplacement = "overlay"\ncommand = ["python3", ${JSON.stringify(pane)}]\n[[panes]]\nid = "popup"\ntitle = "Popup Board"\nplacement = "popup"\ncommand = ["python3", ${JSON.stringify(pane)}]\n`);
});
test.afterAll(async () => { await runtime?.close(); });
async function login(page: import('@playwright/test').Page) { await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden(); }
async function create(page: import('@playwright/test').Page) { const previous = new URL(page.url()).searchParams.get('pane'); await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden(); }
async function open(page: import('@playwright/test').Page) { await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Plugins: management, actions, panes and logs', exact: true }).click(); await expect(page.locator('#plugin-refresh')).toBeEnabled(); }

test('native plugin management preserves files, supplies the selected context and shows command outcomes', async ({ page }) => {
  test.setTimeout(90000); await login(page);
  await create(page);
  const selected = Object.fromEntries(new URL(page.url()).searchParams);
  await page.locator('.pane-active textarea').focus(); await page.keyboard.type("printf '\\033[2J\\033[HSELECT_%s\\n' PLUGIN_CONTEXT"); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', selected.pane, '--source', 'recent')).toContain('SELECT_PLUGIN_CONTEXT');
  const response = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'workspace.create', label: 'Other native focus' } });
  const other = (await response.json()).root_pane; await runtime.cli('workspace', 'focus', other.workspace_id);
  const canvas = await page.locator('.pane-active canvas').first().boundingBox(); await page.mouse.dblclick(canvas!.x + 12, canvas!.y + 8);
  await open(page); await expect(page.locator('#plugin-context')).toContainText('TEXT SELECTED'); await page.locator('#plugin-link-details summary').click(); await page.locator('#plugin-link-path').fill(directory); await page.locator('#plugin-link-form button[type=submit]').click();
  const plugin = page.locator('.plugin-row[data-plugin="example.browser-test"]'); await expect(plugin).toContainText('[ENABLED]');
  await plugin.getByRole('button', { name: 'RUN Inspect context', exact: true }).click();
  await expect(page.locator('#plugin-logs summary').filter({ hasText: 'context' })).toContainText('[SUCCEEDED]');
  const logs = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'plugin.log.list' } });
  const context = JSON.parse((await logs.json()).logs.find((log: any) => log.action_id === 'context').stdout);
  expect(context.focused_pane_id).toBe(selected.pane); expect(context.workspace_id).toBe(selected.workspace); expect(context.tab_id).toBe(selected.tab); expect(context.invocation_source).toBe('browser'); expect(context.selected_text).toContain('SELECT_PLUGIN_CONTEXT');
  await plugin.getByRole('button', { name: 'RUN Fail visibly', exact: true }).click();
  const failed = page.locator('#plugin-logs details').filter({ hasText: 'fixture-error' }); await expect(failed).toContainText('[FAILED]'); await expect(failed).toContainText('EXIT 7');
  await plugin.getByRole('button', { name: 'DISABLE', exact: true }).click(); await expect(plugin).toContainText('[DISABLED]'); await expect(plugin.getByRole('button', { name: 'RUN Inspect context' })).toBeDisabled();
  const rejected = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'plugin.action.invoke', plugin_id: 'example.browser-test', action_id: 'context', pane_id: selected.pane } }); expect(rejected.ok()).toBe(false);
  await plugin.getByRole('button', { name: 'ENABLE', exact: true }).click(); await expect(plugin).toContainText('[ENABLED]');
  await page.screenshot({ path: 'test-results/plugins-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/plugins-mobile.png' });
  await page.locator('#plugin-done').click(); await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await open(page); await expect(plugin).toContainText('[ENABLED]');
  page.once('dialog', dialog => dialog.accept()); await plugin.getByRole('button', { name: 'UNLINK', exact: true }).click(); await expect(plugin).toHaveCount(0);
  expect(await readFile(join(directory, 'herdr-plugin.toml'), 'utf8')).toContain('example.browser-test');
  await page.locator('#plugin-link-details summary').click(); await page.locator('#plugin-link-path').fill(join(directory, 'not-found')); await page.locator('#plugin-link-form button[type=submit]').click(); await expect(page.locator('#plugin-error')).not.toBeEmpty(); await expect(page.locator('.plugin-row')).toHaveCount(0);
});

test('plugin overlay, split, zoomed and tab panes retain native input and restore the original layout', async ({ page }) => {
  test.setTimeout(120000);
  await runtime.cli('plugin', 'link', directory); await login(page);
  await create(page);
  const root = new URL(page.url()).searchParams.get('pane')!, workspace = new URL(page.url()).searchParams.get('workspace')!;
  let original = await page.locator('.pane-active textarea').elementHandle();
  for (const placement of ['overlay', 'split', 'zoomed', 'tab']) {
    await open(page); const entry = page.locator('.plugin-entry[data-entrypoint=board]'); await entry.getByLabel('Plugin Board placement', { exact: true }).selectOption(placement); await entry.getByRole('button', { name: 'OPEN Plugin Board', exact: true }).click();
    await expect(page.locator('#plugins-dialog')).not.toBeVisible(); await expect(page.locator('#shield')).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(root);
    const id = new URL(page.url()).searchParams.get('pane')!; await expect(page.locator('.pane-active textarea')).toBeFocused();
    if (placement === 'split') await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); else await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    if (placement !== 'tab') expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await page.locator('.pane-active textarea').focus(); await page.keyboard.type(`INPUT_${placement}`); await page.keyboard.press('Enter'); await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain(`PLUGIN_ECHO:INPUT_${placement}`);
    if (placement === 'split') { await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden(); original = await page.locator(`.terminal-pane[data-pane=\"${root}\"] textarea`).elementHandle(); }
    await open(page); await page.locator('#plugin-focus-pane').click(); await expect(page.locator('#plugins-dialog')).not.toBeVisible();
    await open(page); page.once('dialog', dialog => dialog.accept()); await page.locator('#plugin-close-pane').click();
    await expect.poll(async () => JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.some((pane: any) => pane.pane_id === id)).toBe(false);
    await expect(page.locator('#plugins-dialog')).not.toBeVisible(); await expect(page.locator('#shield')).toBeHidden();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(1); expect(new URL(page.url()).searchParams.get('pane')).toBe(root);
  }
  await open(page); const popup = page.locator('.plugin-entry[data-entrypoint=popup]'); await expect(popup.getByRole('button', { name: 'OPEN Popup Board' })).toBeDisabled();
  const before = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.length;
  const rejected = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'plugin.pane.open', plugin_id: 'example.browser-test', entrypoint: 'popup', pane_id: root, workspace_id: workspace } }); expect(rejected.ok()).toBe(false);
  expect(JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.length).toBe(before);
});

test('an open command palette follows native readiness without losing the search query', async ({ page }) => {
  let hold = false;
  const pending: (() => void)[] = [];
  await page.routeWebSocket('**/ws/fleet', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => { if (hold) pending.push(() => socket.send(message)); else socket.send(message); });
  });
  let baseline: unknown;
  await page.route('**/api/fleet', route => hold ? route.fulfill({ json: baseline }) : route.continue());
  await login(page); baseline = await (await page.request.get(runtime.url + '/api/fleet')).json(); hold = true;
  const created = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'workspace.create');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const pane = (await (await created).json()).root_pane;
  await expect(page.locator('#shield')).toContainText('Waiting for native workspace update');
  await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Plugins');
  const command = page.locator('#command-list').getByRole('button', { name: 'Plugins: management, actions, panes and logs', exact: true }); await expect(command).toBeDisabled();
  hold = false; for (const send of pending.splice(0)) send();
  await expect(command).toBeEnabled(); await expect(page.locator('#command-search')).toHaveValue('Plugins'); await expect(page.locator('#command-search')).toBeFocused();
  await command.click(); await expect(page.locator('#plugin-context')).toContainText(pane.pane_id);
});

test('exiting an overlay restores native focus to the previous split without remounting its terminals', async ({ page }) => {
  await runtime.cli('plugin', 'link', directory);
  await login(page); await create(page);
  const first = new URL(page.url()).searchParams.get('pane');
  await page.keyboard.press('Control+d'); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(first);
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  const source = new URL(page.url()).searchParams.get('pane')!;
  const retained = await page.locator('.terminal-pane textarea').elementHandles();
  await open(page); await page.locator('.plugin-entry[data-entrypoint=board]').getByRole('button', { name: 'OPEN Plugin Board', exact: true }).click();
  await expect(page.locator('#plugins-dialog')).not.toBeVisible(); await expect(page.locator('#shield')).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(source);
  const overlay = new URL(page.url()).searchParams.get('pane')!;
  await expect(page.locator('.pane-active')).toHaveCount(1); await expect(page.locator('.pane-active textarea')).toBeFocused();
  await page.locator('.pane-active textarea').focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(source); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  await expect(page.locator('.pane-active textarea')).toBeFocused();
  expect(await Promise.all(retained.map(node => node.evaluate(element => element.isConnected)))).toEqual([true, true]);
});
