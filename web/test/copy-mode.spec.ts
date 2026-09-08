import { test, expect, type Page } from '@playwright/test';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });
async function login(page: Page) { await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden(); }
async function create(page: Page) { const previous = new URL(page.url()).searchParams.get('pane'); await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden(); return new URL(page.url()).searchParams.get('pane')!; }
async function open(page: Page, search = false) {
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: search ? 'Terminal: search native scrollback' : 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect(page.locator('#panes .copy-status')).toContainText(/COPY \d+:/);
}
async function find(page: Page, query: string) { await page.locator('#panes .copy-search input').fill(query); await page.locator('#panes .copy-search').getByRole('button', { name: 'FIND', exact: true }).click(); }

test('copy mode searches native history without resizing, copies Unicode and restores the original scroll position', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await login(page); const id = await create(page);
  await runtime.cli('pane', 'send-text', id, "for i in $(seq 1 200); do printf 'BROWSER_COPY_%03d 東京\\n' \"$i\"; done\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('BROWSER_COPY_200');
  const dimensions = await page.locator('.pane-active canvas').first().boundingBox();
  await open(page, true); expect(await page.locator('.pane-active canvas').first().boundingBox()).toEqual(dimensions);
  await find(page, 'BROWSER_COPY_001 東京');
  await expect(page.locator('.copy-status')).toContainText('1/1'); await expect(page.locator('.copy-current')).not.toHaveCount(0);
  await expect.poll(async () => (await (await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'pane.copy_context', id } })).json()).scroll?.offset_from_bottom).toBeGreaterThan(100);
  await page.screenshot({ path: 'test-results/copy-mode-desktop.png' });
  await page.locator('.copy-layer').focus(); await page.keyboard.press('y'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('BROWSER_COPY_001 東京');
  await expect.poll(async () => (await (await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'pane.copy_context', id } })).json()).scroll?.offset_from_bottom).toBe(0);
  await expect(page.locator('.pane-active textarea')).toBeFocused();
  await open(page, true); await find(page, 'BROWSER_COPY_'); await expect(page.locator('.copy-status')).toContainText('/201');
  const before = await page.locator('.copy-layer').getAttribute('data-row'); await page.keyboard.press('n'); await expect(page.locator('.copy-layer')).not.toHaveAttribute('data-row', before!); await page.keyboard.press('N'); await expect(page.locator('.copy-layer')).toHaveAttribute('data-row', before!);
  await page.keyboard.press('Escape'); await page.keyboard.press('g'); await page.keyboard.press('Home'); await page.keyboard.press('V'); await page.keyboard.press('j');
  await expect(page.locator('.copy-layer')).toHaveAttribute('aria-description', 'Selected rows 1 through 2');
  const paneCount = await page.locator('.terminal-pane').count();
  const beforePage = await (await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'pane.copy_context', id } })).json();
  await page.keyboard.press('Control+d'); expect(await page.locator('.terminal-pane').count()).toBe(paneCount);
  await expect(page.locator('.copy-layer')).toHaveAttribute('data-row', String(1 + Math.floor(beforePage.scroll.viewport_rows / 2)));
  await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
});

test('live native output invalidates selection and mobile search remains usable', async ({ page }) => {
  await login(page); const id = await create(page);
  await runtime.cli('pane', 'send-text', id, "printf 'LIVE_COPY_%s\\n' MARKER\n"); await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('LIVE_COPY_MARKER');
  await open(page, true); await find(page, 'LIVE_COPY_MARKER'); await expect(page.locator('.copy-status')).toContainText('1/1');
  await runtime.cli('pane', 'send-text', id, "printf 'REVISION_%s\\n' CHANGED\n"); await expect(page.locator('.copy-notice')).toContainText('Content changed'); await expect(page.locator('.copy-current')).toHaveCount(0);
  await page.keyboard.press('q'); await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true); await find(page, 'REVISION_CHANGED'); await expect(page.locator('.copy-status')).toContainText('1/1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/copy-mode-mobile.png' });
  await page.locator('.copy-toolbar [data-copy=exit]').click(); await expect(page.locator('.copy-layer')).toHaveCount(0);
});

test('native word motions, combining text and wrapped selections preserve exact text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await login(page); const id = await create(page);
  const wrapped = 'WRAPPED_' + '界á'.repeat(90) + '_END';
  await runtime.cli('pane', 'send-text', id, "printf '%s\\n' 'AL''PHA βe''ta ga''mma' \"WRAP\"\"PED_$(printf '界á%.0s' {1..90})_END\"\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('ALPHA βeta gamma');
  await open(page, true); await find(page, 'ALPHA βeta gamma'); await expect(page.locator('.copy-status')).toContainText('1/1');
  await page.keyboard.press('v'); await page.keyboard.press('e'); await page.keyboard.press('y'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ALPHA');
  await open(page, true); await find(page, wrapped); await expect(page.locator('.copy-status')).toContainText('1/1'); await expect(page.locator('.copy-current')).not.toHaveCount(1);
  await page.keyboard.press('y'); await expect(page.locator('.copy-layer')).toHaveCount(0); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(wrapped);
});

test('closing copy mode cancels queued native motions and restores a nonzero entry offset', async ({ page }) => {
  await login(page); const id = await create(page);
  await runtime.cli('pane', 'send-text', id, "for i in $(seq 1 160); do printf 'CANCEL_%03d words\\n' \"$i\"; done\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('CANCEL_160');
  const action = (data: object) => page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', id, ...data } });
  await action({ action: 'pane.scroll', offset_from_bottom: 12 });
  await open(page); await page.keyboard.press('g'); await expect(page.locator('.copy-layer')).toHaveAttribute('data-row', '0');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false;
  await page.route('**/api/action', async route => {
    if (route.request().postDataJSON()?.action === 'pane.copy_motion') { received = true; await held; }
    await route.continue();
  });
  await page.keyboard.press('w'); await expect.poll(() => received).toBe(true); await page.keyboard.press('j'); await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  release();
  await expect.poll(async () => (await (await action({ action: 'pane.copy_context' })).json()).scroll.offset_from_bottom).toBe(12);
  await expect(page.locator('.pane-active textarea')).toBeFocused();
});

test('copy mode waits for matching rendered content when the native API is ahead of terminal frames', async ({ page }) => {
  let hold = false; const frames: (() => void)[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const server = socket.connectToServer(); server.onMessage(message => { if (hold) frames.push(() => socket.send(message)); else socket.send(message); });
  });
  await login(page); const id = await create(page); await open(page); await page.keyboard.press('q');
  hold = true;
  await runtime.cli('pane', 'send-text', id, "printf '\\033[2J\\033[HNEW_%s\\n' FRAME\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain('NEW_FRAME');
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Terminal: search native scrollback', exact: true }).click();
  await expect(page.locator('.copy-status')).toHaveText('COPY WAIT'); await expect(page.locator('.copy-caret')).toHaveCount(0); await expect(page.locator('.copy-layer[data-selection]')).toHaveCount(0);
  hold = false; for (const send of frames.splice(0)) send();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/); await expect(page.locator('.copy-search input')).toBeFocused();
  await find(page, 'NEW_FRAME'); await expect(page.locator('.copy-status')).toContainText('1/1'); await expect(page.locator('.copy-current')).not.toHaveCount(0);
  await page.keyboard.press('q');
});

test('Escape clears an in-flight search without allowing its delayed result to recreate the selection', async ({ page }) => {
  await login(page); await create(page); await open(page, true);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false;
  await page.route('**/api/action', async route => { if (route.request().postDataJSON()?.action === 'pane.copy_search') { received = true; await held; } await route.continue(); });
  await find(page, 'anything'); await expect.poll(() => received).toBe(true); await page.keyboard.press('Escape');
  await expect(page.locator('.copy-layer')).toHaveCount(1);
  const completed = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'pane.copy_search'); release(); await completed;
  await expect(page.locator('.copy-status')).not.toContainText('/'); await expect(page.locator('.copy-current')).toHaveCount(0); await page.keyboard.press('Escape'); await expect(page.locator('.copy-layer')).toHaveCount(0);
});

test('Escape cancels a search submitted before the first matching native frame', async ({ page }) => {
  await login(page); await create(page);
  let release!: () => void, held = false, searches = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/action', async route => {
    const action = route.request().postDataJSON()?.action;
    if (action === 'pane.copy_search') searches++;
    if (action === 'pane.copy_context' && !held) {
      held = true; await gate;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'pane content changed' }) });
    } else await route.continue();
  });
  await page.keyboard.press('Control+k');
  await page.locator('#command-list').getByRole('button', { name: 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect.poll(() => held).toBe(true);
  await page.locator('.copy-toolbar [data-copy=find]').click(); await find(page, 'cancelled before frame');
  await page.keyboard.press('Escape'); release();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/);
  expect(searches).toBe(0); await expect(page.locator('.copy-layer')).toHaveCount(1);
  await expect(page.locator('.copy-current')).toHaveCount(0);
  await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
});
