import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.use({ ignoreHTTPSErrors: true }); // Isolated, self-signed fixture only.
test.beforeAll(async () => { runtime = await fixture(true, true); });
test.afterAll(async () => { await runtime.close(); });

test('HTTPS login uses secure cookies and WSS while rejecting plaintext origins', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(runtime.url);
  await consoleInput(page, 'username', runtime.username);
  await consoleInput(page, 'password', runtime.password);
  await expect(page.locator('#boot')).not.toBeVisible();
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === 'werdr')!;
  expect(cookie.secure).toBe(true); expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Strict');
  const denied = await page.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url.replace('https:', 'http:') }, data: { token: runtime.token } });
  expect(denied.status()).toBe(403);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.locator('#shield')).toBeHidden();
  const pane = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot.panes[0].pane_id;
  await page.locator('#terminal textarea').focus(); await page.keyboard.insertText("printf 'TLS_TERMINAL_OK\\n'"); await page.keyboard.press('Enter');
  await expect.poll(() => runtime.cli('pane', 'read', pane, '--source', 'recent')).toContain('TLS_TERMINAL_OK');
  const ws = new WebSocket(runtime.url.replace('https:', 'wss:') + `/ws/terminal?machine=local&pane=${pane}&cols=80&rows=24`, {
    ca: runtime.certificate, headers: { Origin: runtime.url.replace('https:', 'http:'), Cookie: `werdr=${cookie.value}` },
  });
  await new Promise<void>((resolve, reject) => { ws.once('error', () => resolve()); ws.once('open', () => { ws.terminate(); reject(new Error('Plaintext Origin accepted over TLS')); }); });
  await page.getByRole('button', { name: '[X] SIGN OUT', exact: true }).click();
  expect((await page.context().cookies()).some(cookie => cookie.name === 'werdr')).toBe(false);
});
