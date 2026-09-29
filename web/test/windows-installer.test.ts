import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('standalone Windows installer uses the runtime manifest release and checksum', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../werdr/runtime.json', import.meta.url), 'utf8'));
  const script = await readFile(new URL('../../werdr/install-windows-server.ps1', import.meta.url), 'utf8');
  for (const [name, value] of [['version', manifest.version], ['url', manifest['windows-x64'].url], ['digest', manifest['windows-x64'].sha256]]) {
    assert.ok(script.includes(`$${name} = '${value}'`), `Windows ${name} must match the reviewed release manifest`);
  }
});

test('Windows installer refuses scheduled tasks outside its exact session contract', async t => {
  const exec = promisify(execFile);
  try { await exec('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']); }
  catch (error: any) { if (error.code === 'ENOENT') { t.skip('PowerShell is required for executable installer preflight checks'); return; } throw error; }
  const { stdout } = await exec('pwsh', ['-NoLogo', '-NoProfile', '-File', fileURLToPath(new URL('./fixtures/windows-installer-preflight.ps1', import.meta.url)), '-Installer', fileURLToPath(new URL('../../werdr/install-windows-server.ps1', import.meta.url))], { timeout: 15000 });
  for (const scenario of ['different-session', 'session-case', 'missing-arguments', 'extra-action', 'no-actions', 'different-executable', 'different-description', 'matching-task']) assert.ok(stdout.includes(`PASS_TASK_PREFLIGHT:${scenario}`));
  for (const scenario of ['missing-binary', 'missing-receipt', 'wrong-receipt']) assert.ok(stdout.includes(`PASS_RELEASE_PREFLIGHT:${scenario}`));
});
