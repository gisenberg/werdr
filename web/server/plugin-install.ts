import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { environment, invocation, type Machine } from './herdr.ts';
import { ManagementError } from './machine-management.ts';
import { terminate } from './native-api.ts';
import type { PluginInstallJob } from '../shared/plugins.ts';

export function pluginInstallArgs(value: Record<string, unknown>): string[] {
  if (value.operation === 'uninstall') {
    if (typeof value.plugin !== 'string' || !/^[A-Za-z0-9.:_-]{1,120}$/.test(value.plugin)) throw new ManagementError('Invalid plugin ID.');
    return ['plugin', 'uninstall', value.plugin];
  }
  if (value.operation !== 'install') throw new ManagementError('Invalid plugin installation operation.');
  const source = value.source;
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 || /[\\\x00-\x1f\x7f]/.test(source)) throw new ManagementError('Use owner/repository or owner/repository/subdirectory.');
  const parts = source.split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..') || parts.slice(0, 2).some(part => !/^[A-Za-z0-9._-]+$/.test(part))) throw new ManagementError('Use owner/repository or owner/repository/subdirectory.');
  const args = ['plugin', 'install', source];
  if (value.ref !== undefined && value.ref !== '') {
    const ref = value.ref;
    if (typeof ref !== 'string' || Buffer.byteLength(ref) > 256 || ref.startsWith('-') || ref.includes('..') || ref.includes('@{') || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref)) throw new ManagementError('Use a branch, tag, or commit for the Git ref.');
    args.push('--ref', ref);
  }
  return args;
}

// A PTY preserves the native manifest preview and confirmation. No --yes is
// supplied, and the command and target come only from validated arguments and
// the saved host snapshot, never from a browser-provided shell command.
export function pluginInstallInvocation(machine: Machine, args: string[]): [string, string[]] {
  const [file, argv] = invocation(machine, args);
  if (machine.target) {
    argv[0] = '-tt';
    argv.splice(1, 0, '-o', 'StrictHostKeyChecking=yes');
  }
  return ['python3', [fileURLToPath(new URL('./setup-pty.py', import.meta.url)), file, ...argv]];
}
interface Job { owner: string; view: PluginInstallJob; child: ChildProcessWithoutNullStreams; timer: ReturnType<typeof setTimeout>; cancelled: boolean }
export class PluginInstallations {
  private jobs = new Map<string, Job>();
  private stopped = false;
  constructor(private changed: (machine: string) => void) {}
  assertAvailable(machine: string) {
    if (this.stopped || [...this.jobs.values()].some(job => job.view.machine === machine && job.view.state === 'running')) throw new ManagementError('A plugin installation is running on this host. Finish or cancel it first.', 409);
  }
  begin(owner: string, machine: Machine, value: Record<string, unknown>): PluginInstallJob {
    const args = pluginInstallArgs(value); this.assertAvailable(machine.id);
    if ([...this.jobs.values()].filter(job => job.view.state === 'running').length >= 4) throw new ManagementError('Too many plugin installations are running.', 409);
    while (this.jobs.size >= 32) {
      const oldest = [...this.jobs].find(([, job]) => job.view.state !== 'running');
      if (!oldest) throw new ManagementError('Plugin installation history is full.', 409);
      this.jobs.delete(oldest[0]);
    }
    const id = randomBytes(16).toString('hex');
    const [file, argv] = pluginInstallInvocation(machine, args);
    const child = spawn(file, argv, { env: environment });
    const job: Job = { owner, child, cancelled: false, timer: setTimeout(() => this.cancel(owner, id), 15 * 60_000), view: { id, machine: machine.id, label: machine.label, operation: value.operation as 'install' | 'uninstall', source: args[2]!, ref: value.operation === 'install' && typeof value.ref === 'string' ? value.ref : undefined, state: 'running', output: '', started: Date.now() } };
    job.timer.unref(); this.jobs.set(id, job);
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const print = (text: string) => { job.view.output = (job.view.output + stripVTControlCharacters(text).replace(/\r\n/g, '\n')).slice(-128 * 1024); };
    child.stdout.on('data', chunk => print(stdout.write(chunk))); child.stderr.on('data', chunk => print(stderr.write(chunk)));
    child.stdin.on('error', () => {});
    const finish = (code: number | null, error?: string) => {
      if (job.view.state !== 'running') return;
      clearTimeout(job.timer); print(stdout.end() + stderr.end());
      job.view.state = job.cancelled ? 'cancelled' : code === 0 ? 'complete' : 'failed';
      job.view.ended = Date.now(); job.view.exitCode = code;
      if (error) print(`\n[ERROR] ${error}\n`);
      this.changed(machine.id);
    };
    child.once('error', error => finish(null, error.message));
    child.once('close', (code, signal) => finish(code, code === 0 || job.cancelled ? undefined : `Native installer exited ${code ?? signal}.`));
    return { ...job.view };
  }
  get(owner: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ManagementError('Plugin installation not found.', 404);
    return { ...job.view };
  }
  list(owner: string, machine: string) {
    return [...this.jobs.values()].filter(job => job.owner === owner && job.view.machine === machine).map(job => ({ ...job.view }));
  }
  input(owner: string, id: string, value: unknown) {
    this.get(owner, id); const job = this.jobs.get(id)!;
    if (job.view.state !== 'running' || job.cancelled || typeof value !== 'string' || Buffer.byteLength(value) > 4095 || /[\x00-\x1f\x7f]/.test(value)) throw new ManagementError('Invalid installer response.');
    if (!job.child.stdin.writable || job.child.stdin.writableLength > 8192) throw new ManagementError('Installer input is unavailable.', 409);
    job.child.stdin.write(JSON.stringify({ input: value + '\r' }) + '\n');
  }
  cancel(owner: string, id: string) {
    this.get(owner, id); const job = this.jobs.get(id)!;
    if (job.view.state !== 'running' || job.cancelled) return;
    job.cancelled = true; terminate(job.child);
  }
  revoke(owners: string[]) { for (const job of this.jobs.values()) if (owners.includes(job.owner)) this.cancel(job.owner, job.view.id); }
  stop() { this.stopped = true; for (const job of this.jobs.values()) this.cancel(job.owner, job.view.id); }
}
