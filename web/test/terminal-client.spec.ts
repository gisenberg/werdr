import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { fixture } from './fixture.ts';

test('companion preserves mode transitions through the gateway without replacing the pinned runtime', async ({ request }) => {
  test.skip(!process.env.WERDR_TERMINAL_CLIENT_BIN, 'Set WERDR_TERMINAL_CLIENT_BIN to the built companion to verify pinned-runtime compatibility.');
  const runtime = await fixture();
  let socket: WebSocket | undefined;
  try {
    const login = await request.post(runtime.url + '/api/login', { headers: { Origin: runtime.url }, data: { token: runtime.token } });
    expect(login.ok()).toBe(true);
    const cookies = (await request.storageState()).cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const pane = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane.pane_id;
    const records: Record<string, any>[] = [];
    socket = new WebSocket(runtime.url.replace(/^http/, 'ws') + '/ws/terminal?' + new URLSearchParams({ machine: 'local', pane, cols: '80', rows: '24' }), { headers: { Origin: runtime.url, Cookie: cookies } });
    socket.on('message', bytes => records.push(JSON.parse(bytes.toString())));
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
    await expect.poll(() => records.some(record => record.type === 'terminal.frame')).toBe(true);
    const input = (command: string) => socket!.send(JSON.stringify({ type: 'terminal.input', text: command + '\n' }));
    const last = (type: string) => records.filter(record => record.type === type).at(-1);
    input("printf '\\033[?1000h\\033[?1006hMOUSE_%s\\n' READY");
    await expect.poll(() => last('terminal.mouse')?.enabled).toBe(true);
    input("printf '\\033[?1000l\\033[?1006l\\033[>31uKEYBOARD_%s\\n' READY");
    await expect.poll(() => last('terminal.mouse')?.enabled).toBe(false);
    await expect.poll(() => last('terminal.keyboard')?.flags).toBe(31);
    input("printf '\\033[<uKEYBOARD_%s\\n' RESET");
    await expect.poll(() => last('terminal.keyboard')?.flags).toBe(0);
    expect(records.filter(record => record.type === 'terminal.mouse').map(record => record.enabled)).toEqual([false, true, false]);
    expect(records.filter(record => record.type === 'terminal.keyboard').map(record => record.flags)).toEqual([0, 31, 0]);
    expect(records.some(record => record.type === 'terminal.closed')).toBe(false);
    socket.close();
    await new Promise<void>(resolve => socket!.once('close', () => resolve()));
    expect(await runtime.cli('pane', 'read', pane)).toContain('KEYBOARD_RESET');
  } finally {
    socket?.terminate();
    await runtime.close();
  }
});
