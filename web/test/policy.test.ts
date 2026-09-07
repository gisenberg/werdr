import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { allowedBind, allowedHttpOrigins, requestOrigin, equalToken, terminalInput } from '../server/policy.ts';
import { actionArgs, invocation, quotePosix } from '../server/herdr.ts';

test('bind boundary admits private literals and rejects public, wildcard and DNS binds', () => {
  for (const host of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.4', '100.64.0.1', '100.127.255.254', '::1', 'fd12::1']) assert.equal(allowedBind(host), true, host);
  for (const host of ['0.0.0.0', '::', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '2001:4860:4860::8888', 'example.com', 'localhost', '::ffff:8.8.8.8']) assert.equal(allowedBind(host), false, host);
});
test('token comparison and terminal commands fail closed', () => {
  assert.equal(equalToken('secret', 'secret'), true);
  assert.equal(equalToken('Secret', 'secret'), false);
  assert.equal(equalToken('', 'secret'), false);
  for (const value of [{ type: 'terminal.resize', cols: 0, rows: 20 }, { type: 'terminal.resize', cols: 90, rows: 90000 }, { type: 'terminal.resize', cols: '80', rows: 20 }, { type: 'terminal.input', text: 'x'.repeat(32769) }, { type: 'server.stop' }, { type: 'terminal.scroll', direction: 'left', lines: 2 }]) assert.throws(() => terminalInput(value));
  assert.deepEqual(terminalInput({ type: 'terminal.input', text: '\u001b[A🐑', extra: true }), { type: 'terminal.input', text: '\u001b[A🐑' });
});
test('configured private-service DNS aliases require a matching browser origin', () => {
  const allowed = allowedHttpOrigins('100.64.1.2', 3480, 'homelab,homelab.example.ts.net');
  for (const authority of ['100.64.1.2:3480', 'homelab:3480', 'homelab.example.ts.net:3480']) {
    assert.equal(requestOrigin(authority, `http://${authority}`, allowed), `http://${authority}`);
    assert.equal(requestOrigin(authority, undefined, allowed), `http://${authority}`);
  }
  for (const [authority, origin] of [['evil.invalid:3480', undefined], ['homelab:3481', undefined], ['homelab:3480', 'http://evil.invalid'], ['homelab:3480', 'http://100.64.1.2:3480'], ['homelab:3480', 'null'], ['homelab:3480/ignored', undefined]]) assert.equal(requestOrigin(authority, origin, allowed), undefined);
  for (const value of ['*', '*.ts.net', 'http://homelab', 'homelab:3480', 'foo/bar', 'foo@bar', '-bad', 'foo..bar']) assert.throws(() => allowedHttpOrigins('127.0.0.1', 3480, value));
  assert.equal(requestOrigin('[::1]:3480', 'http://[::1]:3480', allowedHttpOrigins('::1', 3480)), 'http://[::1]:3480');
});
test('browser actions cannot choose executables, inject options, or stop servers', () => {
  assert.deepEqual(actionArgs({ action: 'pane.split', id: 'w1:p2', direction: 'right' }), ['pane', 'split', 'w1:p2', '--direction', 'right']);
  for (const body of [{ action: 'server.stop' }, { action: 'pane.close', id: '--help' }, { action: 'pane.close', id: 'w1:p1;echo bad' }, { action: 'pane.split', id: 'w1:p1', direction: 'left' }]) assert.throws(() => actionArgs(body));
});
test('POSIX remote argument quoting preserves shell metacharacters literally', () => {
  for (const value of ["a'b", '$(printf bad)', '`printf bad`', 'two words', '"quoted"', '🐑']) {
    assert.equal(execFileSync('/bin/sh', ['-c', 'printf %s ' + quotePosix(value)], { encoding: 'utf8' }), value);
  }
  const [file, args] = invocation({ id: 'ssh-test', label: 'Test', target: 'test-host', session: 'build', enabled: true }, ['api', 'snapshot']);
  assert.equal(file, 'ssh'); assert.ok(args.includes('BatchMode=yes')); assert.equal(args.at(-1), "'herdr' '--session' 'build' 'api' 'snapshot'");
  assert.throws(() => invocation({ id: 'bad', label: 'Bad', target: '-oProxyCommand=bad', enabled: true }, []));
});
test('Windows adapter encodes explicit argv without loading a PowerShell profile', () => {
  const previous = process.env.WERDR_WINDOWS_MACHINES;
  try {
    process.env.WERDR_WINDOWS_MACHINES = 'win-test';
    const [, args] = invocation({ id: 'win-test', label: 'Test', target: 'windows-test', session: "a'b", enabled: true }, ['api', 'snapshot']);
    const command = args.at(-1)!;
    assert.ok(command.startsWith('pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand '));
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');
    assert.equal(script, "& 'herdr' '--session' 'a''b' 'api' 'snapshot'; exit $LASTEXITCODE");
  } finally {
    if (previous === undefined) delete process.env.WERDR_WINDOWS_MACHINES; else process.env.WERDR_WINDOWS_MACHINES = previous;
  }
});

test('HTTPS authorities require HTTPS origins, including on WebSocket upgrades', () => {
  const allowed = allowedHttpOrigins('127.0.0.1', 3480, 'host.example.ts.net', 'https');
  assert.equal(requestOrigin('host.example.ts.net:3480', 'https://host.example.ts.net:3480', allowed, 'https'), 'https://host.example.ts.net:3480');
  assert.equal(requestOrigin('host.example.ts.net:3480', 'http://host.example.ts.net:3480', allowed, 'https'), undefined);
  assert.equal(requestOrigin('host.example.ts.net:3480', undefined, allowed), undefined);
});

test('managed Windows runtime paths expand environment variables without interpreting shell syntax', () => {
  const machines = process.env.WERDR_WINDOWS_MACHINES, binary = process.env.WERDR_WINDOWS_HERDR_BIN;
  try {
    process.env.WERDR_WINDOWS_MACHINES = 'managed';
    process.env.WERDR_WINDOWS_HERDR_BIN = "%LOCALAPPDATA%\\werdr\\user's $(literal)\\herdr.exe";
    const [, args] = invocation({ id: 'managed', label: 'Managed', target: 'trusted-host', session: 'werdr', enabled: true }, ['api', 'snapshot']);
    const script = Buffer.from(args.at(-1)!.split(' ').at(-1)!, 'base64').toString('utf16le');
    assert.equal(script, "& ([Environment]::ExpandEnvironmentVariables('%LOCALAPPDATA%\\werdr\\user''s $(literal)\\herdr.exe')) '--session' 'werdr' 'api' 'snapshot'; exit $LASTEXITCODE");
  } finally {
    if (machines === undefined) delete process.env.WERDR_WINDOWS_MACHINES; else process.env.WERDR_WINDOWS_MACHINES = machines;
    if (binary === undefined) delete process.env.WERDR_WINDOWS_HERDR_BIN; else process.env.WERDR_WINDOWS_HERDR_BIN = binary;
  }
});
