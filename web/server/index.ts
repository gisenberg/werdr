import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { actionArgs, command, machines, publicId, resolveMachine, terminalProcess } from './herdr.ts';
import { allowedBind, allowedHttpOrigins, requestOrigin, dimension, equalToken, terminalInput } from './policy.ts';
import { NdjsonDecoder } from './ndjson.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.WERDR_HOST || '127.0.0.1';
const port = Number(process.env.WERDR_PORT || 3480);
if (!allowedBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WERDR_HOST must be a private IP literal; WERDR_PORT must be valid');
const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
const allowedOrigins = allowedHttpOrigins(host, port, process.env.WERDR_ALLOWED_HOSTS);
const tokenPath = resolve(root, process.env.WERDR_TOKEN_FILE || '.auth-token');
await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
catch (error: any) { if (error.code !== 'EEXIST') throw error; }
const tokenStat = await stat(tokenPath);
if (process.platform !== 'win32' && (tokenStat.mode & 0o077)) throw new Error('Token file must be owner-only (chmod 600)');
const token = (await readFile(tokenPath, 'utf8')).trim();
if (token.length < 32) throw new Error('Token must contain at least 32 characters');
const sessions = new Map<string, number>();
const sockets = new Map<WebSocket, string>();
const controllers = new Map<WebSocket, () => void>();
const alive = new WeakSet<WebSocket>();
function closeSocket(ws: WebSocket, code: number, reason?: string) {
  controllers.get(ws)?.();
  ws.close(code, reason);
}
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
function session(req: IncomingMessage): string | undefined {
  const id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('werdr='))?.slice(6);
  return id && (sessions.get(id) ?? 0) > Date.now() ? id : undefined;
}
function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json') throw new Error('Expected JSON');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value;
}
let requests = 0;
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const browserOrigin = requestOrigin(req.headers.host, req.headers.origin, allowedOrigins);
  if (!browserOrigin) return reply(res, 403, { error: 'Origin rejected' });
  if (++requests > 16) { requests--; return reply(res, 503, { error: 'Busy' }); }
  try {
    const url = new URL(req.url || '/', browserOrigin);
    if (req.method === 'POST' && req.headers.origin !== browserOrigin) return reply(res, 403, { error: 'Origin required' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const value = await body(req);
      if (typeof value.token !== 'string' || !equalToken(value.token, token)) return reply(res, 401, { error: 'Invalid access token' });
      if (sessions.size >= 64) return reply(res, 503, { error: 'Session limit reached' });
      const id = randomBytes(32).toString('hex'); sessions.set(id, Date.now() + 12 * 3600_000);
      res.setHeader('Set-Cookie', `werdr=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return reply(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      const id = session(req);
      if (!id) return reply(res, 401, { error: 'Sign in required' });
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        sessions.delete(id);
        for (const [ws, owner] of sockets) if (owner === id) closeSocket(ws, 1008, 'Signed out');
        res.setHeader('Set-Cookie', 'werdr=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/api/machines' && req.method === 'GET') return reply(res, 200, { machines: await machines() });
      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        const machine = await resolveMachine(publicId(url.searchParams.get('machine')));
        return reply(res, 200, await command(machine, ['api', 'snapshot']));
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const value = await body(req); const args = actionArgs(value);
        return reply(res, 200, await command(await resolveMachine(publicId(value.machine)), args));
      }
      return reply(res, 404, { error: 'Unknown route' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Method not allowed' });
    const path = resolve(root, 'dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(resolve(root, 'dist') + sep)) return reply(res, 404, { error: 'Not found' });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
    let data: Buffer;
    try { data = await readFile(path); } catch { return reply(res, 404, { error: 'Not found' }); }
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) reply(res, 502, { error: 'Herdr request failed. Check the gateway log and host availability.' });
  } finally { requests--; }
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
let upgrades = 0;
server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const id = session(req);
  const browserOrigin = requestOrigin(req.headers.host, req.headers.origin, allowedOrigins);
  if (!id || !browserOrigin || req.headers.origin !== browserOrigin || sockets.size + upgrades >= 16) { socket.destroy(); return; }
  upgrades++;
  try {
    const url = new URL(req.url || '/', origin);
    if (url.pathname !== '/ws/terminal') throw new Error('Unknown socket');
    const machine = await resolveMachine(publicId(url.searchParams.get('machine')));
    const pane = publicId(url.searchParams.get('pane'));
    const cols = dimension(Number(url.searchParams.get('cols'))), rows = dimension(Number(url.searchParams.get('rows')));
    if (socket.destroyed || !session(req)) { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, ws => {
      sockets.set(ws, id);
      alive.add(ws); ws.on('pong', () => alive.add(ws));
      const child = terminalProcess(machine, pane, cols, rows, url.searchParams.get('takeover') === '1');
      const decoder = new NdjsonDecoder();
      let ended = false, released = false;
      const startup = setTimeout(() => closeSocket(ws, 1011, 'Terminal controller timed out'), 15000);
      startup.unref();
      controllers.set(ws, () => {
        if (ended || released) return;
        released = true; clearTimeout(startup);
        child.stdin.end('{"type":"terminal.release"}\n');
        const terminate = setTimeout(() => { if (!ended) child.kill(); }, 1000);
        const kill = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 2000);
        terminate.unref(); kill.unref();
      });
      const send = (value: unknown) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 4 * 1024 * 1024) { closeSocket(ws, 1013, 'Viewer too slow'); return; }
        ws.send(JSON.stringify(value));
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (released || ended) return;
        try {
          decoder.push(chunk, frame => {
            if (frame.type === 'terminal.frame') clearTimeout(startup);
            send(frame);
          });
        } catch { closeSocket(ws, 1011, 'Invalid or oversized Herdr frame'); }
      });
      // Drain stderr without forwarding remote command diagnostics to browser payloads.
      child.stderr.on('data', () => {});
      child.on('error', () => { ended = true; clearTimeout(startup); send({ type: 'terminal.closed', reason: 'Cannot launch Herdr terminal controller' }); closeSocket(ws, 1011); });
      child.stdin.on('error', () => closeSocket(ws, 1011));
      child.on('exit', code => { ended = true; clearTimeout(startup); send({ type: 'terminal.closed', reason: code ? 'Controller unavailable or terminal already owned. Use Take control to replace its owner.' : 'Terminal detached' }); closeSocket(ws, 1000); });
      ws.on('message', (data, binary) => {
        try {
          if (!session(req) || binary || released || ended) throw new Error('Invalid input');
          const value = terminalInput(JSON.parse(data.toString()));
          if (child.stdin.writableLength > 65536) throw new Error('Input queue full');
          child.stdin.write(JSON.stringify(value) + '\n');
        } catch { closeSocket(ws, 1008, 'Invalid terminal command'); }
      });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        sockets.delete(ws);
        controllers.get(ws)?.(); controllers.delete(ws);
      });
    });
  } catch { socket.destroy(); }
  finally { upgrades--; }
});
const cleanup = setInterval(() => {
  for (const [id, expiry] of sessions) if (expiry <= Date.now()) {
    sessions.delete(id);
    for (const [ws, owner] of sockets) if (owner === id) closeSocket(ws, 1008, 'Session expired');
  }
  for (const ws of sockets.keys()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!alive.has(ws)) { controllers.get(ws)?.(); ws.terminate(); }
    else { alive.delete(ws); ws.ping(); }
  }
}, 30_000);
cleanup.unref();
function shutdown() {
  for (const ws of sockets.keys()) closeSocket(ws, 1001, 'Gateway restarting');
  server.close(); clearInterval(cleanup);
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(port, host, () => console.log(`werdr: ${origin}\nAccess-token file: ${tokenPath}`));
