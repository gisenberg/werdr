import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });
test.afterEach(async ({}, info) => { if (info.status !== info.expectedStatus && runtime) await info.attach('native-fixture.log', { body: runtime.diagnostics(), contentType: 'text/plain' }); });
test('native desktop splits preserve terminal identity, input, ratios, zoom and phone focus', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
  const first = await page.locator('.pane-active').getAttribute('data-pane');
  const original = await page.locator('.pane-active textarea').elementHandle();
  const run = async (label: string) => { await page.locator('#commands').click(); await page.locator('#command-list').getByRole('button', { name: label, exact: true }).click(); };
  await run('Split right (Ctrl/Cmd+D)');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  const second = await page.locator('.pane-active').getAttribute('data-pane'); expect(second).not.toBe(first);
  await run('Split down (Ctrl/Cmd+Shift+D)');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(3); await expect(page.locator('#shield')).toBeHidden();
  const third = await page.locator('.pane-active').getAttribute('data-pane');
  const layout = () => page.request.get(runtime.url + '/api/layout?' + new URLSearchParams({ machine: 'local', tab: new URL(page.url()).searchParams.get('tab')! })).then(response => response.json());
  const before = await layout(); expect(before.root.direction).toBe('right'); expect(before.root.second.direction).toBe('down');
  const firstPane = page.locator(`.terminal-pane[data-pane="${first}"]`), secondPane = page.locator(`.terminal-pane[data-pane="${second}"]`), thirdPane = page.locator(`.terminal-pane[data-pane="${third}"]`);
  const a = await firstPane.boundingBox(), b = await secondPane.boundingBox(), c = await thirdPane.boundingBox();
  expect(a!.x + a!.width).toBeLessThan(b!.x); expect(b!.y + b!.height).toBeLessThan(c!.y);
  for (const [pane, marker] of [[firstPane, 'FIRST'], [secondPane, 'SECOND'], [thirdPane, 'THIRD']] as const) {
    await pane.locator('textarea').focus(); await page.keyboard.type(`printf 'LAYOUT_%s\\n' ${marker}`); await page.keyboard.press('Enter');
    const id = await pane.getAttribute('data-pane'); await expect.poll(() => runtime.cli('pane', 'read', id!, '--source', 'recent')).toContain(`LAYOUT_${marker}`);
  }
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  const divider = page.locator('.pane-divider[data-path="[]"]');
  await divider.focus(); await page.keyboard.press('ArrowRight'); await expect.poll(async () => (await layout()).root.ratio).toBeCloseTo(.55, 2);
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  const box = await divider.boundingBox(); await page.mouse.move(box!.x + 2, box!.y + 30); await page.mouse.down(); await page.mouse.move(box!.x + 90, box!.y + 30); await page.mouse.up();
  await expect.poll(async () => (await layout()).root.ratio).toBeGreaterThan(.6);
  const ratio = (await layout()).root.ratio;
  await thirdPane.locator('textarea').focus(); await run('Zoom / restore pane'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await run('Zoom / restore pane'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(3);
  await run('Resize pane up'); await expect.poll(async () => (await layout()).root.second.ratio).not.toBe(.5);
  await run('Focus pane up'); await expect(secondPane).toHaveClass(/pane-active/);
  await run('Swap pane down'); await expect.poll(async () => (await layout()).root.second.second.pane_id).toBe(second);
  await expect.poll(async () => (await secondPane.boundingBox())!.y - (await thirdPane.boundingBox())!.y).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/native-desktop-splits.png' });
  await runtime.restartGateway(); await page.reload(); await expect(page.locator('#boot')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(3); expect((await layout()).root.ratio).toBeCloseTo(ratio, 3);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/native-mobile-splits.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await run('Move pane to new tab'); await expect(page.locator('#tabs button')).toHaveCount(2); await expect(page.locator('.terminal-pane:visible')).toHaveCount(1); await expect(page.locator('#shield')).toBeHidden();
  const movedTab = new URL(page.url()).searchParams.get('tab');
  await run('Move tab earlier'); await expect(page.locator('#tabs button').first()).toHaveAttribute('data-id', movedTab!);
  await run('Move tab later'); await expect(page.locator('#tabs button').last()).toHaveAttribute('data-id', movedTab!);
  await page.locator('.pane-active textarea').focus(); await page.keyboard.type("printf 'MOVED_%s\\n' STILL_ALIVE"); await page.keyboard.press('Enter');
  const movedPane = new URL(page.url()).searchParams.get('pane'); await expect.poll(() => runtime.cli('pane', 'read', movedPane!, '--source', 'recent')).toContain('MOVED_STILL_ALIVE');
  await run('Move pane to new workspace'); await expect(page.locator('#workspaces button')).toHaveCount(2); await expect(page.locator('#shield')).toBeHidden();
  const movedWorkspace = new URL(page.url()).searchParams.get('workspace');
  await run('Move workspace earlier'); await expect(page.locator('#workspaces button').first()).toHaveAttribute('data-id', `local/${movedWorkspace}`);
  await run('Move workspace later'); await expect(page.locator('#workspaces button').last()).toHaveAttribute('data-id', `local/${movedWorkspace}`);
  expect(errors).toEqual([]);
});

test('one and fifteen visible panes retain controller identity through metadata and chrome updates', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const action = async (action: string, id?: string, extra = {}) => {
    const response = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action, id, ...extra } });
    expect(response.ok()).toBe(true); return response.json();
  };
  const { root_pane: root } = await action('workspace.create', undefined, { label: 'Layout scale verification' });
  const target = runtime.url + '/?' + new URLSearchParams({ machine: 'local', workspace: root.workspace_id, tab: root.tab_id, pane: root.pane_id });
  const measure = async (count: number) => {
    const started = Date.now(); await page.goto(target); await expect(page.locator('#boot')).toBeHidden();
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(count); await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0);
    const attachMs = Date.now() - started;
    const references = await page.locator('.terminal-pane textarea').elementHandles();
    await page.locator('#settings').click(); await page.locator('[data-setting=theme]').selectOption('nord'); await page.locator('#settings-cancel').click();
    await action('pane.rename', root.pane_id, { label: `scale-${count}` }); await expect(page.locator(`.terminal-pane[data-pane="${root.pane_id}"] .pane-title`)).toContainText(`scale-${count}`);
    expect(await Promise.all(references.map(reference => reference.evaluate(node => node.isConnected)))).toEqual(Array(count).fill(true));
    console.log(`Visible pane scaling: ${count} panes, ${attachMs}ms from navigation to authoritative frames; metadata/settings retained ${references.length} controllers`);
  };
  try {
    await measure(1);
    const queue = [{ id: root.pane_id, depth: 0 }];
    for (let count = 1; count < 15; count++) {
      const next = queue.shift()!; const { pane } = await action('pane.split', next.id, { direction: next.depth % 2 ? 'down' : 'right' });
      queue.push({ id: next.id, depth: next.depth + 1 }, { id: pane.pane_id, depth: next.depth + 1 });
    }
    await measure(15);
  } finally { await action('workspace.close', root.workspace_id); }
});

test('rapid pane focus changes cannot reclaim focus from the navigation search', async ({ page }) => {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  const previousWorkspace = new URL(page.url()).searchParams.get('workspace');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).not.toBe(previousWorkspace);
  await expect(page.locator('#shield')).toBeHidden();
  let releaseSplit!: () => void;
  const splitGate = new Promise<void>(resolve => { releaseSplit = resolve; });
  await page.route('**/api/action', async route => {
    if (route.request().postDataJSON()?.action === 'pane.split') {
      const response = await route.fetch(); await splitGate; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.keyboard.press('Control+d'); await expect(page.locator('.terminal-pane:visible')).toHaveCount(2); await expect(page.locator('.pane-shield:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => {
    const inputs = document.querySelectorAll<HTMLTextAreaElement>('.terminal-pane textarea');
    inputs[0].focus(); inputs[1].focus(); document.querySelector<HTMLInputElement>('#fleet-search')!.focus();
  });
  releaseSplit();
  await page.keyboard.type('focus remains in navigation while background terminals receive frames');
  await expect(page.locator('#fleet-search')).toHaveValue('focus remains in navigation while background terminals receive frames');
  await expect(page.locator('#fleet-search')).toBeFocused();
});
