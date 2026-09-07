import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { consoleInput } from './console-helpers.ts';

let runtime: Awaited<ReturnType<typeof fixture>>, directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'werdr editor '));
  const script = join(directory, 'editor.py');
  await writeFile(script, `import json, sys\nfrom pathlib import Path\nsource = Path(sys.argv[1])\nroot = Path(${JSON.stringify(directory)})\n(root / 'snapshot.txt').write_text(source.read_text())\n(root / 'metadata.json').write_text(json.dumps({'path': str(source)}))\nprint('EDITOR_READY', flush=True)\nfor line in sys.stdin:\n if line.strip() == 'save':\n  source.write_text(source.read_text() + 'EDITED_BY_BROWSER\\n')\n  print('EDITOR_SAVED', flush=True)\n if line.strip() == 'exit':\n  break\n`);
  runtime = await fixture(false, false, false, 'python3 ' + "'" + script.replaceAll("'", "'\\''") + "'");
});
test.afterAll(async () => { await runtime?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function login(page: Page) { await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden(); }
async function create(page: Page) { const previous = new URL(page.url()).searchParams.get('pane'); await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(previous); await expect(page.locator('#shield')).toBeHidden(); return Object.fromEntries(new URL(page.url()).searchParams); }
async function open(page: Page) { await page.keyboard.press('Control+k'); await page.locator('#command-list').getByRole('button', { name: 'Terminal: open scrollback in host editor', exact: true }).click(); }
async function metadata() { return JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as { path: string }; }
async function exists(path: string) { return stat(path).then(() => true, () => false); }

test('native editor receives the selected full history, preserves the original split, and cleans temporary files on exit and close', async ({ page }) => {
  test.setTimeout(90000); await login(page); const source = await create(page);
  await runtime.cli('pane', 'send-text', source.pane, "for i in $(seq 1 400); do printf 'EDITOR_SOURCE_%03d 東京\\n' \"$i\"; done\n");
  await expect.poll(() => runtime.cli('pane', 'read', source.pane, '--source', 'recent')).toContain('EDITOR_SOURCE_400');
  await page.locator('#split').click(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  await page.locator(`#panes button[data-id="${source.pane}"]`).click(); const original = await page.locator('.pane-active textarea').elementHandle();
  const otherResponse = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'workspace.create', label: 'Other editor source' } });
  const other = (await otherResponse.json()).root_pane; await runtime.cli('workspace', 'focus', other.workspace_id);
  await runtime.cli('pane', 'send-text', other.pane_id, "printf 'OTHER_%s\\n' SOURCE\n");
  await open(page); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(source.pane); await expect(page.locator('#shield')).toBeHidden();
  const editor = new URL(page.url()).searchParams.get('pane')!; await expect.poll(() => runtime.cli('pane', 'read', editor, '--source', 'recent')).toContain('EDITOR_READY');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1); await expect(page.locator('.pane-active textarea')).toBeFocused();
  const captured = await readFile(join(directory, 'snapshot.txt'), 'utf8'); expect(captured).toContain('EDITOR_SOURCE_001 東京'); expect(captured).toContain('EDITOR_SOURCE_400 東京'); expect(captured).not.toContain('OTHER_SOURCE');
  const first = (await metadata()).path; expect((await stat(first)).mode & 0o777).toBe(0o600);
  await page.keyboard.type('save'); await page.keyboard.press('Enter'); await expect.poll(() => readFile(first, 'utf8')).toContain('EDITED_BY_BROWSER');
  await page.screenshot({ path: 'test-results/scrollback-editor-desktop.png' });
  await page.keyboard.type('exit'); await page.keyboard.press('Enter'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(source.pane); await expect.poll(() => exists(first)).toBe(false); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  expect(await runtime.cli('pane', 'read', source.pane, '--source', 'recent')).not.toContain('EDITED_BY_BROWSER');
  await open(page); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).not.toBe(source.pane); await expect(page.locator('#shield')).toBeHidden();
  const secondEditor = new URL(page.url()).searchParams.get('pane')!; await expect.poll(async () => (await metadata()).path).not.toBe(first); const second = (await metadata()).path;
  await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden(); expect(new URL(page.url()).searchParams.get('pane')).toBe(secondEditor); expect(await exists(second)).toBe(true);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#close').click(); await expect.poll(() => exists(second)).toBe(false); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  // Overlay teardown can publish an intermediate adjacent-pane focus before
  // native restoration. The browser must converge to the final native focus.
  const nativeFocus = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.layouts.find((layout: { tab_id: string }) => layout.tab_id === source.tab).focused_pane_id;
  await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(nativeFocus);
  await expect(page.locator(`.terminal-pane[data-pane="${nativeFocus}"] textarea`)).toBeFocused();
  const sibling = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((pane: { pane_id: string; tab_id: string }) => pane.tab_id === source.tab && pane.pane_id !== source.pane).pane_id;
  await page.locator(`#panes button[data-id="${sibling}"]`).click();
  for (const data of [{ action: 'pane.focus_direction', id: source.pane, direction: 'right' }, { action: 'pane.focus_direction', id: sibling, direction: 'left' }, { action: 'pane.rename', id: sibling, label: 'Selection survives native focus' }]) {
    expect((await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', ...data } })).ok()).toBe(true);
  }
  await expect(page.locator(`#panes button[data-id="${sibling}"]`)).toContainText('Selection survives native focus');
  expect(new URL(page.url()).searchParams.get('pane')).toBe(sibling);
});

test('an editor closed before its first snapshot releases pending selection instead of trapping the browser', async ({ page }) => {
  let hold = false; const messages: (() => void)[] = [];
  await page.routeWebSocket('**/ws/fleet', socket => { const server = socket.connectToServer(); server.onMessage(message => { if (hold) messages.push(() => socket.send(message)); else socket.send(message); }); });
  let baseline: unknown;
  await page.route('**/api/fleet', route => hold ? route.fulfill({ json: baseline }) : route.continue());
  await login(page); const source = await create(page); baseline = await (await page.request.get(runtime.url + '/api/fleet')).json(); hold = true;
  let closedEditor = '';
  await page.route('**/api/action', async route => {
    if (route.request().postDataJSON()?.action !== 'pane.edit_scrollback') return route.continue();
    const response = await route.fetch(); const result = await response.json(); expect(result.pane?.pane_id).toBeTruthy(); closedEditor = result.pane.pane_id;
    await runtime.cli('pane', 'close', closedEditor); await route.fulfill({ response });
  });
  await open(page); await expect(page.locator('#status')).toContainText('editor terminal closed before it could attach'); await expect(page.locator('#shield')).toBeHidden();
  expect(new URL(page.url()).searchParams.get('pane')).toBe(source.pane); await expect(page.locator('.pane-active textarea')).toBeFocused();
  expect(closedEditor).not.toBe(source.pane); await expect.poll(async () => exists((await metadata()).path)).toBe(false);
  hold = false; for (const send of messages.splice(0)) send(); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
});
