import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

const exec = promisify(execFile);
async function repository(directory: string) {
  const path = join(directory, 'repository with spaces'); await mkdir(path);
  const git = (...args: string[]) => exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await git('init', '-b', 'main'); await writeFile(join(path, 'README.md'), 'Group fixture\n'); await git('add', 'README.md');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture');
  return path;
}
async function login(page: Page, runtime: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create workspace', exact: true })).toBeEnabled();
}
async function action(page: Page, url: string, data: object) {
  const response = await page.request.post(url + '/api/action', { headers: { Origin: url }, data: { machine: 'local', ...data } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
const row = (page: Page, id: string) => page.locator(`#workspaces button[data-id="local/${id}"]`);

test('native worktree groups retain active children, persist collapse, search hidden children and scope contextual checkout actions', async ({ page }) => {
  test.setTimeout(120000);
  const runtime = await fixture();
  try {
    const repo = await repository(runtime.directory), paths = [join(runtime.directory, 'child-a'), join(runtime.directory, 'child-b')];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page, runtime);
    const parent = (await action(page, runtime.url, { action: 'worktree.open', cwd: repo, path: repo, label: 'Repository parent' })).root_pane.workspace_id;
    await expect(row(page, parent)).toBeVisible();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const unrelated = new URL(page.url()).searchParams.get('workspace')!;
    const children: string[] = [];
    for (const [index, path] of paths.entries()) {
      await row(page, parent).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'NEW WORKTREE', exact: true }).click();
      await expect(page.locator('#worktree-branch')).toBeFocused(); await expect(page.locator('#worktree-cwd')).toHaveValue(repo);
      await page.locator('#worktree-branch').fill('child-' + index); await page.locator('#worktree-path').fill(path); await page.locator('#worktree-label').fill('Child ' + index);
      await page.getByRole('button', { name: 'CREATE AND OPEN', exact: true }).click();
      await expect(page.locator('#worktrees-dialog')).toBeHidden(); await expect(page.locator('#shield')).toBeHidden();
      children.push(new URL(page.url()).searchParams.get('workspace')!);
    }
    const selected = await page.locator('.pane-active textarea').elementHandle();
    const toggle = row(page, parent).locator('..').locator('.workspace-group-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(row(page, children[0])).toHaveCount(0); await expect(row(page, children[1])).toBeVisible();
    expect(await selected!.evaluate(node => node.isConnected)).toBe(true);
    await row(page, unrelated).click(); await expect(row(page, children[1])).toHaveCount(0);
    await page.locator('#fleet-search').fill('Child 0'); await expect(row(page, parent)).toBeVisible(); await expect(row(page, children[0])).toBeVisible();
    await row(page, children[0]).click(); await page.locator('#fleet-search').fill('');
    await expect(row(page, children[0])).toBeVisible(); await expect(row(page, children[1])).toHaveCount(0);
    await runtime.restartGateway(); await page.reload(); await expect(page.locator('#shield')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(row(page, children[0])).toBeVisible(); await expect(row(page, children[1])).toHaveCount(0);
    const retained = await page.locator('.pane-active textarea').elementHandle();
    await row(page, parent).focus(); await page.keyboard.press('ArrowRight'); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(row(page, children[1])).toBeVisible();
    await row(page, parent).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'OPEN WORKTREE...', exact: true }).click();
    await expect(page.locator('.worktree-row')).toHaveCount(3); await expect(page.locator('#worktree-repository')).toContainText(repo); await page.locator('#worktree-done').click();
    await page.screenshot({ path: 'test-results/workspace-groups-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#host-toggle').click(); await expect(toggle).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/workspace-groups-mobile.png' }); await page.setViewportSize({ width: 1440, height: 900 });
    await writeFile(join(paths[1], 'dirty.txt'), 'Must survive declined deletion\n');
    await row(page, children[1]).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'DELETE WORKTREE CHECKOUT...', exact: true }).click();
    await expect(page.locator('#worktree-remove-dialog')).toBeVisible(); await expect(page.locator('#worktree-remove-description')).toContainText(paths[1]);
    await page.locator('#worktree-remove-confirm').click(); await expect(page.locator('#worktree-remove-error')).not.toBeEmpty(); await access(join(paths[1], 'dirty.txt'));
    await page.locator('#worktree-force').check(); await page.locator('#worktree-remove-confirm').click(); await expect(page.locator('#worktree-remove-dialog')).toBeHidden(); await page.locator('#worktree-done').click();
    await expect(row(page, children[1])).toHaveCount(0); expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(children[0]);
    const rejected = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'workspace.close', id: parent } }); expect(rejected.ok()).toBe(false);
    await row(page, parent).click({ button: 'right' }); page.once('dialog', dialog => { expect(dialog.message()).toContain('all 2 workspaces'); void dialog.dismiss(); }); await page.getByRole('menuitem', { name: 'CLOSE GROUP', exact: true }).click();
    await expect(row(page, parent)).toBeVisible(); await expect(row(page, children[0])).toBeVisible();
    await row(page, unrelated).click(); await expect(page.locator('#shield')).toBeHidden(); const surviving = await page.locator('.pane-active textarea').elementHandle();
    await row(page, parent).click({ button: 'right' }); page.once('dialog', dialog => dialog.accept()); await page.getByRole('menuitem', { name: 'CLOSE GROUP', exact: true }).click();
    await expect(row(page, parent)).toHaveCount(0); await expect(row(page, children[0])).toHaveCount(0); await expect(row(page, unrelated)).toBeVisible();
    expect(await surviving!.evaluate(node => node.isConnected)).toBe(true); await access(join(repo, 'README.md')); await access(join(paths[0], 'README.md'));
    expect(await access(paths[1]).then(() => true, () => false)).toBe(false); expect(errors).toEqual([]);
  } finally { await runtime.close(); }
});

test('group preference saves preserve concurrent settings and recover from conflicts without changing native focus', async ({ page }) => {
  const runtime = await fixture();
  try {
    const repo = await repository(runtime.directory); await login(page, runtime);
    const parent = (await action(page, runtime.url, { action: 'worktree.open', cwd: repo, path: repo })).root_pane.workspace_id;
    const child = (await action(page, runtime.url, { action: 'worktree.create', cwd: repo, path: join(runtime.directory, 'child'), branch: 'child' })).root_pane.workspace_id;
    await expect(row(page, parent)).toBeVisible(); await row(page, parent).click(); await expect(page.locator('#shield')).toBeHidden();
    const terminal = await page.locator('.pane-active textarea').elementHandle(), selected = page.url();
    const latest = await (await page.request.get(runtime.url + '/api/settings')).json();
    const updated = await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { revision: latest.revision, preferences: { ...latest.preferences, theme: 'nord' } } }); expect(updated.ok()).toBe(true);
    const toggle = row(page, parent).locator('..').locator('.workspace-group-toggle');
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const saved = await (await page.request.get(runtime.url + '/api/settings')).json(); expect(saved.preferences.theme).toBe('nord'); expect(saved.preferences.collapsedWorkspaceGroups).toHaveLength(1);
    await page.route('**/api/settings', route => route.request().method() === 'POST' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Concurrent group preference edit' }) }) : route.continue());
    await toggle.click(); await expect(page.locator('#status')).toContainText('Concurrent group preference edit'); await expect(toggle).toBeEnabled(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.unroute('**/api/settings'); await row(page, parent).focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: 'EXPAND GROUP', exact: true }).click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(page.url()).toBe(selected); expect(await terminal!.evaluate(node => node.isConnected)).toBe(true);
    // Closing a contextual delete flow while its native read is pending must
    // not reopen a destructive confirmation after the user dismisses it.
    let release!: () => void, requested = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'worktree.list') { requested = true; await pending; }
      await route.continue();
    });
    await row(page, child).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'DELETE WORKTREE CHECKOUT...', exact: true }).click();
    await expect.poll(() => requested).toBe(true); await page.keyboard.press('Escape');
    const response = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'worktree.list');
    release(); await response; await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.locator('#worktrees-dialog')).toBeHidden(); await expect(page.locator('#worktree-remove-dialog')).toBeHidden(); await page.unroute('**/api/action');
    await expect(row(page, child)).toBeVisible(); expect(await terminal!.evaluate(node => node.isConnected)).toBe(true);
  } finally { await runtime.close(); }
});

test('workspace selection reveals crowded groups while metadata preserves manual scrolling and phones reveal on drawer open', async ({ page }) => {
  const runtime = await fixture();
  try {
    const repo = await repository(runtime.directory); await login(page, runtime);
    const parent = (await action(page, runtime.url, { action: 'worktree.open', cwd: repo, path: repo, label: 'Reveal parent' })).root_pane.workspace_id;
    let child = '';
    for (let index = 0; index < 2; index++) child = (await action(page, runtime.url, { action: 'worktree.create', cwd: repo, path: join(runtime.directory, 'child-' + index), branch: 'child-' + index, label: 'Reveal child ' + index })).root_pane.workspace_id;
    await action(page, runtime.url, { action: 'workspace.create', label: 'Unrelated workspace' });
    const latest = await (await page.request.get(runtime.url + '/api/settings')).json();
    const changed = await page.request.post(runtime.url + '/api/settings', { headers: { Origin: runtime.url }, data: { revision: latest.revision, preferences: { ...latest.preferences, sidebarSectionPercent: 25 } } }); expect(changed.ok()).toBe(true);
    await page.reload(); await expect(page.locator('#shield')).toBeHidden();
    const navigate = async (id: string) => { await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('local/' + id + ';'); await expect(page.locator('#command-list button')).toHaveCount(1); await page.keyboard.press('Enter'); await expect(page.locator('#shield')).toBeHidden(); };
    const visible = (id: string, scroller = 'workspaces') => row(page, id).evaluate((node, scroller) => {
      const rect = node.getBoundingClientRect(), parent = document.getElementById(scroller)!, viewport = parent.getBoundingClientRect();
      return rect.top >= viewport.top + parent.clientTop - 1 && rect.bottom <= viewport.top + parent.clientTop + parent.clientHeight + 1;
    }, scroller);
    await navigate(child); await expect.poll(() => visible(child)).toBe(true);
    const retained = await page.locator('.pane-active textarea').elementHandle();
    await page.locator('#workspaces').evaluate(node => { node.scrollTop = 0; }); expect(await visible(child)).toBe(false);
    await action(page, runtime.url, { action: 'workspace.rename', id: parent, label: 'Metadata refresh' }); await expect(row(page, parent)).toContainText('Metadata refresh');
    expect(await page.locator('#workspaces').evaluate(node => node.scrollTop)).toBe(0); expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
    await navigate(parent); await expect.poll(() => visible(parent)).toBe(true); await navigate(child); await expect.poll(() => visible(child)).toBe(true);
    await page.reload(); await expect(page.locator('#shield')).toBeHidden(); await expect.poll(() => visible(child)).toBe(true);
    await page.screenshot({ path: 'test-results/workspace-groups-reveal-desktop.png' });
    await page.setViewportSize({ width: 390, height: 440 }); await page.locator('#host-toggle').click(); await expect.poll(() => visible(child, 'rail')).toBe(true);
    await page.locator('#rail').evaluate(node => { node.scrollTop = 0; }); await page.locator('#host-toggle').click(); await page.locator('#host-toggle').click(); await expect.poll(() => visible(child, 'rail')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/workspace-groups-reveal-mobile.png' });
  } finally { await runtime.close(); }
});

test('ordinary Git workspace menus discover native worktrees without moving focus or leaking delayed results', async ({ page }) => {
  test.setTimeout(120000);
  const runtime = await fixture();
  let release: (() => void) | undefined;
  try {
    const repo = await repository(runtime.directory);
    const gitPane = JSON.parse(await runtime.cli('workspace', 'create', '--cwd', repo, '--label', 'Ordinary Git workspace')).result.root_pane;
    const plain = JSON.parse(await runtime.cli('workspace', 'create', '--cwd', runtime.directory, '--label', 'Outside Git')).result.root_pane;
    const native = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot;
    expect(native.workspaces.find((workspace: any) => workspace.workspace_id === gitPane.workspace_id).worktree).toBeUndefined();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page, runtime); await row(page, gitPane.workspace_id).click(); await expect(page.locator('#shield')).toBeHidden();
    const terminal = await page.locator('.pane-active textarea').elementHandle();
    let delayed = false, received: (() => void) | undefined;
    await page.route('**/api/action', async route => {
      const data = route.request().postDataJSON();
      if (!delayed || data.action !== 'worktree.list' || data.id !== gitPane.workspace_id) { await route.continue(); return; }
      delayed = false;
      const response = await route.fetch();
      await new Promise<void>(resolve => { release = resolve; received?.(); });
      await route.fulfill({ response });
    });
    const delay = () => { delayed = true; return new Promise<void>(resolve => { received = resolve; }); };
    const first = delay();
    await row(page, gitPane.workspace_id).focus(); await page.keyboard.press('Shift+F10'); await first;
    await page.keyboard.press('ArrowDown');
    const close = page.getByRole('menuitem', { name: 'CLOSE WORKSPACE', exact: true });
    await expect(close).toBeFocused(); const closeNode = await close.elementHandle();
    release!(); release = undefined;
    await expect(page.getByRole('menuitem', { name: 'NEW WORKTREE', exact: true })).toBeVisible();
    await expect(close).toBeFocused(); expect(await closeNode!.evaluate(node => node === document.activeElement)).toBe(true);
    expect(await terminal!.evaluate(node => node.isConnected)).toBe(true);
    await page.screenshot({ path: 'test-results/workspace-git-context.png' });
    await page.keyboard.press('Escape');

    const late = delay();
    await row(page, gitPane.workspace_id).click({ button: 'right' }); await late;
    await page.keyboard.press('Escape');
    await row(page, plain.workspace_id).focus(); await page.keyboard.press('Shift+F10');
    release!(); release = undefined;
    await expect(page.getByRole('menu')).toHaveAttribute('aria-label', 'WORKSPACE Outside Git');
    await expect(page.getByRole('menu')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(row(page, plain.workspace_id)).toBeFocused();

    const closed = delay();
    await row(page, gitPane.workspace_id).click({ button: 'right' }); await closed;
    await page.keyboard.press('Escape');
    release!(); release = undefined;
    await expect(page.getByRole('menu')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#host-toggle').click();
    await row(page, gitPane.workspace_id).focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'NEW WORKTREE', exact: true })).toBeVisible();
    const bounds = await page.getByRole('menu').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: 'test-results/workspace-git-context-mobile.png' });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
    await row(page, plain.workspace_id).click();
    await row(page, gitPane.workspace_id).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'NEW WORKTREE', exact: true }).click();
    await expect(page.locator('#worktree-branch')).toBeFocused(); await expect(page.locator('#worktree-cwd')).toHaveValue(repo);
    const checkout = join(runtime.directory, 'discovered checkout');
    await page.locator('#worktree-branch').fill('discovered-context'); await page.locator('#worktree-path').fill(checkout);
    await page.getByRole('button', { name: 'CREATE AND OPEN', exact: true }).click();
    await expect(page.locator('#worktrees-dialog')).toBeHidden(); await access(join(checkout, 'README.md'));
    expect((await exec('git', ['-C', checkout, 'branch', '--show-current'])).stdout.trim()).toBe('discovered-context');

    expect(errors).toEqual([]);
  } finally { release?.(); await runtime.close(); }
});
