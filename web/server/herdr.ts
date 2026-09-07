import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface Machine { id: string; label: string; target?: string; session?: string; enabled: boolean }
const binary = process.env.WERDR_HERDR_BIN || 'herdr';
// Never inherit a pane's implicit target into an unrelated browser session.
export const environment = { ...process.env };
for (const key of ['HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_SESSION', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete environment[key];
if (process.env.WERDR_SOCKET_PATH) environment.HERDR_SOCKET_PATH = process.env.WERDR_SOCKET_PATH;

export function quotePosix(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function invocation(machine: Machine, args: string[]): [string, string[]] {
  const scoped = machine.session ? ['--session', machine.session, ...args] : args;
  if (!machine.target) return [binary, scoped];
  if (machine.target.startsWith('-') || /[\r\n\0]/.test(machine.target)) throw new Error('Invalid saved SSH target');
  // Herdr's catalog deliberately has no OS field. An explicit deployment override
  // selects PowerShell without creating another inventory or guessing from names.
  const windows = (process.env.WERDR_WINDOWS_MACHINES || '').split(',').includes(machine.id);
  const remoteCommand = windows
    ? 'pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from('& ' + ['herdr', ...scoped].map(value => "'" + value.replaceAll("'", "''") + "'").join(' ') + '; exit $LASTEXITCODE', 'utf16le').toString('base64')
    : ['herdr', ...scoped].map(quotePosix).join(' ');
  return ['ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '--', machine.target, remoteCommand]];
}
export async function command(machine: Machine, args: string[]): Promise<any> {
  const [file, argv] = invocation(machine, args);
  const { stdout } = await exec(file, argv, { env: environment, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message || 'Herdr rejected the request');
  return response.result ?? response;
}
export async function machines(): Promise<Machine[]> {
  const local: Machine = { id: 'local', label: 'Local', enabled: true, session: process.env.WERDR_SESSION };
  const saved = await command(local, ['machine', 'list', '--json']);
  if (!Array.isArray(saved) || saved.length > 64) throw new Error('Invalid Herdr machine catalog');
  return [local, ...saved.map((m): Machine => {
    if (!m || typeof m.id !== 'string' || m.id === 'local' || typeof m.label !== 'string' || typeof m.target !== 'string' || typeof m.session !== 'string' || typeof m.enabled !== 'boolean') throw new Error('Invalid saved machine');
    return { id: m.id, label: m.label, target: m.target, session: m.session, enabled: m.enabled };
  })];
}
export async function resolveMachine(id: string): Promise<Machine> {
  const machine = (await machines()).find(m => m.id === id && m.enabled);
  if (!machine) throw new Error('Machine unavailable');
  return machine;
}
export function publicId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)) throw new Error('Invalid target id');
  return value;
}
export function actionArgs(body: Record<string, unknown>): string[] {
  switch (body.action) {
    case 'workspace.create': return ['workspace', 'create'];
    case 'tab.create': return ['tab', 'create', '--workspace', publicId(body.id)];
    case 'workspace.close': return ['workspace', 'close', publicId(body.id)];
    case 'tab.close': return ['tab', 'close', publicId(body.id)];
    case 'pane.close': return ['pane', 'close', publicId(body.id)];
    case 'pane.split':
      if (body.direction !== 'right' && body.direction !== 'down') throw new Error('Invalid split direction');
      return ['pane', 'split', publicId(body.id), '--direction', body.direction];
    default: throw new Error('Unsupported action');
  }
}
export function terminalProcess(machine: Machine, id: string, cols: number, rows: number, takeover: boolean) {
  const [file, argv] = invocation(machine, ['terminal', 'session', 'control', publicId(id), '--cols', String(cols), '--rows', String(rows), ...(takeover ? ['--takeover'] : [])]);
  return spawn(file, argv, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
}
