import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setupRequest, validatePrivateTarget } from '../server/machine-management.ts';
import { browserAction } from '../server/browser-actions.ts';

test('onboarding rejects shell syntax and public targets while accepting private LAN addresses', async () => {
  const request = { target: 'user@192.168.1.10', label: 'build-host', platform: 'posix' };
  assert.equal(setupRequest(request).session, 'werdr');
  for (const target of ['-oProxyCommand=bad', 'host;touch /tmp/bad', 'user:secret@host', 'host\ncommand', '$(command)']) assert.throws(() => setupRequest({ ...request, target }));
  assert.throws(() => setupRequest({ ...request, session: '../other' }));
  await assert.rejects(validatePrivateTarget('203.0.113.20'), /private LAN/);
  assert.equal(await validatePrivateTarget('192.168.1.10'), '192.168.1.10');
});

test('browser actions expose named native methods with bounded input and no arbitrary RPC', () => {
  for (const action of ['server.stop', 'events.subscribe', 'shell.exec', '__proto__']) assert.throws(() => browserAction({ action }));
  assert.throws(() => browserAction({ action: 'agent.start', id: 'p:1', kind: 'claude; echo bad', name: 'test' }));
  assert.throws(() => browserAction({ action: 'agent.prompt', id: 'p:1', text: 'a'.repeat(32769) }));
  assert.deepEqual(browserAction({ action: 'pane.split', id: 'p:1', direction: 'down', command: 'ignored' }), { method: 'pane.split', params: { target_pane_id: 'p:1', direction: 'down' } });
});

for (const answer of ['yes', 'no']) test(`setup PTY forwards the native ${answer} prompt and preserves Unicode`, async () => {
  const child = spawn('python3', ['server/setup-pty.py', 'python3', '-c', 'import sys; assert sys.stdin.isatty(); answer=input("羊 install? [y/N] "); print("ANSWER="+answer); sys.exit(0 if answer=="yes" else 7)']);
  let output = ''; let sent = false;
  const result = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; if (!sent && output.includes('[y/N]')) { sent = true; child.stdin.write(JSON.stringify({ input: answer + '\r' }) + '\n'); } });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { assert.equal(await result, answer === 'yes' ? 0 : 7); assert.match(output, /羊 install/); assert.ok(output.includes('ANSWER=' + answer)); }
  finally { clearTimeout(timer); child.stdin.destroy(); }
});
