import { test, expect } from '@playwright/test';
import { fixture } from './fixture';
import { WebSocket } from 'ws';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime?.close(); });

test('auth, native controls, terminal input, mobile layout and gateway restart preserve the shell', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  expect((await request.get(`${runtime.url}/api/machines`)).status()).toBe(401);
  expect((await request.post(`${runtime.url}/api/login`, { headers: { Origin: 'https://untrusted.invalid' }, data: { token: runtime.token } })).status()).toBe(403);
  await page.goto(runtime.url);
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#token').fill(runtime.token);
  await page.getByRole('button', { name: '[ENTER] CONNECT', exact: true }).click();
  await expect(page.locator('#login')).not.toBeVisible();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.locator('#shield')).toBeHidden();
  const initial = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot;
  const pane = initial.panes[0].pane_id;
  const terminalId = initial.panes[0].terminal_id;
  await page.locator('textarea').focus();
  await page.keyboard.type("export WERDR_TEST_VALUE=alive; printf 'WERDR_%s\\n' LIVE_OK");
  await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('WERDR_LIVE_OK');
  await page.keyboard.insertText("printf 'UNICODE_%s\\n' '羊🐑'"); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('UNICODE_羊🐑');
  await page.reload();
  await expect(page.locator('#shield')).toBeHidden();
  await page.locator('textarea').focus();
  await page.keyboard.type('printf "STATE_%s\\n" "$WERDR_TEST_VALUE"'); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('STATE_alive');
  await page.getByRole('button', { name: '[|] SPLIT', exact: true }).click();
  await expect(page.locator('#panes button')).toHaveCount(2);
  await page.getByRole('button', { name: '[+] TAB', exact: true }).click();
  await expect(page.locator('#tabs button')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rail')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '[H] HOSTS', exact: true }).click();
  await expect(page.locator('#rail')).toBeVisible();
  await page.getByRole('button', { name: '[H] HOSTS', exact: true }).click();
  await page.screenshot({ path: 'test-results/mobile.png' });
  await runtime.restartGateway();
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#token').fill(runtime.token);
  await page.getByRole('button', { name: '[ENTER] CONNECT', exact: true }).click();
  await expect(page.locator('#shield')).toBeHidden();
  expect(JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.find((p: any) => p.pane_id === pane).terminal_id).toBe(terminalId);
  await page.locator('textarea').focus(); await page.keyboard.type('printf "AFTER_%s\\n" "$WERDR_TEST_VALUE"'); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('AFTER_alive');
  expect(errors).toEqual([]);
});

test('a second viewer cannot take ownership unless explicitly requested', async ({ request }) => {
  const result = await request.post(`${runtime.url}/api/login`, { headers: { Origin: runtime.url }, data: { token: runtime.token } });
  const cookie = result.headers()['set-cookie'].split(';')[0];
  const { root_pane } = JSON.parse(await runtime.cli('workspace', 'create')).result;
  const url = runtime.url.replace('http:', 'ws:') + `/ws/terminal?machine=local&pane=${root_pane.pane_id}&cols=80&rows=24`;
  const opened: WebSocket[] = [];
  const connect = (takeover = false) => {
    const socket = new WebSocket(url + (takeover ? '&takeover=1' : ''), { headers: { Cookie: cookie, Origin: runtime.url } });
    opened.push(socket);
    const closed = new Promise<number>(done => socket.once('close', done));
    const frame = new Promise<void>((done, reject) => {
      socket.on('message', data => { if (JSON.parse(data.toString()).type === 'terminal.frame') done(); });
      socket.once('error', reject);
    });
    return { socket, closed, frame };
  };
  try {
    const first = connect(); await first.frame;
    const second = connect(); await second.closed;
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    const replacement = connect(true); await replacement.frame; await first.closed;
    replacement.socket.send(JSON.stringify({ type: 'terminal.input', text: "printf 'OWNER_%s\\n' CHANGED\r" }));
    await expect.poll(() => runtime.cli('pane', 'read', root_pane.pane_id, '--source', 'recent')).toContain('OWNER_CHANGED');
    replacement.socket.close(); await replacement.closed;
    expect(JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes.some((p: any) => p.pane_id === root_pane.pane_id)).toBe(true);
  } finally { for (const socket of opened) socket.terminate(); }
});

test('websocket authority rejects foreign origins and logout revokes attached sockets', async ({ request }) => {
  const result = await request.post(`${runtime.url}/api/login`, { headers: { Origin: runtime.url }, data: { token: runtime.token } });
  const cookie = result.headers()['set-cookie'].split(';')[0];
  const pane = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes[0].pane_id;
  const url = runtime.url.replace('http:', 'ws:') + `/ws/terminal?machine=local&pane=${pane}&cols=80&rows=24`;
  await new Promise<void>((done, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } });
    ws.on('open', () => { ws.close(); reject(new Error('Foreign origin accepted')); }); ws.on('error', () => done());
  });
  const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: runtime.url } });
  await new Promise<void>((done, reject) => { ws.once('open', done); ws.once('error', reject); });
  const closed = new Promise<number>(done => ws.once('close', code => done(code)));
  await request.post(`${runtime.url}/api/logout`, { headers: { Origin: runtime.url, Cookie: cookie }, data: {} });
  expect(await closed).toBe(1008);
  expect((await request.get(`${runtime.url}/api/machines`, { headers: { Cookie: cookie } })).status()).toBe(401);
});
