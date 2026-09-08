import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tlsConfiguration } from './tls.ts';
import { createServer, type RequestListener, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { sessionStore, SESSION_SECONDS } from './sessions.ts';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { command, companionCommand, CompanionCommandError, publicId, resolveMachine, terminalProcess } from './herdr.ts';
import { allowedBind, allowedHttpOrigins, requestOrigin, dimension, terminalInput } from './policy.ts';
import { TerminalInputWriter } from './terminal-input-writer.ts';
import { MAX_CLIPBOARD_IMAGE_BYTES } from '../shared/clipboard-image.ts';
import { NdjsonDecoder } from './ndjson.ts';
import { authentication, LoginLimiter } from './auth.ts';
import { bootArtwork } from './boot-artwork.ts';
import { bootFonts } from './boot-fonts.ts';
import { Fleet } from './fleet.ts';
import { MachineManagement, ManagementError } from './machine-management.ts';
import { browserLayout } from './layout.ts';
import { activatePaneLink } from './link-actions.ts';
import { browserAction } from './browser-actions.ts';
import { copyContext, copyReadActions } from './copy-actions.ts';
import { openScrollbackEditor, paneExists } from './scrollback-editor.ts';
import { pluginAction } from './plugin-actions.ts';
import { settingsStore, SettingsConflict } from './settings.ts';
import { SettingsValidationError } from '../shared/settings.ts';
import { NativeApiError } from './native-api.ts';
import type { FleetEvent } from '../shared/fleet.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.WERDR_HOST || '127.0.0.1';
const port = Number(process.env.WERDR_PORT || 3480);
if (!allowedBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WERDR_HOST must be a private IP literal; WERDR_PORT must be valid');
const tls = await tlsConfiguration(process.env.WERDR_CERT_FILE, process.env.WERDR_KEY_FILE);
const scheme = tls ? 'https' : 'http';
const origin = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
const allowedOrigins = allowedHttpOrigins(host, port, process.env.WERDR_ALLOWED_HOSTS, scheme);
const tokenPath = resolve(root, process.env.WERDR_TOKEN_FILE || '.auth-token');
const auth = await authentication(tokenPath, process.env.WERDR_CREDENTIALS_FILE ? resolve(root, process.env.WERDR_CREDENTIALS_FILE) : undefined);
const fonts = await bootFonts(process.env.WERDR_BOOT_FONT_DIR);
const artwork = await bootArtwork(process.env.WERDR_BOOT_ASSET_DIR);
const loginLimiter = new LoginLimiter();
let passwordChecks = 0;
const sessions = await sessionStore(process.env.WERDR_SESSION_FILE || resolve(dirname(tokenPath), 'browser-sessions.json'));
const settings = await settingsStore(process.env.WERDR_SETTINGS_FILE || resolve(dirname(tokenPath), 'browser-settings.json'));
const sessionTokens = new Map<string, string>();
const fleet = new Fleet(() => management.catalog(), process.env.WERDR_NOTIFICATION_FILE || resolve(dirname(tokenPath), 'fleet-notifications.json'));
const management = new MachineManagement(process.env.WERDR_MACHINE_PLATFORM_FILE || resolve(dirname(tokenPath), 'machine-platforms.json'), async () => { await fleet.reloadCatalog(); for (const host of fleet.state().hosts) if (host.machine.enabled) fleet.retry(host.machine.id); });
await management.start();
fleet.on('diagnostic', error => console.error(error.message));
await fleet.start();
const sockets = new Map<WebSocket, string>();
const terminalMachines = new Map<WebSocket, { id: string; target?: string; session?: string }>();
const controllers = new Map<WebSocket, () => void>();
const alive = new WeakSet<WebSocket>();
function closeSocket(ws: WebSocket, code: number, reason?: string) {
  controllers.get(ws)?.();
  ws.close(code, reason);
}
function disconnectSessions(ids: string[], reason: string) {
  management.revoke(ids);
  for (const [ws, owner] of sockets) if (ids.includes(owner)) closeSocket(ws, 1008, reason);
}
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
const terminalWsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIPBOARD_IMAGE_BYTES, perMessageDeflate: false });
function session(req: IncomingMessage) {
  const id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('werdr='))?.slice(6);
  return sessions.get(id, auth.tokenVersion);
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
async function authorizedBody(req: IncomingMessage) {
  const value = await body(req);
  if (!session(req)) throw new ManagementError('Sign in required', 401);
  return value;
}
let requests = 0;
const handler: RequestListener = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const browserOrigin = requestOrigin(req.headers.host, req.headers.origin, allowedOrigins, scheme);
  if (!browserOrigin) return reply(res, 403, { error: 'Origin rejected' });
  if (++requests > 16) { requests--; return reply(res, 503, { error: 'Busy' }); }
  try {
    const url = new URL(req.url || '/', browserOrigin);
    if (req.method === 'POST' && req.headers.origin !== browserOrigin) return reply(res, 403, { error: 'Origin required' });
    if (url.pathname === '/api/auth' && req.method === 'GET') return reply(res, 200, { passwordEnabled: auth.passwordEnabled });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!loginLimiter.take(req.socket.remoteAddress || 'unknown')) {
        res.setHeader('Retry-After', '60'); return reply(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.' });
      }
      const value = await body(req);
      const method = value.token === undefined ? 'password' : 'token';
      let valid = false;
      if (method === 'password') {
        if (passwordChecks >= 4) return reply(res, 503, { error: 'Sign-in busy. Try again shortly.' });
        passwordChecks++;
        try { valid = await auth.verifyPassword(value.username, value.password); } finally { passwordChecks--; }
      } else valid = auth.verifyToken(value.token);
      if (!valid) return reply(res, 401, { error: 'Invalid credentials' });
      const id = await sessions.create(method, req.headers['user-agent'] || 'Unknown browser', auth.tokenVersion);
      res.setHeader('Set-Cookie', `werdr=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${tls ? '; Secure' : ''}`);
      return reply(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      const id = session(req);
      if (!id) return reply(res, 401, { error: 'Sign in required' });
      if (url.pathname === '/api/session' && req.method === 'GET') return reply(res, 200, { canGenerateToken: id.method === 'password' });
      if (url.pathname === '/api/sessions' && req.method === 'GET') return reply(res, 200, { sessions: sessions.list(id.id, auth.tokenVersion) });
      if (url.pathname === '/api/sessions/revoke' && req.method === 'POST') {
        const value = await authorizedBody(req);
        if (value.others !== true && (typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id))) return reply(res, 400, { error: 'Expected a session ID or others=true' });
        if (!session(req)) return reply(res, 401, { error: 'Sign in required' });
        const revoked = await sessions.revoke(record => value.others === true ? record.id !== id.id : record.id === value.id);
        disconnectSessions(revoked, 'Session revoked');
        return reply(res, 200, { ok: true });
      }
      if ((url.pathname === '/api/token' || url.pathname === '/api/token/revoke') && req.method === 'POST') {
        if (id.method !== 'password') return reply(res, 403, { error: 'Sign in with your username and password to manage the access token.' });
        const token = await auth.rotateToken();
        // The persisted token fingerprint also invalidates sessions if shutdown
        // interrupts the two-file rotation between these durable writes.
        const revoked = await sessions.revoke(record => record.method === 'token' && record.tokenVersion !== auth.tokenVersion);
        disconnectSessions(revoked, 'Access token revoked');
        return reply(res, 200, url.pathname === '/api/token' ? { token } : { ok: true });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        disconnectSessions(await sessions.revoke(record => record.id === id.id), 'Signed out');
        res.setHeader('Set-Cookie', `werdr=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') return reply(res, 200, settings.read());
      if (url.pathname === '/api/settings' && req.method === 'POST') { const value = await authorizedBody(req); return reply(res, 200, await settings.update(value.revision, value.preferences)); }
      if (url.pathname === '/api/machines' && req.method === 'GET') return reply(res, 200, { machines: fleet.state().hosts.map(host => host.machine) });
      if (url.pathname === '/api/fleet' && req.method === 'GET') return reply(res, 200, fleet.state());
      if (url.pathname === '/api/hosts/edit' && req.method === 'POST') { await management.edit(await authorizedBody(req)); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/hosts/setup' && req.method === 'POST') return reply(res, 200, { job: await management.begin(id.id, await authorizedBody(req)) });
      if (url.pathname === '/api/setup/jobs' && req.method === 'GET') return reply(res, 200, { jobs: management.list(id.id) });
      if (url.pathname === '/api/setup/job' && req.method === 'GET') return reply(res, 200, { job: management.get(id.id, publicId(url.searchParams.get('id'))) });
      if (url.pathname === '/api/setup/input' && req.method === 'POST') { const value = await authorizedBody(req); management.input(id.id, publicId(value.id), value.input); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/setup/cancel' && req.method === 'POST') { const value = await authorizedBody(req); management.cancel(id.id, publicId(value.id)); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/hosts/retry' && req.method === 'POST') { const value = await authorizedBody(req); fleet.retry(publicId(value.id)); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/notices/read' && req.method === 'POST') { const value = await authorizedBody(req); await fleet.markNoticesRead(value.id === undefined ? undefined : publicId(value.id)); return reply(res, 200, { ok: true }); }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        const machine = await resolveMachine(publicId(url.searchParams.get('machine')));
        return reply(res, 200, await command(machine, ['api', 'snapshot']));
      }
      if (url.pathname === '/api/layout' && req.method === 'GET') {
        const result = await fleet.request(publicId(url.searchParams.get('machine')), 'layout.export', { tab_id: publicId(url.searchParams.get('tab')) }, false);
        return reply(res, 200, browserLayout(result));
      }
      if (url.pathname === '/api/runtime-settings' && req.method === 'GET') {
        const machine = await resolveMachine(publicId(url.searchParams.get('machine')));
        return reply(res, 200, await companionCommand(machine, ['config', 'runtime', 'read']));
      }
      if (url.pathname === '/api/runtime-settings' && req.method === 'POST') {
        const value = await authorizedBody(req);
        const machine = await resolveMachine(publicId(value.machine));
        return reply(res, 200, await companionCommand(machine, ['config', 'runtime', 'write'], { revision: value.revision, settings: value.settings }));
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const value = await authorizedBody(req);
        if (value.action === 'pane.link.activate') return reply(res, 200, await fleet.action(publicId(value.machine), request => activatePaneLink(value, request)));
        if (value.action === 'pane.copy_context') return reply(res, 200, await fleet.action(publicId(value.machine), request => copyContext(value, request)));
        if (value.action === 'pane.edit_scrollback') return reply(res, 200, await fleet.action(publicId(value.machine), request => openScrollbackEditor(value, request)));
        if (value.action === 'pane.exists') return reply(res, 200, await paneExists(value, (method, params) => fleet.request(publicId(value.machine), method, params, false)));
        if (typeof value.action === 'string' && value.action.startsWith('plugin.')) {
          const machine = publicId(value.machine);
          const read = ['plugin.list', 'plugin.action.list', 'plugin.log.list'].includes(value.action);
          const result = read
            ? await pluginAction(value, (method, params, invalidate) => fleet.request(machine, method, params, invalidate))
            : await fleet.action(machine, request => pluginAction(value, request));
          return reply(res, 200, result);
        }
        const { method, params } = browserAction(value);
        const machine = publicId(value.machine);
        const read = copyReadActions.has(method) || ['worktree.list', 'integration.list'].includes(method);
        return reply(res, 200, read ? await fleet.request(machine, method, params, false) : await fleet.action(machine, request => request(method, params, method !== 'pane.scroll')));
      }
      return reply(res, 404, { error: 'Unknown route' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/boot-assets/workbench13-bootscreen.gif' && artwork) {
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'private, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : artwork);
    }
    const font = fonts.get(url.pathname);
    if (font) {
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'private, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : font);
    }
    const path = resolve(root, 'dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(resolve(root, 'dist') + sep)) return reply(res, 404, { error: 'Not found' });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
    let data: Buffer;
    try { data = await readFile(path); } catch { return reply(res, 404, { error: 'Not found' }); }
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (!res.headersSent && error instanceof CompanionCommandError) return reply(res, error.status, { error: error.message });
    if (!res.headersSent && (error instanceof SettingsConflict || error instanceof SettingsValidationError)) return reply(res, error instanceof SettingsConflict ? 409 : 400, { error: error.message });
    if (!res.headersSent && (error instanceof ManagementError || error instanceof NativeApiError)) return reply(res, error instanceof ManagementError ? error.status : error.code === 'offline' ? 503 : 409, { error: error.message });
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) reply(res, 502, { error: 'Herdr request failed. Check the gateway log and host availability.' });
  } finally { requests--; }
};
const server = tls ? createHttpsServer(tls.options, handler) : createServer(handler);
let reloading = false;
const certificateTimer = tls ? setInterval(async () => {
  if (reloading) return;
  reloading = true;
  try { if (await tls.reload(server as HttpsServer)) console.log('TLS certificate reloaded'); }
  catch { console.error('TLS certificate reload failed; retaining the previous certificate'); }
  finally { reloading = false; }
}, 60_000) : undefined;
certificateTimer?.unref();
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
let upgrades = 0;
server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const id = session(req);
  const browserOrigin = requestOrigin(req.headers.host, req.headers.origin, allowedOrigins, scheme);
  if (!id || !browserOrigin || req.headers.origin !== browserOrigin || sockets.size + upgrades >= 64) { socket.destroy(); return; }
  upgrades++;
  try {
    const url = new URL(req.url || '/', origin);
    if (url.pathname === '/ws/fleet') {
      if (socket.destroyed || !session(req)) { socket.destroy(); return; }
      wsServer.handleUpgrade(req, socket, head, ws => {
        sockets.set(ws, id.id);
        sessionTokens.set(id.id, req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('werdr='))?.slice(6) || '');
        alive.add(ws); ws.on('pong', () => alive.add(ws));
        const send = (event: FleetEvent) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 8 * 1024 * 1024) { closeSocket(ws, 1013, 'Metadata viewer too slow'); return; }
          ws.send(JSON.stringify(event));
        };
        const snapshot = () => send({ type: 'fleet.snapshot', state: fleet.state() });
        fleet.on('event', send); snapshot();
        ws.on('message', (data, binary) => {
          try { if (binary || !session(req) || JSON.parse(data.toString()).type !== 'fleet.resync') throw new Error(); snapshot(); }
          catch { closeSocket(ws, 1008, 'Invalid fleet command'); }
        });
        controllers.set(ws, () => fleet.off('event', send));
        ws.on('error', () => ws.terminate());
        ws.on('close', () => { fleet.off('event', send); controllers.delete(ws); sockets.delete(ws); if (![...sockets.values()].includes(id.id)) sessionTokens.delete(id.id); });
      });
      return;
    }
    if (url.pathname !== '/ws/terminal' || terminalMachines.size >= 16) throw new Error('Unknown or unavailable socket');
    const machine = await resolveMachine(publicId(url.searchParams.get('machine')));
    const pane = publicId(url.searchParams.get('pane'));
    const cols = dimension(Number(url.searchParams.get('cols'))), rows = dimension(Number(url.searchParams.get('rows')));
    if (socket.destroyed || !session(req) || terminalMachines.size >= 16) { socket.destroy(); return; }
    terminalWsServer.handleUpgrade(req, socket, head, ws => {
      sockets.set(ws, id.id);
      terminalMachines.set(ws, { id: machine.id, target: machine.target, session: machine.session });
      sessionTokens.set(id.id, req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('werdr='))?.slice(6) || '');
      alive.add(ws); ws.on('pong', () => alive.add(ws));
      const child = terminalProcess(machine, pane, cols, rows, url.searchParams.get('takeover') === '1');
      const decoder = new NdjsonDecoder();
      const input = new TerminalInputWriter(child.stdin);
      let imageLimit = 0, terminalReady = false;
      let ended = false, released = false, terminalClosedSent = false;
      const startup = setTimeout(() => closeSocket(ws, 1011, 'Terminal controller timed out'), 15000);
      startup.unref();
      controllers.set(ws, () => {
        if (ended || released) return;
        released = true; clearTimeout(startup); input.dispose();
        child.stdin.end('{"type":"terminal.release"}\n');
        const terminate = setTimeout(() => { if (!ended) child.kill(); }, 1000);
        const kill = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 2000);
        terminate.unref(); kill.unref();
      });
      const send = (value: unknown) => {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'terminal.closed') { if (terminalClosedSent) return; terminalClosedSent = true; }
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 4 * 1024 * 1024) { closeSocket(ws, 1013, 'Viewer too slow'); return; }
        ws.send(JSON.stringify(value));
      };
      const stopScroll = fleet.watchPaneScroll(machine, pane, (scroll, ready) => send({ type: 'terminal.scroll-state', scroll: scroll ?? null, ready }));
      child.stdout.on('data', (chunk: Buffer) => {
        if (released || ended) return;
        try {
          decoder.push(chunk, frame => {
            if (frame.type === 'terminal.capabilities') {
              imageLimit = Number.isInteger(frame.clipboard_image_max_bytes) && frame.clipboard_image_max_bytes > 0 ? Math.min(frame.clipboard_image_max_bytes, MAX_CLIPBOARD_IMAGE_BYTES) : 0;
              send({ type: 'terminal.capabilities', clipboard_image_max_bytes: imageLimit }); return;
            }
            if (frame.type === 'terminal.closed') terminalReady = false;
            if (frame.type === 'terminal.frame') { terminalReady = true; clearTimeout(startup); }
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
          if (!session(req) || released || ended) throw new Error('Invalid input');
          if (binary) {
            if (!terminalReady) { send({ type: 'terminal.image', status: 'error', message: 'Terminal is not ready for image paste.' }); return; }
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            const deadline = setTimeout(() => closeSocket(ws, 1011, 'Image transfer timed out'), 60000); deadline.unref();
            void input.image(bytes, imageLimit).then(() => send({ type: 'terminal.image', status: 'sent' })).catch(error => send({ type: 'terminal.image', status: 'error', message: error.message })).finally(() => clearTimeout(deadline));
            return;
          }
          if (Buffer.byteLength(data as Buffer) > 65536) throw new Error('Command too large');
          const value = terminalInput(JSON.parse(data.toString()));
          input.write(JSON.stringify(value) + '\n');
        } catch { closeSocket(ws, 1008, 'Invalid terminal command'); }
      });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        stopScroll(); input.dispose();
        sockets.delete(ws); terminalMachines.delete(ws);
        if (![...sockets.values()].includes(id.id)) sessionTokens.delete(id.id);
        controllers.get(ws)?.(); controllers.delete(ws);
      });
    });
  } catch { socket.destroy(); }
  finally { upgrades--; }
});
fleet.on('event', (event: FleetEvent) => {
  if (event.type !== 'fleet.catalog') return;
  for (const [ws, machine] of terminalMachines) {
    const current = event.hosts.find(host => host.machine.id === machine.id)?.machine;
    if (!current?.enabled || current.target !== machine.target || current.session !== machine.session) closeSocket(ws, 1001, 'Host removed, disabled, or changed');
  }
});
const cleanup = setInterval(() => {
  for (const [ws, owner] of sockets) if (!sessions.get(sessionTokens.get(owner), auth.tokenVersion)) closeSocket(ws, 1008, 'Session expired or revoked');
  for (const ws of sockets.keys()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!alive.has(ws)) { controllers.get(ws)?.(); ws.terminate(); }
    else { alive.delete(ws); ws.ping(); }
  }
}, 30_000);
cleanup.unref();
function shutdown() {
  management.stop(); fleet.stop();
  for (const ws of sockets.keys()) closeSocket(ws, 1001, 'Gateway restarting');
  server.close(); clearInterval(cleanup); clearInterval(certificateTimer);
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(port, host, () => console.log(`werdr: ${origin}\nAccess-token file: ${tokenPath}`));
