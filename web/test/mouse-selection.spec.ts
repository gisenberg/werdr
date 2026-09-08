import { test, expect, type Page } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });
async function create(page: Page) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const previous = new URL(page.url()).searchParams.get('pane');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden();
  return new URL(page.url()).searchParams.get('pane')!;
}
const action = (page: Page, id: string, data: object) => page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', id, ...data } });
async function geometry(page: Page) {
  // Copy mode verifies that native content and browser cells have converged.
  await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Terminal: copy mode (native scrollback)', exact: true }).click();
  await expect(page.locator('.copy-status')).toContainText(/COPY \d+:/);
  const caret = (await page.locator('.copy-caret').boundingBox())!, canvas = (await page.locator('.pane-active canvas').first().boundingBox())!;
  await page.keyboard.press('q'); await expect(page.locator('.copy-layer')).toHaveCount(0);
  return { canvas, point: (row: number, col: number) => ({ x: canvas.x + (col + .5) * caret.width, y: canvas.y + (row + .5) * caret.height }) };
}
async function paint(page: Page, id: string, text: string) {
  const quoted = "'" + text.replaceAll("'", "'\\''") + "'";
  await runtime.cli('pane', 'send-text', id, `printf '\\033[2J\\033[H%s\\n' ${quoted}\n`);
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'visible')).toContain(text);
  return geometry(page);
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.up();
}
async function policy(page: Page, copy: boolean) {
  await page.locator('#settings').click(); await page.locator('[data-setting=copyOnSelect]').setChecked(copy);
  await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click(); await expect(page.locator('#settings-dialog')).toBeHidden();
}
async function pixel(page: Page, point: { x: number; y: number }) {
  return page.locator('.pane-active canvas').first().evaluate((node, point) => {
    const canvas = node as HTMLCanvasElement, box = canvas.getBoundingClientRect();
    return [...canvas.getContext('2d')!.getImageData(Math.floor((point.x - box.x) * canvas.width / box.width), Math.floor((point.y - box.y) * canvas.height / box.height), 1, 1).data].slice(0, 3);
  }, point);
}

test('normal drags copy native inclusive cells and double-clicks preserve URLs and quoted paths', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, true);
  const { point } = await paint(page, id, 'ALPHA 你好 á END\nhttps://example.test/a(b)?q=x.\ncat "/tmp/build output/log.txt"');
  const original = await page.locator('.pane-active textarea').elementHandle();
  await page.evaluate(() => navigator.clipboard.writeText('UNCHANGED'));
  const plain = point(0, 2); await page.mouse.click(plain.x, plain.y); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('UNCHANGED');
  // Move outside the double-click tolerance before starting a fresh drag.
  await drag(page, point(0, 6), point(0, 9));
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('你好');
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(0);
  const url = point(1, 12); await page.mouse.dblclick(url.x, url.y);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.test/a(b)?q=x');
  const path = point(2, 18); await page.mouse.dblclick(path.x, path.y);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/tmp/build output/log.txt');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator('.pane-active textarea')).toBeFocused();
});

test('retained selections copy with native shortcuts, clear on input, and persist the policy through restart', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const inputs: string[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => { const server = socket.connectToServer(); socket.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.input') inputs.push(record.text); server.send(message); }); });
  const id = await create(page); await policy(page, false);
  const { point } = await paint(page, id, 'ALPHA 你好 á END\nNEXT_LINE');
  await page.evaluate(() => navigator.clipboard.writeText('UNCHANGED'));
  await drag(page, point(1, 3), point(0, 6));
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('UNCHANGED');
  await expect.poll(() => pixel(page, point(0, 25))).toEqual([89, 89, 98]);
  await page.screenshot({ path: 'test-results/mouse-selection-desktop.png' });
  const before = inputs.length; await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('你好 á END\nNEXT');
  expect(inputs.slice(before)).not.toContain('\x03'); await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(0);
  await page.keyboard.press('Control+c'); await expect.poll(() => inputs.slice(before).includes('\x03')).toBe(true);
  const next = await paint(page, id, 'RETAINED_TOKEN'); const word = next.point(0, 5); await page.mouse.dblclick(word.x, word.y);
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(1); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('你好 á END\nNEXT'); await page.keyboard.press('Escape'); await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(0);
  await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
  await page.locator('#settings').click(); await expect(page.locator('[data-setting=copyOnSelect]')).not.toBeChecked();
  await page.locator('[data-setting=copyOnSelect]').check(); await page.locator('#settings-cancel').click();
  await page.locator('#settings').click(); await expect(page.locator('[data-setting=copyOnSelect]')).not.toBeChecked(); await page.locator('#settings-cancel').click();
});

test('delayed selection acquisition cannot copy replacement content after output changes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, true);
  const { point } = await paint(page, id, 'ORIGINAL_SELECTION');
  await page.evaluate(() => navigator.clipboard.writeText('KEEP_CLIPBOARD'));
  let release!: () => void, received = false, reads = 0; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/action', async route => {
    const method = route.request().postDataJSON()?.action;
    if (method === 'pane.copy_context') { received = true; await held; }
    if (method === 'pane.selection.read') reads++;
    await route.continue();
  });
  await drag(page, point(0, 0), point(0, 7)); await expect.poll(() => received).toBe(true);
  await runtime.cli('pane', 'send-text', id, "printf '\\033[2J\\033[HREPLACEMENT\\n'\n");
  await expect(page.locator('#status')).toContainText('Terminal content changed');
  const finished = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'pane.copy_context'); release(); await finished;
  expect(reads).toBe(0); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('KEEP_CLIPBOARD');
});

test('a delayed successful native read is discarded when another terminal frame replaces the selection', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, true);
  const { point } = await paint(page, id, 'ORIGINAL_SELECTION');
  await page.evaluate(() => navigator.clipboard.writeText('KEEP_CLIPBOARD'));
  let release!: () => void, received = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/action', async route => {
    if (route.request().postDataJSON()?.action !== 'pane.selection.read') return route.continue();
    const response = await route.fetch(); expect(response.ok()).toBe(true); received = true; await held; await route.fulfill({ response });
  });
  await drag(page, point(0, 0), point(0, 7)); await expect.poll(() => received).toBe(true);
  await runtime.cli('pane', 'send-text', id, "printf '\\033[2J\\033[HREPLACEMENT\\n'\n"); await expect(page.locator('#status')).toContainText('Terminal content changed');
  const finished = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'pane.selection.read'); release(); await finished;
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(0); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('KEEP_CLIPBOARD');
});

test('dragging beyond the viewport scrolls native history and copies the complete range', async ({ page, context }) => {
  test.setTimeout(90000); await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, true);
  await runtime.cli('pane', 'send-text', id, "for i in $(seq 1 220); do printf 'HISTORY_%03d\\n' \"$i\"; done\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('HISTORY_220');
  const { point, canvas } = await geometry(page);
  const initial = await (await action(page, id, { action: 'pane.copy_context' })).json(), row = initial.scroll.viewport_rows - 4;
  const last = initial.viewport_text.split('\n')[row]; expect(last).toMatch(/^HISTORY_\d{3}$/);
  const anchor = point(row, 10); await page.mouse.move(anchor.x, anchor.y); await page.mouse.down(); await page.mouse.move(canvas.x + 4, canvas.y - 30, { steps: 4 });
  await expect.poll(async () => (await (await action(page, id, { action: 'pane.copy_context' })).json()).scroll.offset_from_bottom).toBeGreaterThan(initial.scroll.viewport_rows);
  const end = point(2, 0); await page.mouse.move(end.x, end.y); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^HISTORY_\\d{3}[\\s\\S]*${last}$`));
  const copied = await page.evaluate(() => navigator.clipboard.readText()), lines = copied.split('\n');
  expect(lines.length).toBeGreaterThan(initial.scroll.viewport_rows);
  const first = Number(lines[0].slice(8)); expect(lines).toEqual(lines.map((_, index) => `HISTORY_${String(first + index).padStart(3, '0')}`));
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(0);
});

test('clipboard rejection never falls back to a second browser copy on double-click', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, true);
  const { point } = await paint(page, id, 'CLIPBOARD_PERMISSION_TEST');
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('KEEP_CLIPBOARD');
    (window as any).clipboardCalls = [];
    for (const method of ['write', 'writeText']) Object.defineProperty(navigator.clipboard, method, { configurable: true, value: () => { (window as any).clipboardCalls.push(method); return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); } });
  });
  const word = point(0, 6); await page.mouse.dblclick(word.x, word.y);
  await expect(page.locator('#status')).toContainText('Copy failed');
  await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).clipboardCalls)).toEqual(['write']);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('KEEP_CLIPBOARD');
});

test('light-theme selection paints the native background without reducing glyph contrast', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, false);
  await page.locator('#settings').click(); await page.locator('[data-setting=theme]').selectOption('catppuccin-latte'); await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click(); await expect(page.locator('#settings-dialog')).toBeHidden();
  const { point } = await paint(page, id, 'ALPHA 你好 á END\nNEXT_LINE');
  await drag(page, point(1, 3), point(0, 6));
  await expect.poll(() => pixel(page, point(0, 25))).toEqual([172, 174, 176]);
  await page.screenshot({ path: 'test-results/mouse-selection-light.png' });
  await page.keyboard.press('Meta+c'); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('你好 á END\nNEXT');
});

test('wheel scrolling keeps a retained selection anchored to its original native history row', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); const id = await create(page); await policy(page, false);
  await runtime.cli('pane', 'send-text', id, "for i in $(seq 1 180); do printf 'RETAINED_%03d\\n' \"$i\"; done\n");
  await expect.poll(() => runtime.cli('pane', 'read', id, '--source', 'recent')).toContain('RETAINED_180');
  const { point } = await geometry(page), initial = await (await action(page, id, { action: 'pane.copy_context' })).json();
  const expected = initial.viewport_text.split('\n')[4]; expect(expected).toMatch(/^RETAINED_\d{3}$/);
  const word = point(4, 3); await page.mouse.dblclick(word.x, word.y); await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(1);
  await page.mouse.wheel(0, -90);
  await expect.poll(async () => (await (await action(page, id, { action: 'pane.copy_context' })).json()).scroll.offset_from_bottom).toBe(3);
  await page.keyboard.press('Control+c'); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
});
