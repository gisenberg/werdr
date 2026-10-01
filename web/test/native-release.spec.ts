import { test, expect } from '@playwright/test';
import { WebSocket, type RawData } from 'ws';
import { fixture } from './fixture';
import type { NativeLoginResponse, SocketTicketResponse, TerminalReleaseResponse } from '../shared/native-protocol';

let runtime: Awaited<ReturnType<typeof fixture>>;
test.beforeAll(async () => { runtime = await fixture(); });
test.afterAll(async () => { await runtime.close(); });

// Node fetch sends no Origin header, exactly like React Native fetch.
async function api(path: string, options: { session?: string; method?: string; data?: unknown } = {}) {
  const response = await fetch(runtime.url + path, {
    method: options.method ?? (options.data === undefined ? 'GET' : 'POST'),
    headers: { ...(options.data === undefined ? {} : { 'content-type': 'application/json' }), ...(options.session ? { authorization: `Bearer ${options.session}` } : {}) },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
async function nativeLogin(name: string) {
  const response = await api('/api/login', { data: { token: runtime.token, client: { kind: 'native', name } } });
  expect(response.status).toBe(200);
  return (response.body as NativeLoginResponse).session;
}
const ticket = async (session: string) => ((await api('/api/socket-ticket', { session, method: 'POST' })).body as SocketTicketResponse).ticket;
/** Opens a socket from a WebView-like origin and collects every message so assertions never miss an early frame. */
async function open(path: string) {
  const ws = new WebSocket(runtime.url.replace('http:', 'ws:') + path, { origin: 'file://' });
  const messages: any[] = [];
  ws.on('message', (data: RawData) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const next = async (type: string) => { await expect.poll(() => messages.some(message => message.type === type), { timeout: 15000 }).toBe(true); };
  return { ws, closed, next };
}
test('a backgrounded device releases only its own terminal controllers without closing its fleet socket', async () => {
  const phone = await nativeLogin('Release Phone'), tablet = await nativeLogin('Release Tablet');
  const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
  const other = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
  const attach = async (session: string, id: string) => open(`/ws/terminal?machine=local&pane=${id}&cols=80&rows=24&ticket=${await ticket(session)}`);
  const fleet = await open(`/ws/fleet?ticket=${await ticket(phone)}`);
  const phoneTerminal = await attach(phone, pane); await phoneTerminal.next('terminal.frame');
  const tabletTerminal = await attach(tablet, other); await tabletTerminal.next('terminal.frame');

  const response = await api('/api/terminals/release', { session: phone, method: 'POST' });
  expect(response.status).toBe(200);
  expect(response.body as TerminalReleaseResponse).toEqual({ released: 1 });
  expect(await phoneTerminal.closed).toBe(1000);
  // Another client can now attach without taking over, while unrelated sockets stay open.
  const browserLike = await attach(tablet, pane); await browserLike.next('terminal.frame');
  expect(fleet.ws.readyState).toBe(WebSocket.OPEN);
  expect(tabletTerminal.ws.readyState).toBe(WebSocket.OPEN);
  expect((await api('/api/terminals/release', { session: phone, method: 'POST' })).body).toEqual({ released: 0 });
  expect((await api('/api/terminals/release', { method: 'POST' })).status).toBe(403);
  for (const socket of [fleet, tabletTerminal, browserLike]) { socket.ws.close(); await socket.closed; }
  for (const session of [phone, tablet]) await api('/api/logout', { session, method: 'POST' });
});
