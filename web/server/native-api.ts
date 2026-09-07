import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { NdjsonDecoder } from './ndjson.ts';
import { command, environment, isWindows, type Machine } from './herdr.ts';

export type NativeEvent = { event: string; data: any };
export interface Subscription { type: string; pane_id?: string }
interface Channel { receive(value: any): void; closed(error: Error): void; close(): void }
interface Transport { open(id: string, request: object, channel: Omit<Channel, 'close'>): () => void; close(): void }
export class NativeApiError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}
export interface NativeEndpoint {
  version: string;
  request(method: string, params?: object): Promise<any>;
  subscribe(subscriptions: Subscription[], receive: (event: NativeEvent) => void, closed: (error: Error) => void): Promise<() => void>;
  close(): void;
}
const sshArgs = (machine: Machine) => ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
export const powershellCommand = (script: string) => 'pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
export const quotePowerShell = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function terminate(child: ChildProcessWithoutNullStreams) {
  child.stdin.end(); child.kill();
  const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); kill.unref();
}
function socketTransport(path: string, dispose = () => {}): Transport {
  const sockets = new Set<Socket>();
  return {
    open(_id, request, channel) {
      const socket = connect(path); sockets.add(socket);
      const decoder = new NdjsonDecoder(); let ended = false;
      const end = (error: Error) => { if (ended) return; ended = true; sockets.delete(socket); socket.destroy(); channel.closed(error); };
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
      socket.on('data', chunk => { try { decoder.push(chunk, channel.receive); } catch { end(new Error('Invalid native API frame')); } });
      socket.on('error', end); socket.on('close', () => end(new Error('Native API connection closed')));
      return () => { ended = true; sockets.delete(socket); socket.destroy(); };
    },
    close() { for (const socket of sockets) socket.destroy(); sockets.clear(); dispose(); },
  };
}
async function unixRemoteTransport(machine: Machine, remotePath: string): Promise<Transport> {
  if (!remotePath.startsWith('/') || /[\r\n\0]/.test(remotePath)) throw new Error('Invalid native socket path');
  const directory = await mkdtemp(join(tmpdir(), 'werdr-api-'));
  const path = join(directory, 'api.sock');
  const child = spawn('ssh', [...sshArgs(machine), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${path}:${remotePath}`, '--', machine.target!], { env: environment });
  child.stderr.resume(); child.stdout.resume();
  let error: Error | undefined;
  child.on('error', value => { error = value; });
  child.on('exit', () => { error ||= new Error('SSH API tunnel closed'); });
  const dispose = () => { terminate(child); void rm(directory, { recursive: true, force: true }); };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (error) throw error;
      // Forwarding is ready when a local connect succeeds; no remote server is started.
      const ready = await new Promise<boolean>(resolve => {
        const socket = connect(path); const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 100);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (ready) return socketTransport(path, dispose);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('SSH API tunnel timed out');
  } catch (error) { dispose(); throw error; }
}
async function windowsTransport(machine: Machine, pipe: string): Promise<Transport> {
  if (!pipe || pipe.length > 1024 || /[\r\n\0]/.test(pipe)) throw new Error('Invalid native pipe name');
  const source = await readFile(fileURLToPath(new URL('./windows-api-relay.ps1', import.meta.url)), 'utf8');
  // Windows OpenSSH may launch cmd.exe, whose command-line limit is 8191 bytes.
  // Read an exact UTF-8 prefix from stdin so no buffered reader consumes the
  // following NDJSON channels, and keep the launch command independent of source size.
  const script = `$bytes=New-Object byte[] ${Buffer.byteLength(source)}; $stream=[Console]::OpenStandardInput(); $offset=0; while($offset -lt $bytes.Length) { $count=$stream.Read($bytes,$offset,$bytes.Length-$offset); if($count -eq 0) { throw 'Relay source truncated' }; $offset+=$count }; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes))) -PipeName ${quotePowerShell(pipe)}`;
  const child = spawn('ssh', [...sshArgs(machine), '--', machine.target!, powershellCommand(script)], { env: environment });
  const channels = new Map<string, Channel>(); const decoder = new NdjsonDecoder(9 * 1024 * 1024);
  let ended: Error | undefined;
  const stop = (error: Error) => {
    if (ended) return; ended = error;
    for (const channel of [...channels.values()]) channel.closed(error);
    channels.clear(); terminate(child);
  };
  child.stderr.resume(); child.stdin.on('error', () => stop(new Error('SSH API relay closed')));
  child.on('error', () => stop(new Error('Cannot launch SSH API relay'))); child.on('exit', () => stop(new Error('SSH API relay closed')));
  child.stdout.on('data', chunk => {
    try { decoder.push(chunk, frame => {
      const channel = channels.get(frame.channel); if (!channel) return;
      if (frame.error || frame.closed) { channels.delete(frame.channel); channel.closed(new Error(frame.error || 'Native API connection closed')); }
      else channel.receive(frame.message);
    }); } catch { stop(new Error('Invalid SSH API relay frame')); }
  });
  child.stdin.write(source);
  return {
    open(id, request, channel) {
      if (ended) throw ended;
      if (channels.size >= 32 || child.stdin.writableLength > 1024 * 1024) throw new Error('Native API busy');
      const close = () => {
        if (!channels.delete(id) || ended) return;
        child.stdin.write(JSON.stringify({ channel: id, cancel: true }) + '\n');
      };
      channels.set(id, { ...channel, close });
      child.stdin.write(JSON.stringify({ channel: id, request }) + '\n');
      return close;
    },
    close() { stop(new Error('API relay detached')); },
  };
}
export async function nativeEndpoint(machine: Machine): Promise<NativeEndpoint> {
  const status = await command(machine, ['status', '--json']);
  if (!status.server?.running) throw new NativeApiError('Native server is not running. Use SET UP to prepare it.', 'offline');
  if (status.server.compatible === false || status.server.endpoint_compatible === false || !status.server.capabilities?.surface_interest) throw new NativeApiError('Native server needs a compatible update. Use SET UP to review it.', 'incompatible');
  const path = status.server.socket;
  if (typeof path !== 'string') throw new Error('Native server did not report its API socket');
  const transport = !machine.target ? socketTransport(path) : isWindows(machine) ? await windowsTransport(machine, path) : await unixRemoteTransport(machine, path);
  let sequence = 0, stopped = false;
  const prefix = randomBytes(6).toString('hex');
  function open(method: string, params: object, receive: (value: any) => void, closed: (error: Error) => void) {
    if (stopped) throw new Error('Native endpoint detached');
    const id = `werdr:${prefix}:${++sequence}`;
    return transport.open(id, { id, method, params }, { receive, closed });
  }
  return {
    version: status.server.version || '',
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        let close = () => {};
        const worktreeMutation = ['worktree.create', 'worktree.open', 'worktree.remove'].includes(method);
        const timer = setTimeout(() => { close(); reject(new Error(worktreeMutation ? 'Native worktree request timed out. It may still be running; refresh before retrying.' : 'Native API request timed out')); }, worktreeMutation ? 120_000 : method === 'agent.start' ? 65_000 : 10_000); timer.unref();
        const fail = (error: Error) => { clearTimeout(timer); close(); reject(error); };
        try { close = open(method, params, value => {
          clearTimeout(timer); close();
          if (value.error) reject(new NativeApiError(value.error.message || 'Native API rejected request', value.error.code));
          else resolve(value.result);
        }, fail); } catch (error) { fail(error as Error); }
      });
    },
    subscribe(subscriptions, receive, closed) {
      return new Promise((resolve, reject) => {
        let close = () => {}, acknowledged = false, cancelled = false;
        const timer = setTimeout(() => fail(new Error('Native subscription timed out')), 10_000); timer.unref();
        const fail = (error: Error) => {
          if (cancelled) return; cancelled = true; clearTimeout(timer); close();
          if (acknowledged) closed(error); else reject(error);
        };
        try { close = open('events.subscribe', { subscriptions }, value => {
          if (value.error) { fail(new NativeApiError(value.error.message || 'Subscription rejected', value.error.code)); return; }
          if (!acknowledged) {
            if (!value.result) { fail(new Error('Missing subscription acknowledgement')); return; }
            acknowledged = true; clearTimeout(timer); resolve(() => { cancelled = true; close(); });
          } else if (value.event) receive(value);
        }, fail); } catch (error) { fail(error as Error); }
      });
    },
    close() { stopped = true; transport.close(); },
  };
}
