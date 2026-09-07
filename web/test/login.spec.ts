import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { consoleInput } from './console-helpers';
import { fixture } from './fixture';
let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(true); });
test.afterAll(async () => { await runtime.close(); });

test('startup fills desktop and mobile, changes profiles, and has no settings or prompts', async ({ page }) => {
  await page.goto(runtime.url);
  await expect(page.locator('#boot')).toBeVisible();
  expect(await page.locator('#boot').boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  const first = await page.evaluate(() => localStorage.getItem('werdr-last-boot'));
  await page.screenshot({ path: 'test-results/boot-desktop.png' });
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  await expect(page.locator('#boot-profile')).toHaveCount(0);
  await expect(page.getByText('BOOT SCREEN', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('#boot')).toBeVisible();
  expect(await page.locator('#boot').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(await page.evaluate(() => localStorage.getItem('werdr-last-boot'))).not.toBe(first);
  await page.screenshot({ path: 'test-results/boot-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: 'test-results/login-mobile.png' });
});

test('password login generates a persistent replacement token with credential-only authority', async ({ page, request }) => {
  const headers = { Origin: runtime.url };
  expect((await request.post(`${runtime.url}/api/token`, { headers, data: {} })).status()).toBe(401);
  expect((await request.post(`${runtime.url}/api/login`, { headers: { Origin: 'http://foreign.invalid' }, data: { username: runtime.username, password: runtime.password } })).status()).toBe(403);
  const tokenLogin = await request.post(`${runtime.url}/api/login`, { headers, data: { token: runtime.token } });
  const oldCookie = tokenLogin.headers()['set-cookie'].split(';')[0];
  expect((await request.post(`${runtime.url}/api/token`, { headers: { ...headers, Cookie: oldCookie }, data: {} })).status()).toBe(403);
  const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
  const ws = new WebSocket(runtime.url.replace('http:', 'ws:') + `/ws/terminal?machine=local&pane=${pane}&cols=80&rows=24`, { headers: { ...headers, Cookie: oldCookie } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  try {
  await page.goto(runtime.url);
  await consoleInput(page, 'username', runtime.username);
  await consoleInput(page, 'password', 'incorrect');
  await expect(page.locator('#login-error')).toContainText('Invalid credentials');
  await consoleInput(page, 'username', runtime.username);
  await consoleInput(page, 'password', runtime.password);
  await expect(page.locator('#boot')).not.toBeVisible();
  await page.getByRole('button', { name: 'ACCESS TOKEN', exact: true }).click();
  await page.getByRole('button', { name: 'GENERATE TOKEN', exact: true }).click();
  await expect(page.locator('#generated-token')).toHaveValue(/^[0-9a-f]{64}$/);
  const token = await page.locator('#generated-token').inputValue();
  expect(token).not.toBe(runtime.token);
  expect(await closed).toBe(1008);
  await page.getByRole('button', { name: 'DONE', exact: true }).click();
  await expect(page.locator('#generated-token')).toHaveValue('');
  expect((await request.get(`${runtime.url}/api/session`, { headers: { Cookie: oldCookie } })).status()).toBe(401);
  expect((await request.post(`${runtime.url}/api/login`, { headers, data: { token: runtime.token } })).status()).toBe(401);
  await runtime.restartGateway();
  await page.reload();
  await page.getByRole('button', { name: 'USE ACCESS TOKEN', exact: true }).click();
  await consoleInput(page, 'token', token);
  await expect(page.locator('#boot')).not.toBeVisible();
  await expect(page.locator('#access-token')).toBeHidden();
  expect(await page.evaluate(value => Object.values(localStorage).includes(value), token)).toBe(false);
  await page.getByRole('button', { name: '[X] SIGN OUT', exact: true }).click();
  await expect(page.locator('#boot')).toHaveAttribute('data-stage', 'username');
  } finally { ws.terminate(); }
});


test('network login throttling rejects excessive attempts and never trusts forwarded peer headers', async ({ request }) => {
  let response;
  for (let attempt = 0; attempt < 11; attempt++) response = await request.post(`${runtime.url}/api/login`, {
    headers: { Origin: runtime.url, 'X-Forwarded-For': `10.0.0.${attempt + 1}` }, data: { token: 'invalid' },
  });
  expect(response!.status()).toBe(429);
  expect(response!.headers()['retry-after']).toBe('60');
});


test('BIOS memory count overwrites its row and the display retains its native framebuffer shape', async ({ page }) => {
  await page.addInitScript(() => { localStorage.removeItem('werdr-last-boot'); Math.random = () => 3.1 / 36; });
  await page.goto(runtime.url);
  await expect(page.locator('#boot-output')).toContainText('Keyboard');
  const text = await page.locator('#boot-output').textContent();
  expect(text).toContain('016384 KB OK');
  expect(text!.match(/KB OK/g)).toHaveLength(1);
  const box = await page.locator('#boot-frame').boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(720 / 400, 2);
  await page.screenshot({ path: 'test-results/boot-bios.png' });
});
