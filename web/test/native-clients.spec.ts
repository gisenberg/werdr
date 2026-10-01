import { test, expect } from '@playwright/test';
import { WebSocket, type ClientOptions, type RawData } from 'ws';
import { request as httpRequest } from 'node:http';
import { fixture } from './fixture';
import { NATIVE_PROTOCOL_VERSION, type NativeLoginResponse, type SocketTicketResponse } from '../shared/native-protocol';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(true); });
test.afterAll(async () => { await runtime.close(); });

// Node fetch sends no Origin header, exactly like React Native fetch.
async function api(path: string, options: { session?: string; method?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(runtime.url + path, {
    method: options.method ?? (options.data === undefined ? 'GET' : 'POST'),
    headers: { ...(options.data === undefined ? {} : { 'content-type': 'application/json' }), ...(options.session ? { authorization: `Bearer ${options.session}` } : {}), ...options.headers },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined) };
}
// fetch cannot override Host, so foreign-Host probes use node:http directly.
function foreignHostStatus(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(runtime.url + path, { headers: { ...headers, host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on('error', reject); request.end();
  });
}
async function nativeLogin(name: string, credentials: object = { token: runtime.token }) {
  const response = await api('/api/login', { data: { ...credentials, client: { kind: 'native', name } } });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  const body = response.body as NativeLoginResponse;
  expect(body.ok).toBe(true); expect(body.session).toMatch(/^[a-f0-9]{64}$/);
  return body.session;
}
async function ticket(session: string) {
  const response = await api('/api/socket-ticket', { session, method: 'POST' });
  expect(response.status).toBe(200);
  const body = response.body as SocketTicketResponse;
  expect(body.expiresInSeconds).toBe(30); expect(body.ticket).toMatch(/^[a-f0-9]{64}$/);
  return body.ticket;
}
const wsUrl = (path: string) => runtime.url.replace('http:', 'ws:') + path;
/** Opens a socket and collects every message so assertions never miss an early frame. */
async function open(path: string, options: ClientOptions = {}) {
  const ws = new WebSocket(wsUrl(path), options);
  const messages: any[] = [];
  ws.on('message', (data: RawData) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const next = async (type: string) => { await expect.poll(() => messages.some(message => message.type === type), { timeout: 15000 }).toBe(true); return messages.find(message => message.type === type); };
  return { ws, closed, next };
}
async function rejected(path: string, options: ClientOptions = {}) {
  const ws = new WebSocket(wsUrl(path), options);
  return new Promise<boolean>(resolve => { ws.once('open', () => { ws.terminate(); resolve(false); }); ws.once('error', () => resolve(true)); });
}

test('native clients sign in with device sessions, use bearer auth, and open sockets with single-use tickets', async ({ browser }) => {
  // Protocol discovery is public but still Host-checked.
  const protocol = await api('/api/protocol');
  expect(protocol.status).toBe(200);
  expect(protocol.body).toEqual({ gateway: 'werdr', protocolVersion: NATIVE_PROTOCOL_VERSION, nativeClients: true });
  expect(await foreignHostStatus('/api/protocol')).toBe(403);

  // Native sign-in is Origin-free and validates the device descriptor.
  expect((await api('/api/login', { data: { token: runtime.token, client: { kind: 'native', name: 'Phone' } }, headers: { origin: runtime.url } })).status).toBe(400);
  expect((await api('/api/login', { data: { token: runtime.token, client: { kind: 'native', name: 'bad\nname' } } })).status).toBe(400);
  expect((await api('/api/login', { data: { token: runtime.token, client: { kind: 'browser', name: 'Phone' } } })).status).toBe(400);
  expect((await api('/api/login', { data: { token: runtime.token } })).status).toBe(403);
  expect((await api('/api/login', { data: { token: 'invalid', client: { kind: 'native', name: 'Phone' } } })).status).toBe(401);
  const session = await nativeLogin('Test Phone');
  const passwordSession = await nativeLogin('Test Tablet', { username: runtime.username, password: runtime.password });

  // Bearer authentication works on every API route without an Origin.
  expect((await api('/api/protocol', { session })).status).toBe(200);
  const fleet = await api('/api/fleet', { session });
  expect(fleet.status).toBe(200); expect(fleet.body.hosts.length).toBeGreaterThan(0);
  expect((await api('/api/session', { session })).body).toEqual({ canGenerateToken: false });
  expect((await api('/api/session', { session: passwordSession })).body).toEqual({ canGenerateToken: true });
  const listed = (await api('/api/sessions', { session })).body.sessions;
  expect(listed.find((entry: any) => entry.current)).toMatchObject({ kind: 'native', client: 'Test Phone', method: 'token' });
  expect((await api('/api/notices/read', { session, data: {} })).status).toBe(200);
  expect((await api('/api/fleet', { session: 'f'.repeat(64) })).status).toBe(401);
  expect(await foreignHostStatus('/api/fleet', { authorization: `Bearer ${session}` })).toBe(403);
  expect((await api('/api/fleet', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })).status).toBe(401);
  expect((await api('/api/notices/read', { data: {}, headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  // A browser Origin with bearer authentication is never accepted.
  expect((await api('/api/fleet', { session, headers: { origin: runtime.url } })).status).toBe(400);
  expect((await api('/api/socket-ticket', { session, method: 'POST', headers: { origin: runtime.url } })).status).toBe(400);
  expect((await api('/api/socket-ticket', { method: 'POST' })).status).toBe(403);

  // A ticket opens the fleet socket once, without a cookie or Origin.
  const fleetTicket = await ticket(session);
  const fleetSocket = await open(`/ws/fleet?ticket=${fleetTicket}`);
  expect((await fleetSocket.next('fleet.snapshot')).state.hosts.length).toBeGreaterThan(0);
  fleetSocket.ws.send(JSON.stringify({ type: 'fleet.resync' }));
  expect(await rejected(`/ws/fleet?ticket=${fleetTicket}`)).toBe(true);
  expect(await rejected(`/ws/fleet?ticket=${'0'.repeat(64)}`)).toBe(true);
  expect(await rejected('/ws/fleet?ticket=')).toBe(true);
  expect(await rejected('/ws/fleet')).toBe(true);
  // Foreign http(s) origins are rejected, and the presented ticket is burned.
  const foreignTicket = await ticket(session);
  expect(await rejected(`/ws/fleet?ticket=${foreignTicket}`, { origin: 'http://foreign.invalid' })).toBe(true);
  expect(await rejected(`/ws/fleet?ticket=${foreignTicket}`)).toBe(true);
  // Local WebView origins and the exact gateway origin are accepted.
  for (const origin of ['null', 'file://', runtime.url]) {
    const socket = await open(`/ws/fleet?ticket=${await ticket(session)}`, { origin });
    await socket.next('fleet.snapshot'); socket.ws.close(); await socket.closed;
  }
  // A ticket cannot select another Host.
  expect(await rejected(`/ws/fleet?ticket=${await ticket(session)}`, { headers: { host: 'foreign.invalid' } })).toBe(true);

  // Terminal sockets attach with a ticket too.
  const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
  const terminal = await open(`/ws/terminal?machine=local&pane=${pane}&cols=80&rows=24&ticket=${await ticket(session)}`, { origin: 'file://' });
  expect((await terminal.next('terminal.frame')).width).toBe(80);
  terminal.ws.send(JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 30 }));

  // Revoking the device from a browser closes its sockets and its bearer credential.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    expect((await context.request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { username: runtime.username, password: runtime.password } })).ok()).toBe(true);
    // Browser POSTs still require the exact Origin.
    expect((await context.request.post(runtime.url + '/api/socket-ticket', { headers: { Origin: 'null' } })).status()).toBe(403);
    const browserTicket = await context.request.post(runtime.url + '/api/socket-ticket', { headers: { Origin: runtime.url } });
    expect(browserTicket.ok()).toBe(true);
    const page = await context.newPage(); await page.goto(runtime.url); await expect(page.locator('#boot')).toBeHidden();
    await page.getByRole('button', { name: 'SESSIONS', exact: true }).click();
    const phone = page.locator('.session-row').filter({ hasText: 'Test Phone' });
    await expect(phone).toContainText('[NATIVE DEVICE]');
    await expect(page.locator('.session-row').filter({ hasText: 'Test Tablet' })).toContainText('[NATIVE DEVICE]');
    await expect(page.locator('.session-row').filter({ hasText: '[THIS BROWSER]' })).toHaveCount(1);
    await page.screenshot({ path: 'test-results/native-sessions.png' });
    const unusedTicket = await ticket(session);
    await phone.getByRole('button', { name: 'REVOKE', exact: true }).click();
    expect(await fleetSocket.closed).toBe(1008);
    expect(await terminal.closed).toBe(1008);
    await expect(phone).toHaveCount(0);
    expect((await api('/api/fleet', { session })).status).toBe(401);
    expect((await api('/api/socket-ticket', { session, method: 'POST' })).status).toBe(401);
    expect(await rejected(`/ws/fleet?ticket=${unusedTicket}`)).toBe(true);
    expect((await api('/api/fleet', { session: passwordSession })).status).toBe(200);

    // Bearer logout revokes only that device session.
    const tabletSocket = await open(`/ws/fleet?ticket=${await ticket(passwordSession)}`);
    expect((await api('/api/logout', { session: passwordSession, method: 'POST' })).status).toBe(200);
    expect(await tabletSocket.closed).toBe(1008);
    expect((await api('/api/session', { session: passwordSession })).status).toBe(401);
    expect((await context.request.get(runtime.url + '/api/session')).ok()).toBe(true);

    // Access-token rotation closes native sessions issued from the old token.
    const rotated = await nativeLogin('Rotated Phone');
    const rotatedSocket = await open(`/ws/fleet?ticket=${await ticket(rotated)}`);
    expect((await context.request.post(runtime.url + '/api/token/revoke', { headers: { Origin: runtime.url }, data: {} })).ok()).toBe(true);
    expect(await rotatedSocket.closed).toBe(1008);
    expect((await api('/api/fleet', { session: rotated })).status).toBe(401);
  } finally { await context.close(); }
});
