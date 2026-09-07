import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Machine, SetupJob, SetupRequest } from '../shared/fleet.ts';
import { allowedBind } from './policy.ts';
import { binary, command, environment, isWindows, localMachine, machines } from './herdr.ts';
import { initializePlatforms, savePlatform } from './machine-platforms.ts';
import { powershellCommand, quotePowerShell, terminate } from './native-api.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const exec = promisify(execFile);
const maximumOutput = 128 * 1024;
interface Job { view: SetupJob; owner: string; child?: ChildProcessWithoutNullStreams; cancelled: boolean; answer?: (answer: string) => void; done?: Promise<void> }
export class ManagementError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
export function setupRequest(value: Record<string, unknown>): SetupRequest {
  if (typeof value.target !== 'string' || value.target.length > 1024 || !/^(?:ssh:\/\/)?(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/.test(value.target)) throw new ManagementError('Use an SSH alias, hostname, or user@host without passwords or shell syntax.');
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!label || Buffer.byteLength(label) > 128 || /[\x00-\x1f\x7f]/.test(label)) throw new ManagementError('Host label must contain 1 to 128 bytes without control characters.');
  const session = value.session === undefined ? 'werdr' : value.session;
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(session)) throw new ManagementError('Use a session name containing letters, numbers, dots, underscores, or dashes.');
  if (value.platform !== 'posix' && value.platform !== 'windows') throw new ManagementError('Choose Linux/macOS or Windows.');
  return { target: value.target, label, session, platform: value.platform };
}
const sshOptions = () => ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
export async function validatePrivateTarget(target: string) {
  const { stdout } = await exec('ssh', ['-G', ...sshOptions(), '--', target], { env: environment, timeout: 5000, maxBuffer: 256 * 1024 });
  const hostname = stdout.split('\n').find(line => line.startsWith('hostname '))?.slice(9).trim();
  if (!hostname) throw new ManagementError('SSH did not resolve this host.');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !allowedBind(address))) throw new ManagementError('Hosts must resolve only to private LAN, loopback, or Tailscale addresses.');
  return hostname;
}
export class MachineManagement {
  private jobs = new Map<string, Job>();
  private busy = false;
  private cached: Machine[] = [];
  private stopped = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly platformPath: string, private readonly changed: () => Promise<void>) {}
  async start() {
    await initializePlatforms(this.platformPath);
    this.cached = [localMachine()];
    await this.catalog();
    this.cleanupTimer = setInterval(() => {
      for (const [id, job] of this.jobs) if (job.view.ended && Date.now() - job.view.ended > 30 * 60_000) this.jobs.delete(id);
    }, 60_000); this.cleanupTimer.unref();
  }
  async catalog() {
    if (!this.busy) {
      try { this.cached = await machines(); }
      catch { console.error('Cannot read native machine catalog; retaining the last valid host list.'); }
    }
    return this.cached;
  }
  async edit(value: Record<string, unknown>) {
    if (this.busy) throw new ManagementError('A host update is already running. Finish or cancel setup first.', 409);
    this.busy = true;
    try {
      const machine = (await machines()).find(machine => machine.id === value.id && machine.target);
      if (!machine) throw new ManagementError('Saved host not found.', 404);
      if (!['rename', 'remove', 'enable', 'disable'].includes(String(value.action))) throw new ManagementError('Unknown host action.');
      const args = ['machine', String(value.action), machine.id];
      if (value.action === 'rename') {
        const validated = setupRequest({ target: machine.target, label: value.label, session: machine.session, platform: isWindows(machine) ? 'windows' : 'posix' });
        args.push('--label', validated.label);
      }
      await exec(binary, args, { env: environment, timeout: 10_000, maxBuffer: 256 * 1024 });
    } finally { this.busy = false; await this.changed(); }
  }
  async begin(owner: string, value: Record<string, unknown>): Promise<SetupJob> {
    if (this.busy || this.stopped) throw new ManagementError('A host update is already running.', 409);
    this.busy = true;
    try {
      const current = await machines();
      const existing = value.id === undefined ? undefined : current.find(machine => machine.id === value.id && machine.target);
      if (value.id !== undefined && !existing) throw new ManagementError('Saved host not found.', 404);
      const request = setupRequest(existing ? { target: existing.target, label: existing.label, session: existing.session, platform: isWindows(existing) ? 'windows' : 'posix' } : value);
      if (!existing && current.some(machine => machine.target === request.target && machine.session === request.session)) throw new ManagementError('This host and session are already registered. Use SET UP on its existing entry.');
      const id = randomBytes(16).toString('hex');
      const job: Job = { owner, cancelled: false, view: { id, state: 'running', target: request.target, label: request.label, platform: request.platform, output: '', started: Date.now(), ...(existing ? { machineId: existing.id } : {}) } };
      this.jobs.set(id, job);
      while (this.jobs.size > 16) {
        const oldest = [...this.jobs.values()].find(candidate => candidate.view.state !== 'running');
        if (!oldest) break; this.jobs.delete(oldest.view.id);
      }
      job.done = this.run(job, request, existing).finally(async () => { this.busy = false; await this.changed().catch(() => {}); });
      return job.view;
    } catch (error) { this.busy = false; throw error; }
  }
  get(owner: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ManagementError('Setup job not found.', 404);
    return job.view;
  }
  list(owner: string) { return [...this.jobs.values()].filter(job => job.owner === owner).map(job => job.view); }
  input(owner: string, id: string, value: unknown) {
    this.get(owner, id); const job = this.jobs.get(id)!;
    if (job.view.state !== 'running' || typeof value !== 'string' || Buffer.byteLength(value) > 4096) throw new ManagementError('Invalid setup response.');
    if (job.answer) { const answer = job.answer; job.answer = undefined; answer(value); }
    else if (job.child?.stdin.writable && job.child.stdin.writableLength < 8192) job.child.stdin.write(JSON.stringify({ input: value + '\r' }) + '\n');
    else throw new ManagementError('Setup is not waiting for input.', 409);
  }
  cancel(owner: string, id: string) {
    this.get(owner, id); const job = this.jobs.get(id)!;
    if (job.view.state !== 'running') return;
    job.cancelled = true; job.answer?.('no'); job.answer = undefined; if (job.child) terminate(job.child);
  }
  revoke(ownerIds: string[]) { for (const job of this.jobs.values()) if (ownerIds.includes(job.owner)) this.cancel(job.owner, job.view.id); }
  private print(job: Job, text: string) { job.view = { ...job.view, output: (job.view.output + stripVTControlCharacters(text).replace(/\r\n/g, '\n')).slice(-maximumOutput) }; }
  private check(job: Job) { if (job.cancelled || this.stopped) throw new ManagementError('Setup cancelled.'); }
  private runChild(job: Job, file: string, args: string[], input?: string, timeout = 10 * 60_000) {
    this.check(job);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { env: environment }); job.child = child;
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      child.stdout.on('data', chunk => this.print(job, stdout.write(chunk)));
      child.stderr.on('data', chunk => this.print(job, stderr.write(chunk)));
      const timer = setTimeout(() => { job.cancelled = true; terminate(child); }, timeout); timer.unref();
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); job.child = undefined; reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer); if (job.child === child) job.child = undefined;
        this.print(job, stdout.end() + stderr.end());
        if (code === 0 && !job.cancelled) resolve(); else reject(new ManagementError(job.cancelled ? 'Setup cancelled or timed out.' : `Setup command exited ${code ?? signal}. Review the console above.`, 502));
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }
  private async run(job: Job, request: SetupRequest, existing?: Machine) {
    try {
      this.print(job, `Checking private SSH target ${request.target}...\n`);
      await validatePrivateTarget(request.target); this.check(job);
      try { await exec('ssh', ['-T', ...sshOptions(), '--', request.target, 'exit 0'], { env: environment, timeout: 12_000, maxBuffer: 128 * 1024 }); }
      catch { throw new ManagementError('SSH access failed. Verify the host key and key-based SSH login from the gateway, then retry.', 502); }
      this.check(job); this.print(job, 'SSH access verified. Existing remote sessions remain owned by Herdr.\n');
      if (request.platform === 'windows') await this.prepareWindows(job, request, existing);
      else await this.preparePosix(job, request, existing);
      this.check(job);
      this.print(job, '\n[OK] Host registered and ready.\n'); job.view = { ...job.view, state: 'complete', ended: Date.now() };
    } catch (error) {
      const message = error instanceof ManagementError ? error.message : 'Host setup failed. Check SSH access and the setup console.';
      this.print(job, `\n[${job.cancelled ? 'CANCELLED' : 'ERROR'}] ${message}\n`);
      job.view = { ...job.view, state: job.cancelled ? 'cancelled' : 'failed', error: message, ended: Date.now() };
    }
  }
  private async preparePosix(job: Job, request: SetupRequest, existing?: Machine) {
    const label = existing ? `werdr-setup-${job.view.id}` : request.label;
    const before = new Set((await machines()).map(machine => machine.id));
    this.print(job, 'Herdr will check compatibility and ask before installation or any unsupported runtime replacement. Answer its prompts below.\n');
    try {
      await this.runChild(job, 'python3', [fileURLToPath(new URL('./setup-pty.py', import.meta.url)), binary, 'machine', 'add', request.target, '--label', label, '--remote-session', request.session]);
      this.check(job);
      const added = (await machines()).find(machine => !before.has(machine.id) && machine.target === request.target && machine.session === request.session && machine.label === label);
      if (!added) throw new ManagementError('Herdr did not save the prepared host.', 502);
      job.view = { ...job.view, machineId: existing?.id || added.id };
      if (!existing) await savePlatform(added, 'posix', new Set((await machines()).map(machine => machine.id)));
    } finally {
      // Native machine add also performs compatibility repair. For an existing
      // host, retain its original public ID and retire only our temporary entry.
      if (existing) {
        const temporary = (await machines()).filter(machine => !before.has(machine.id) && machine.label === label && machine.target === request.target && machine.session === request.session);
        for (const machine of temporary) await exec(binary, ['machine', 'remove', machine.id], { env: environment, timeout: 10_000, maxBuffer: 128 * 1024 });
      }
    }
  }
  private async prepareWindows(job: Job, request: SetupRequest, existing?: Machine) {
    const candidate: Machine = { id: existing?.id || randomBytes(16).toString('hex'), target: request.target, session: request.session, label: request.label, enabled: existing?.enabled ?? true, platform: 'windows' };
    let ready = false;
    try { const status = await command(candidate, ['status', '--json']); ready = status.server?.running && status.server.compatible && status.server.endpoint_compatible; } catch {}
    if (!ready) {
      this.print(job, 'Install/start the checksum-pinned Windows Herdr runtime and its user Scheduled Task? Existing running runtimes will not be forcibly replaced. [y/N]\n');
      const answer = await new Promise<string>(resolve => {
        const timer = setTimeout(() => { job.cancelled = true; job.answer = undefined; resolve('no'); }, 5 * 60_000); timer.unref();
        job.answer = answer => { clearTimeout(timer); resolve(answer.trim().toLowerCase()); };
      });
      if (!['y', 'yes'].includes(answer)) { job.cancelled = true; throw new ManagementError('Installation declined.'); }
      this.check(job);
      const relative = `werdr\\setup\\${job.view.id}.ps1`;
      const path = `([IO.Path]::Combine($env:LOCALAPPDATA, ${quotePowerShell(relative)}))`;
      const source = await readFile(new URL('../../werdr/install-windows-server.ps1', import.meta.url), 'utf8');
      const stage = `$ErrorActionPreference='Stop'; $path=${path}; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null; $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew); try { [Console]::OpenStandardInput().CopyTo($file) } finally { $file.Dispose() }`;
      await this.runChild(job, 'ssh', ['-T', ...sshOptions(), '--', request.target, powershellCommand(stage)], source, 30_000);
      const run = `$ErrorActionPreference='Stop'; $path=${path}; try { & $path -Session ${quotePowerShell(request.session)}; if (-not $?) { exit 1 } } finally { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }`;
      await this.runChild(job, 'ssh', ['-T', ...sshOptions(), '--', request.target, powershellCommand(run)], '', 10 * 60_000);
      this.check(job);
      const status = await command(candidate, ['status', '--json']);
      if (!status.server?.running || !status.server.compatible || !status.server.endpoint_compatible) throw new ManagementError('Windows runtime is not compatible or ready; the existing catalog was preserved.', 502);
    }
    if (existing) {
      const current = await machines(); const original = current.find(machine => machine.id === existing.id);
      if (!original || original.target !== existing.target || original.session !== existing.session) throw new ManagementError('Host changed during setup; refresh before retrying.', 409);
      await savePlatform(original, 'windows', new Set(current.map(machine => machine.id)));
    } else {
      // Upstream automatic preparation is POSIX-only. Preserve its exact catalog
      // schema for the already-validated Windows runtime; no parallel inventory.
      const current = await machines();
      if (current.length > 64) throw new ManagementError('Herdr machine limit reached.');
      const base = process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME, 'herdr') : process.platform === 'win32' ? resolve(process.env.LOCALAPPDATA || homedir(), 'herdr') : resolve(homedir(), '.local/state/herdr');
      const path = resolve(base, 'client/endpoints.json');
      const stored = await readPrivateJson(path, 64 * 1024) as any || { version: 1, ssh: [] };
      if (stored.version !== 1 || !Array.isArray(stored.ssh) || stored.ssh.length >= 64) throw new ManagementError('Native machine catalog is unsupported or full.');
      await savePlatform(candidate, 'windows', new Set([...current.map(machine => machine.id), candidate.id]));
      const { platform: _, ...record } = candidate;
      stored.ssh.push(record); await writePrivateJson(path, stored);
    }
    job.view = { ...job.view, machineId: candidate.id };
  }
  stop() {
    this.stopped = true; clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) if (job.view.state === 'running') this.cancel(job.owner, job.view.id);
  }
}
