import { test, expect, type Page } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';
const focus = (page: Page) => page.locator('.pane-active .pane-content textarea').focus();
async function prefix(page: Page, suffix?: string, chord = 'Control+b') { await page.keyboard.press(chord); if (suffix) await page.keyboard.press(suffix); }
async function login(page: Page, runtime: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden(); await focus(page);
}
async function capture(page: Page, inputs: string[]) {
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.input') inputs.push(record.text); else server.send(message); });
  });
}
test('native prefix, resize, held-key leases and browser aliases control real panes', async ({ page }) => {
  test.setTimeout(120_000); const runtime = await fixture(); const inputs: string[] = [];
  try {
    await capture(page, inputs); await login(page, runtime);
    const originalInput = await page.locator('.pane-active .pane-content textarea').elementHandle();
    await prefix(page); await expect(page.locator('#shortcut-status')).toContainText('[PREFIX');
    await page.keyboard.press('f'); await expect(page.locator('#shortcut-status')).toBeHidden(); expect(inputs).toEqual([]);
    await prefix(page); await prefix(page); await expect.poll(() => inputs.join('')).toBe('\x02'); inputs.length = 0;
    await prefix(page, 'Shift+?'); await expect(page.locator('#shortcut-help')).toBeVisible();
    await expect(page.locator('#shortcut-help h1')).toBeInViewport(); await expect(page.locator('#shortcut-help')).toContainText('prefix+shift+n'); await page.screenshot({ path: 'test-results/shortcuts-help-desktop.png' });
    await page.locator('#shortcut-help button').click(); await expect(page.locator('.pane-active .pane-content textarea')).toBeFocused();
    expect(await originalInput!.evaluate(node => node.isConnected)).toBe(true);
    await prefix(page); await page.keyboard.down('v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await page.keyboard.down('v'); await page.keyboard.up('v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const before = await page.locator('.pane-active').boundingBox();
    await prefix(page, 'r'); await expect(page.locator('#shortcut-status')).toContainText('[RESIZE]');
    await page.keyboard.press('ArrowLeft'); await expect.poll(async () => (await page.locator('.pane-active').boundingBox())!.width).not.toBe(before!.width);
    await expect(page.locator('#shortcut-status')).toContainText('[RESIZE]'); await page.keyboard.press('Enter'); await expect(page.locator('#shortcut-status')).toBeHidden();
    await prefix(page); await page.locator('#panes > button.active').focus(); await expect(page.locator('#shortcut-status')).toBeHidden();
    await focus(page); await page.keyboard.press('v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); expect(inputs.at(-1)).toBe('v');
    await prefix(page); await page.locator('.pane-active .pane-content textarea').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', isComposing: true, bubbles: true, cancelable: true })));
    await expect(page.locator('#shortcut-status')).toBeHidden(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Resize mode'); await page.locator('#command-list button').click();
    await expect(page.locator('#shortcut-status')).toContainText('[RESIZE]'); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+d'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(3);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page); await prefix(page, 'c'); await expect(page.locator('#tabs button')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page); const second = new URL(page.url()).searchParams.get('tab');
    await prefix(page, '1'); await expect.poll(() => new URL(page.url()).searchParams.get('tab')).not.toBe(second);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page); await prefix(page, 'n'); await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe(second);
  } finally { await runtime.close(); }
});
test('copy controls, double prefix forwarding and editable text keep their input scope', async ({ page }) => {
  const runtime = await fixture(); const inputs: string[] = [];
  try {
    await capture(page, inputs); await login(page, runtime); const pane = new URL(page.url()).searchParams.get('pane')!;
    await runtime.cli('pane', 'send-text', pane, "for i in $(seq 1 100); do printf 'KEY_COPY_%s\\n' $i; done\n");
    await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('KEY_COPY_100');
    await prefix(page, '['); await expect(page.locator('.copy-layer')).toBeVisible(); await expect(page.locator('.copy-layer')).toHaveAttribute('data-row', /[0-9]+/); await page.keyboard.press('g'); await expect(page.locator('.copy-layer')).toHaveAttribute('data-row', '0');
    const before = await page.locator('.copy-layer').getAttribute('data-row'); await page.keyboard.press('Control+d');
    await expect(page.locator('.copy-layer')).not.toHaveAttribute('data-row', before!); await expect(page.locator('.terminal-pane')).toHaveCount(1);
    inputs.length = 0; await prefix(page); await prefix(page); await expect.poll(() => inputs.join('')).toBe('\x02'); await expect(page.locator('.copy-layer')).toBeVisible();
    await page.keyboard.press('/'); await page.locator('.copy-search input').fill('edited'); await page.keyboard.press('Control+b');
    await expect(page.locator('#shortcut-status')).toBeHidden(); await page.keyboard.press('Escape'); await page.keyboard.press('q');
    await expect(page.locator('.copy-layer')).toHaveCount(0); await focus(page); await prefix(page, 's'); await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.locator('#settings-keybindings summary').click(); await page.locator('#settings-prefix').focus(); await page.keyboard.press('Control+d'); await expect(page.locator('.terminal-pane')).toHaveCount(1);
    await page.locator('#settings-cancel').click();
  } finally { await runtime.close(); }
});
test('keybinding remaps persist through restart with validation, preview cancellation and responsive help', async ({ page }) => {
  test.setTimeout(120_000); const runtime = await fixture();
  try {
    await login(page, runtime); await prefix(page, 's'); await expect(page.locator('#settings-dialog')).toBeVisible(); await page.locator('#settings-keybindings summary').click();
    await page.locator('[data-shortcut=close_pane]').fill('x'); await expect(page.locator('#settings-error')).toContainText('intercept terminal typing');
    await page.locator('[data-shortcut=close_pane]').fill('prefix+x'); await page.locator('#settings-prefix').fill('ctrl+a');
    await page.locator('#settings-cancel').click(); await focus(page); await prefix(page); await expect(page.locator('#shortcut-status')).toContainText('ctrl+b'); await page.keyboard.press('Escape');
    await prefix(page, 's'); await page.locator('#settings-keybindings summary').click(); await page.locator('#settings-prefix').fill('ctrl+a'); await page.locator('[data-shortcut=help]').fill('prefix+f1');
    await page.locator('[data-shortcut=split_vertical]').fill('prefix+v'); await page.locator('#settings-form button[type=submit]').click(); await expect(page.locator('#settings-dialog')).toBeHidden();
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    await prefix(page, 'F1', 'Control+a'); await expect(page.locator('#shortcut-help')).toBeVisible(); await expect(page.locator('#shortcut-help')).toContainText('Prefix: ctrl+a');
    await expect(page.locator('#shortcut-help')).not.toContainText('Ctrl/Cmd+D');
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#shortcut-help h1')).toBeInViewport(); await page.screenshot({ path: 'test-results/shortcuts-help-mobile.png' });
    const bounds = await page.locator('#shortcut-help').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await runtime.close(); }
});

test('late layout replies preserve selection and held commands cannot type into a newly opened dialog', async ({ page }) => {
  test.setTimeout(90_000); const runtime = await fixture(); let release = () => {};
  try {
    await login(page, runtime); await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const source = new URL(page.url()).searchParams.get('pane')!;
    const other = await page.locator('#panes > button:not(.active)').getAttribute('data-id');
    let started = () => {}; const requestStarted = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON().action !== 'pane.resize') { await route.continue(); return; }
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    });
    await prefix(page, 'r'); await page.keyboard.press('ArrowLeft'); await requestStarted;
    await page.locator(`#panes > button[data-id="${other}"]`).click(); await expect(page.locator('#shortcut-status')).toBeHidden();
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/fleet') && response.request().method() === 'GET'); release(); await (await refreshed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(new URL(page.url()).searchParams.get('pane')).toBe(other); expect(other).not.toBe(source);
    await focus(page); await prefix(page); await page.keyboard.down('s'); await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.locator('#settings-keybindings summary').click(); await page.locator('#settings-prefix').focus();
    await page.keyboard.down('s'); await page.keyboard.up('s'); await expect(page.locator('#settings-prefix')).toHaveValue('ctrl+b');
    await page.locator('#settings-cancel').click();
    await runtime.cli('server', 'stop'); await page.locator('#refresh').click();
    await expect.poll(async () => (await (await page.request.get(runtime.url + '/api/fleet')).json()).hosts.find((host: any) => host.machine.id === 'local').connection).not.toBe('online');
    await page.locator('#panes').focus(); await page.keyboard.press('Control+k'); await expect(page.locator('#command-dialog')).toBeVisible();
    await page.locator('#command-search').fill('Keyboard shortcuts'); await page.locator('#command-list button').click();
    await expect(page.locator('#shortcut-help')).toBeVisible(); await expect(page.locator('#shortcut-help')).toContainText('Resize mode [UNAVAILABLE]');
  } finally { release(); await runtime.close(); }
});

test('moving a pane follows its destination after automatic native fallback but respects newer navigation and commands', async ({ page }) => {
  test.setTimeout(120_000); const runtime = await fixture(); let release = () => {};
  const run = async (label: string) => { await page.locator('#commands').click(); await page.locator('#command-list').getByRole('button', { name: label, exact: true }).click(); };
  try {
    await login(page, runtime); const first = new URL(page.url()).searchParams.get('pane')!;
    await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
    const originalWorkspace = new URL(page.url()).searchParams.get('workspace')!; let source = '';
    let started = () => {}; let waiting = new Promise<void>(resolve => { started = resolve; }); let gate = new Promise<void>(resolve => { release = resolve; });
    let delayedAction = 'pane.move';
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON().action !== delayedAction) { await route.continue(); return; }
      const response = await route.fetch();
      if (delayedAction === 'pane.move') source = (await response.json()).move_result.pane.pane_id;
      started(); await gate; await route.fulfill({ response });
    });
    await run('Move pane to new workspace'); await waiting;
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', first);
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(originalWorkspace);
    release(); await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', source);
    await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).not.toBe(originalWorkspace);
    await expect(page.locator('#shield')).toBeHidden(); await run('Move workspace earlier');
    await expect(page.locator('#workspaces button').first()).toHaveAttribute('data-id', 'local/' + new URL(page.url()).searchParams.get('workspace'));

    // An explicit round trip is newer intent even when the selected pane is the
    // same again by the time an older request returns.
    await focus(page); await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
    const latest = new URL(page.url()).searchParams.get('pane')!;
    waiting = new Promise<void>(resolve => { started = resolve; }); gate = new Promise<void>(resolve => { release = resolve; }); delayedAction = 'pane.focus_direction';
    await focus(page); await prefix(page, 'h'); await waiting;
    await page.locator(`#panes > button[data-id="${source}"]`).click(); await page.locator(`#panes > button[data-id="${latest}"]`).click();
    let refreshed = page.waitForResponse(response => response.url().endsWith('/api/fleet') && response.request().method() === 'GET'); release(); await (await refreshed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(new URL(page.url()).searchParams.get('pane')).toBe(latest);

    // A newer command also supersedes a delayed focus response without requiring
    // an intermediate local selection change.
    waiting = new Promise<void>(resolve => { started = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
    await focus(page); await prefix(page, 'h'); await waiting;
    await run('Zoom / restore pane'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    refreshed = page.waitForResponse(response => response.url().endsWith('/api/fleet') && response.request().method() === 'GET'); release(); await (await refreshed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(new URL(page.url()).searchParams.get('pane')).toBe(latest);
  } finally { release(); await runtime.close(); }
});

test('Navigate previews workspaces without terminal churn and confirms stable targets', async ({ page }) => {
  const runtime = await fixture(); const inputs: string[] = []; const actions: string[] = [];
  try {
    await capture(page, inputs); await login(page, runtime);
    const first = new URL(page.url()).searchParams.get('workspace');
    await prefix(page, 'Shift+N'); await expect(page.locator('#workspaces button[data-id]')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const second = new URL(page.url()).searchParams.get('workspace'); expect(second).not.toBe(first);
    const textarea = await page.locator('.pane-active .pane-content textarea').elementHandle(); const url = page.url();
    page.on('request', request => { if (request.url().endsWith('/api/action')) actions.push(request.postDataJSON().action); });
    await prefix(page, 'w'); await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#workspaces button.navigate-preview')).toHaveAttribute('data-id', new RegExp(`/${first}$`));
    expect(page.url()).toBe(url); expect(await textarea!.evaluate(node => node.isConnected)).toBe(true);
    expect(actions).toEqual([]); expect(inputs).toEqual([]);
    await page.keyboard.press('9'); await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    await page.keyboard.press('Escape'); await expect(page.locator('.navigate-preview')).toHaveCount(0); expect(page.url()).toBe(url);
    await prefix(page, 'w'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBe(first);
    await expect(page.locator('#shortcut-status')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    await prefix(page, 'w'); await page.keyboard.press('2');
    await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBe(second);
    expect(inputs).toEqual([]);
  } finally { await runtime.close(); }
});

test('Navigate pane focus retains workspace preview and rename targets the preview', async ({ page }) => {
  const runtime = await fixture();
  try {
    await login(page, runtime); const first = new URL(page.url()).searchParams.get('workspace');
    await prefix(page, 'Shift+N'); await expect(page.locator('#workspaces button[data-id]')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const second = new URL(page.url()).searchParams.get('workspace'), pane = new URL(page.url()).searchParams.get('pane');
    await prefix(page, 'w'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('h');
    await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(pane);
    await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    await expect(page.locator('#workspaces button.navigate-preview')).toHaveAttribute('data-id', new RegExp(`/${first}$`));
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(second);
    const rename = page.waitForRequest(request => request.url().endsWith('/api/action') && request.postDataJSON().action === 'workspace.rename');
    await page.keyboard.press('Shift+W');
    await page.locator('#rename-value').fill('Preview renamed');
    await page.locator('#rename-form button[type=submit]').click();
    expect((await rename).postDataJSON().id).toBe(first);
    await expect(page.locator('#shortcut-status')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(second);
  } finally { await runtime.close(); }
});

test('Navigate cancellation restores copy while confirming the same workspace exits copy', async ({ page }) => {
  const runtime = await fixture();
  try {
    await login(page, runtime);
    await prefix(page, '['); await expect(page.locator('.copy-layer')).toBeVisible();
    await prefix(page, 'w'); await page.keyboard.press('Escape'); await expect(page.locator('.copy-layer')).toBeVisible();
    await prefix(page, 'w'); await page.keyboard.press('Enter'); await expect(page.locator('.copy-layer')).toHaveCount(0);
    await focus(page); await prefix(page, '['); await expect(page.locator('.copy-layer')).toBeVisible();
    await prefix(page, 'w'); await page.keyboard.press('1'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  } finally { await runtime.close(); }
});

test('mobile Navigate switches workspaces and tabs, keeps terminals mounted, and suspends for menus', async ({ page }) => {
  const runtime = await fixture(); const inputs: string[] = [];
  try {
    await capture(page, inputs); await login(page, runtime);
    const first = new URL(page.url()).searchParams.get('workspace');
    await prefix(page, 'Shift+N'); await expect(page.locator('#workspaces button[data-id]')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const second = new URL(page.url()).searchParams.get('workspace');
    await prefix(page, 'c'); await expect(page.locator('#tabs button')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page);
    const activeTab = new URL(page.url()).searchParams.get('tab');
    const textarea = await page.locator('.pane-active .pane-content textarea').elementHandle();
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#navigate-toggle').click();
    const switcher = page.locator('#navigate-switcher'); await expect(switcher).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('inert', '');
    expect(await textarea!.evaluate(node => node.isConnected)).toBe(true);
    await expect(switcher.locator('[data-section=workspaces] button')).toHaveCount(3);
    await expect(switcher.locator('[data-section=tabs] button')).toHaveCount(3);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect(switcher.locator('.navigate-preview')).toHaveAttribute('data-id', new RegExp(`/${first}$`));
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(second);
    expect(inputs).toEqual([]);
    await page.screenshot({ path: 'test-results/navigate-switcher-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await switcher.getByRole('button', { name: 'KEYBOARD SHORTCUTS', exact: true }).click();
    await expect(switcher).toBeHidden(); await expect(page.locator('#shortcut-help')).toBeVisible();
    await expect(page.locator('#app')).not.toHaveAttribute('inert', ''); await page.locator('#shortcut-help button').click();
    await page.locator('#navigate-toggle').click();
    await switcher.locator('[data-section=tabs] button').nth(1).click();
    await expect(switcher).toBeHidden(); await expect.poll(() => new URL(page.url()).searchParams.get('tab')).not.toBe(activeTab);
    await expect(page.locator('#shield')).toBeHidden(); await page.locator('#navigate-toggle').click();
    await switcher.locator('[data-section=workspaces] button').nth(1).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBe(first);
    await expect(switcher).toBeHidden(); await page.locator('#navigate-toggle').click();
    await switcher.getByRole('button', { name: '[+] NEW TAB', exact: true }).click();
    await expect(switcher).toBeHidden(); await expect(page.locator('#tabs button')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await page.locator('#navigate-toggle').click();
    await switcher.getByRole('button', { name: '[X] CLOSE', exact: true }).click();
    await expect(switcher).toBeHidden(); await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
  } finally { await runtime.close(); }
});

test('mobile Navigate retains unavailable hosts, isolates scroll, and follows native agent targets', async ({ page }) => {
  const runtime = await fixture(); const inputs: string[] = [];
  try {
    const { mkdir, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
    const catalog = join(runtime.directory, 'state/herdr/client'); await mkdir(catalog, { recursive: true });
    await writeFile(join(catalog, 'endpoints.json'), JSON.stringify({ version: 1, ssh: [{ id: 'a'.repeat(32), label: 'Unavailable host', target: '127.0.0.1', session: 'unavailable', enabled: false }] }), { mode: 0o600 });
    await capture(page, inputs); await login(page, runtime);
    const original = new URL(page.url()).searchParams.get('pane');
    const agent = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await runtime.cli('pane', 'report-agent', agent.pane_id, '--source', 'werdr-navigate-test', '--agent', 'Claude', '--state', 'working', '--seq', '1');
    await expect(page.locator('#agents button')).toHaveCount(1); await expect(page.locator('#hosts button')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 540 }); await page.locator('#navigate-toggle').click();
    const switcher = page.locator('#navigate-switcher'); await expect(switcher).toBeVisible();
    const unavailable = switcher.getByRole('button', { name: 'Unavailable host', exact: true });
    await expect(unavailable).toHaveAttribute('aria-disabled', 'true');
    // Unavailable rows remain inspectable and report why they cannot activate.
    await unavailable.click({ force: true }); await expect(switcher.locator('.switcher-notice')).toContainText('not ready');
    expect(new URL(page.url()).searchParams.get('pane')).toBe(original); await expect(switcher).toBeVisible();
    await switcher.locator('.switcher-content').hover(); await page.mouse.wheel(0, 700);
    await expect.poll(() => switcher.locator('.switcher-content').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(inputs).toEqual([]); expect(new URL(page.url()).searchParams.get('pane')).toBe(original);
    await switcher.locator('[data-section=agents] button').click();
    await expect(switcher).toBeHidden(); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(agent.pane_id);
    await expect(page.locator('#shield')).toBeHidden(); expect(inputs).toEqual([]);
    await page.locator('#navigate-toggle').click(); await page.keyboard.press('Escape');
    await expect(page.locator('.pane-active .pane-content textarea')).toBeFocused();
    await page.keyboard.type('x'); await expect.poll(() => inputs.join('')).toBe('x');
    await page.locator('#navigate-toggle').click(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(switcher).toBeHidden(); await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    await expect(page.locator('.pane-active .pane-content textarea')).toBeFocused();
    await page.keyboard.press('Escape'); await page.keyboard.type('y'); await expect.poll(() => inputs.join('')).toBe('xy');
  } finally { await runtime.close(); }
});

test('mobile empty switcher returns after dismissing settings or keyboard help', async ({ page }) => {
  const runtime = await fixture();
  try {
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#navigate-toggle').click();
    const switcher = page.locator('#navigate-switcher'); await expect(switcher).toBeVisible();
    await switcher.getByRole('button', { name: 'KEYBOARD SHORTCUTS', exact: true }).click();
    await expect(page.locator('#shortcut-help')).toBeVisible(); await expect(switcher).toBeHidden();
    await page.locator('#shortcut-help button').click(); await expect(switcher).toBeVisible();
    await switcher.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(page.locator('#settings-dialog')).toBeVisible(); await page.locator('#settings-cancel').click();
    await expect(switcher).toBeVisible();
    await switcher.getByRole('button', { name: '[+] NEW WORKSPACE', exact: true }).click();
    await expect(switcher).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('workspace')).toBeTruthy();
  } finally { await runtime.close(); }
});

test('Navigate survives the expected attachment of a previously hidden pane', async ({ page }) => {
  const runtime = await fixture(); const queued: (() => void)[] = []; let hold = true;
  try {
    await login(page, runtime); const left = new URL(page.url()).searchParams.get('pane')!;
    await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await expect(page.locator('#shield')).toBeHidden(); await focus(page); await prefix(page, 'z');
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
    await page.routeWebSocket('**/ws/terminal?*', socket => {
      const server = socket.connectToServer();
      if (new URL(socket.url()).searchParams.get('pane') !== left) return;
      server.onMessage(message => { if (hold) queued.push(() => socket.send(message)); else socket.send(message); });
    });
    await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
    await expect(page.locator('.terminal-pane')).toHaveCount(1); await focus(page);
    await prefix(page, 'w'); await page.keyboard.press('h');
    await expect.poll(() => queued.length).toBeGreaterThan(0);
    await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    hold = false; for (const release of queued.splice(0)) release();
    await expect(page.locator('#shield')).toBeHidden();
    await expect(page.locator('.pane-active')).toHaveAttribute('data-pane', left);
    await expect(page.locator('#shortcut-status')).toContainText('[NAVIGATE]');
    await page.keyboard.press('Escape'); await expect(page.locator('#shortcut-status')).toBeHidden();
  } finally { hold = false; for (const release of queued.splice(0)) release(); await runtime.close(); }
});

test('last-pane binding toggles scoped selections and clears uncertain reconnect history', async ({ page }) => {
  test.setTimeout(120_000); const runtime = await fixture(); const inputs: string[] = [];
  let observedGeneration = '';
  page.on('websocket', socket => { if (socket.url().endsWith('/ws/fleet')) socket.on('framereceived', frame => {
    const event = JSON.parse(String(frame.payload)); if (event.type === 'fleet.snapshot') observedGeneration = event.state.generation;
  }); });
  const selected = () => new URL(page.url()).searchParams.get('pane');
  const last = async () => { await expect(page.locator('#shield')).toBeHidden(); await focus(page); await prefix(page, 'F2'); };
  try {
    await capture(page, inputs); await login(page, runtime);
    const first = selected();
    await prefix(page, 's'); await page.locator('#settings-keybindings summary').click();
    await expect(page.locator('[data-shortcut=last_pane]')).toHaveValue('');
    await page.locator('[data-shortcut=last_pane]').fill('prefix+f2');
    await page.locator('#settings-form button[type=submit]').click(); await expect(page.locator('#settings-dialog')).toBeHidden();
    await last(); expect(selected()).toBe(first);
    await prefix(page, 'v'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
    await expect.poll(selected).not.toBe(first); const second = selected();
    const firstInput = await page.locator(`.terminal-pane[data-pane="${first}"] textarea`).elementHandle();
    await last(); await expect.poll(selected).toBe(first);
    await last(); await expect.poll(selected).toBe(second);
    expect(await firstInput!.evaluate(node => node.isConnected)).toBe(true);
    await prefix(page, 'c'); await expect(page.locator('#tabs button')).toHaveCount(2);
    await expect.poll(selected).not.toBe(second); const third = selected();
    await last(); await expect.poll(selected).toBe(second);
    await last(); await expect.poll(selected).toBe(third);
    await prefix(page, 'Shift+n'); await expect(page.locator('#workspaces button')).toHaveCount(2);
    await expect.poll(selected).not.toBe(third); const fourth = selected();
    await last(); await expect.poll(selected).toBe(third);
    await last(); await expect.poll(selected).toBe(fourth);
    // Preview never becomes history; cancellation retains the previous actual pane.
    await prefix(page, 'w'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
    await last(); await expect.poll(selected).toBe(third);
    await runtime.cli('pane', 'close', fourth!);
    await expect(page.locator('#workspaces button')).toHaveCount(1);
    await last(); expect(selected()).toBe(third);
    await prefix(page, '1'); await expect.poll(selected).not.toBe(third);
    const beforeReconnect = selected(); await last(); await expect.poll(selected).toBe(third);
    const previousGeneration = observedGeneration; await runtime.restartGateway();
    await expect.poll(() => observedGeneration).not.toBe(previousGeneration);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#hosts button').first()).toHaveAttribute('data-badge', 'ONLINE');
    await expect(page.locator('#shield')).toBeHidden();
    await last(); expect(selected()).toBe(third); expect(selected()).not.toBe(beforeReconnect);
    // A host without metadata must clear history before choose() can reconcile a pane.
    await prefix(page, '1'); await expect.poll(selected).not.toBe(third);
    await last(); await expect.poll(selected).toBe(third);
    const { mkdir, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
    const catalog = join(runtime.directory, 'state/herdr/client'); await mkdir(catalog, { recursive: true });
    await writeFile(join(catalog, 'endpoints.json'), JSON.stringify({ version: 1, ssh: [{ id: 'a'.repeat(32), label: 'Unloaded host', target: '127.0.0.1', session: 'last-pane-unavailable', enabled: true }] }), { mode: 0o600 });
    const unloaded = page.locator('#hosts button').filter({ hasText: 'Unloaded host' });
    await unloaded.click(); await expect(unloaded).toHaveClass(/active/);
    await page.locator('#hosts button').first().click(); await expect(page.locator('#shield')).toBeHidden();
    await last(); expect(selected()).toBe(third);
    expect(inputs).toEqual([]);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('Last pane');
    await expect(page.locator('#command-list button').filter({ hasText: 'Last pane' })).toBeDisabled();
  } finally { await runtime.close(); }
});
