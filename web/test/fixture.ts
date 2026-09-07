import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);
export async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'werdr-e2e-'));
  const binary = resolve(process.env.WERDR_TEST_HERDR_BIN || '../.local/bin/herdr');
  const env = { ...process.env, XDG_CONFIG_HOME: directory, SHELL: '/bin/bash', WERDR_HERDR_BIN: binary };
  for (const key of ['HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_SESSION', 'WERDR_SOCKET_PATH', 'WERDR_SESSION']) delete (env as Record<string, string | undefined>)[key];
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(r => listener.close(() => r()));
  const url = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const children: ChildProcess[] = [];
  const start = (file: string, args: string[], extra = {}) => {
    const child = spawn(file, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    child.on('error', error => { diagnostics += error.message; });
    for (const output of [child.stdout, child.stderr]) output?.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    return child;
  };
  const cli = async (...args: string[]) => (await exec(binary, args, { env, timeout: 10000 })).stdout;
  const wait = async (check: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 100; attempt++) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Fixture did not start: ${diagnostics}`);
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => {
      child.once('exit', () => { clearTimeout(timer); done(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000); child.kill('SIGTERM');
    });
  };
  let gateway: ChildProcess;
  const startGateway = async () => {
    gateway = start(process.execPath, ['--import', 'tsx', 'server/index.ts'], { WERDR_HOST: '127.0.0.1', WERDR_ALLOWED_HOSTS: 'localhost', WERDR_PORT: String(port), WERDR_TOKEN_FILE: resolve(directory, 'token') });
    await wait(async () => (await fetch(url)).ok);
  };
  const close = async () => {
    try {
      const { result } = JSON.parse(await cli('api', 'snapshot'));
      for (const workspace of result.snapshot.workspaces) await cli('workspace', 'close', workspace.workspace_id);
    } catch {}
    for (const child of [...children].reverse()) await stop(child);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    start(binary, ['server']);
    await wait(async () => !!(await cli('api', 'snapshot')));
    await startGateway();
    return { url, cli, token: (await readFile(resolve(directory, 'token'), 'utf8')).trim(), close,
      restartGateway: async () => { await stop(gateway); await startGateway(); } };
  } catch (error) { await close(); throw error; }
}
