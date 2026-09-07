import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => {
  runtime = await fixture(); const directory = join(runtime.directory, 'link-plugin'); await mkdir(directory);
  await writeFile(join(directory, 'herdr-plugin.toml'), `id = "example.links"\nname = "Link Fixture"\nversion = "0.1.0"\nmin_herdr_version = "0.7.0"\n[[actions]]\nid = "inspect"\ntitle = "Inspect link"\ncontexts = ["pane"]\ncommand = ["python3", "-c", "import os; print(os.environ['HERDR_PLUGIN_CONTEXT_JSON'])"]\n[[link_handlers]]\nid = "fixture"\ntitle = "Fixture link"\npattern = "^https://example.test/plugin"\naction = "inspect"\n`);
  await runtime.cli('plugin', 'link', directory);
});
test.afterAll(async () => { await runtime?.close(); });
async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const previous = new URL(page.url()).searchParams.get('pane'); await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden();
  return new URL(page.url()).searchParams.get('pane')!;
}
const action = (page: Page, id: string, data: object) => page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', id, ...data } });
async function paint(page: Page, id: string, text: string) {
  await runtime.cli('pane', 'send-text', id, `printf '\\033[2J\\033[H${text}\\n'\n`);
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain(text.includes('033]8') ? 'CLICK_LINK' : text);
  // A native copy-mode acquisition confirms the delivered browser frame matches.
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/); await page.keyboard.press('q');
}
async function click(page: Page, modifier: 'Control' | 'Meta' = 'Control') {
  const box = await page.locator('.pane-active canvas').first().boundingBox(); await page.keyboard.down(modifier); await page.mouse.click(box!.x + 18, box!.y + 8); await page.keyboard.up(modifier);
}

test('modified links invoke native plugin handlers with their pane context', async ({ page, context }) => {
  const id = await create(page); await paint(page, id, 'https://example.test/plugin/123');
  const before = await action(page, id, { action: 'plugin.log.list' }), count = (await before.json()).logs.length;
  const other = await action(page, id, { action: 'workspace.create', label: 'Other focus' }); await runtime.cli('workspace', 'focus', (await other.json()).root_pane.workspace_id);
  await click(page);
  await expect.poll(async () => (await (await action(page, id, { action: 'plugin.log.list' })).json()).logs.length).toBe(count + 1);
  await expect.poll(async () => (await (await action(page, id, { action: 'plugin.log.list' })).json()).logs[0].status).toBe('succeeded');
  const log = (await (await action(page, id, { action: 'plugin.log.list' })).json()).logs[0];
  const value = JSON.parse(log.stdout); expect(value.clicked_url).toBe('https://example.test/plugin/123'); expect(value.focused_pane_id).toBe(id); expect(value.invocation_source).toBe('link_click'); expect(context.pages()).toHaveLength(1);
});

test('web links open without an opener and blocked tabs have a usable semantic fallback', async ({ page, context }) => {
  const referrers: (string | undefined)[] = [];
  await context.route('https://example.test/**', route => { referrers.push(route.request().headers().referer); return route.fulfill({ body: '<title>Link destination</title>' }); });
  const id = await create(page); await paint(page, id, 'https://example.test/web');
  const opened = context.waitForEvent('page'); await click(page, 'Meta'); const popup = await opened; await popup.waitForURL('https://example.test/web'); expect(await popup.evaluate(() => window.opener)).toBeNull(); await popup.close();
  await page.evaluate(() => { window.open = () => null; }); await click(page);
  const link = page.locator('.terminal-link-notice a'); await expect(link).toHaveAttribute('href', 'https://example.test/web'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer'); await expect(link).toBeVisible();
  await page.screenshot({ path: 'test-results/terminal-link-fallback.png' });
  const fallback = context.waitForEvent('page'); await link.click(); const destination = await fallback; await destination.waitForURL('https://example.test/web'); expect(await destination.evaluate(() => window.opener)).toBeNull(); await destination.close(); expect(referrers.every(value => !value)).toBe(true);
  await page.getByRole('button', { name: 'Dismiss terminal link' }).click(); await expect(link).toHaveCount(0);
});

test('unhandled unsafe OSC links never reach the browser opener', async ({ page }) => {
  const id = await create(page); await paint(page, id, '\\033]8;;javascript:alert(1)\\033\\\\CLICK_LINK\\033]8;;\\033\\\\');
  await page.evaluate(() => { (window as any).opened = []; window.open = (...args) => { (window as any).opened.push(args); return null; }; });
  const response = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.action === 'pane.link.activate'); await click(page); expect((await response).ok()).toBe(true);
  expect(await page.evaluate(() => (window as any).opened)).toEqual([]); await expect(page.locator('.terminal-link-notice')).toBeHidden();
});

test('native revision and viewport guards reject stale links', async ({ page }) => {
  const id = await create(page); await paint(page, id, 'https://example.test/web');
  const context = await (await action(page, id, { action: 'pane.copy_context' })).json();
  const params = { action: 'pane.link.activate', viewport_row: 0, col: 2, content_revision: context.content_revision, offset_from_bottom: context.scroll.offset_from_bottom };
  const offset = await action(page, id, { ...params, offset_from_bottom: context.scroll.offset_from_bottom + 1 }); expect(offset.ok()).toBe(false); expect(await offset.text()).toContain('viewport changed');
  await runtime.cli('pane', 'send-text', id, "printf 'CHANGED\\n'\n"); await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain('CHANGED');
  const stale = await action(page, id, params); expect(stale.ok()).toBe(false); expect(await stale.text()).toContain('content changed');
});

test('delayed context cannot activate a different link after output changes', async ({ page }) => {
  const id = await create(page); await paint(page, id, 'https://example.test/web');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false, activations = 0;
  await page.route('**/api/action', async route => {
    const action = route.request().postDataJSON()?.action;
    if (action === 'pane.copy_context') { received = true; await held; }
    if (action === 'pane.link.activate') ++activations;
    await route.continue();
  });
  await click(page); await expect.poll(() => received).toBe(true);
  await runtime.cli('pane', 'send-text', id, "printf '\\033[2J\\033[HREPLACED\\n'\n"); await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain('REPLACED');
  const completed = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.action === 'pane.copy_context'); release(); await completed;
  expect(activations).toBe(0);
});


test('an OSC hyperlink opens its native target instead of its displayed label', async ({ page, context }) => {
  await context.route('https://example.test/**', route => route.fulfill({ body: '<title>OSC destination</title>' }));
  const id = await create(page); await paint(page, id, '\\033]8;;https://example.test/osc\\033\\\\CLICK_LINK\\033]8;;\\033\\\\');
  const opened = context.waitForEvent('page'); await click(page); const popup = await opened; await popup.waitForURL('https://example.test/osc'); await popup.close();
});

test('a native API ahead of the displayed frame cannot dispatch its replacement URL', async ({ page }) => {
  let hold = false; const frames: (() => void)[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => { const server = socket.connectToServer(); server.onMessage(message => { if (hold) frames.push(() => socket.send(message)); else socket.send(message); }); });
  const id = await create(page); await paint(page, id, 'https://example.test/web'); hold = true;
  await runtime.cli('pane', 'send-text', id, "printf '\\033[2J\\033[Hhttps://example.test/plugin/REPLACEMENT\\n'\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain('REPLACEMENT');
  let activations = 0; await page.route('**/api/action', async route => { if (route.request().postDataJSON()?.action === 'pane.link.activate') ++activations; await route.continue(); });
  const completed = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.action === 'pane.copy_context'); await click(page); await completed;
  await expect(page.locator('#status')).toContainText('Terminal content changed'); expect(activations).toBe(0);
  hold = false; for (const send of frames.splice(0)) send();
});

test('a delayed non-link response replays the drag into ordinary terminal selection', async ({ page }) => {
  const id = await create(page); await paint(page, id, 'NON_LINK_SELECTION');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let received = false;
  await page.route('**/api/action', async route => { if (route.request().postDataJSON()?.action === 'pane.link.activate') { received = true; await held; } await route.continue(); });
  const box = await page.locator('.pane-active canvas').first().boundingBox(); await page.keyboard.down('Control'); await page.mouse.move(box!.x + 2, box!.y + 8); await page.mouse.down(); await expect.poll(() => received).toBe(true);
  await page.mouse.move(box!.x + 140, box!.y + 8); await page.mouse.up(); await page.keyboard.up('Control');
  const completed = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.action === 'pane.link.activate'); release(); await completed;
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Plugins: management, actions, panes and logs', exact: true }).click();
  await expect(page.locator('#plugin-context')).toContainText('TEXT SELECTED');
  const invoked = page.waitForResponse(r => r.url().endsWith('/api/action') && r.request().postDataJSON()?.action === 'plugin.action.invoke');
  await page.getByRole('button', { name: 'RUN Inspect link', exact: true }).click();
  const logId = (await (await invoked).json()).log.log_id;
  const readLog = async () => (await (await action(page, id, { action: 'plugin.log.list' })).json()).logs.find((log: any) => log.log_id === logId);
  await expect.poll(async () => (await readLog())?.status).toBe('succeeded');
  expect(JSON.parse((await readLog()).stdout).selected_text).toMatch(/^NON_LINK/);
});


test('blocked links fit a phone viewport and remain keyboard accessible', async ({ page }) => {
  const id = await create(page); await page.setViewportSize({ width: 390, height: 844 });
  await paint(page, id, 'https://example.test/mobile');
  await page.evaluate(() => { window.open = () => null; }); await click(page);
  const link = page.locator('.terminal-link-notice a'); await expect(link).toBeVisible(); await link.focus(); await expect(link).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const notice = await page.locator('.terminal-link-notice').boundingBox(); expect(notice!.x).toBeGreaterThanOrEqual(0); expect(notice!.x + notice!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/terminal-link-mobile.png' });
});
