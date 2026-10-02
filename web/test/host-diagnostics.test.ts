import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_OFFLINE_DETAIL, offlineDetail } from '../server/host-diagnostics.ts';
import { NativeApiError } from '../server/native-api.ts';
import { POSIX_HERDR_NOT_FOUND } from '../server/herdr.ts';

const execFailure = (stderr: string, extra: object = {}) => Object.assign(new Error(`Command failed: ssh -T -- host 'herdr' 'status'\n${stderr}`), { stderr, code: 255, ...extra });

test('offline hosts explain known SSH and installation failures with fixed advice', () => {
  const cases: [unknown, RegExp][] = [
    [execFailure('Host key verification failed.\r\n'), /does not trust this host's SSH key/],
    [execFailure('gisenberg@host: Permission denied (publickey,password).'), /key login was refused/],
    [execFailure('ssh: Could not resolve hostname away-team.local: Name or service not known'), /cannot resolve/],
    [execFailure('ssh: connect to host 10.0.0.168 port 22: Connection refused'), /Enable Remote Login or sshd/],
    [execFailure('ssh: connect to host 10.0.0.168 port 22: Operation timed out'), /cannot reach this host/],
    [execFailure('zsh:1: command not found: herdr', { code: 127 }), /Herdr is not installed/],
    [execFailure('bash: line 1: herdr: command not found', { code: 127 }), /Herdr is not installed/],
    [execFailure(POSIX_HERDR_NOT_FOUND, { code: 127 }), /Herdr is not installed/],
    [Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL' }), /did not answer within 15 seconds/],
    [Object.assign(new Error('SSH API tunnel closed'), { stderr: '' }), /API socket could not be forwarded/],
    [Object.assign(new Error('SSH API tunnel closed'), { stderr: 'Host key verification failed.' }), /does not trust/],
  ];
  for (const [error, expected] of cases) {
    const detail = offlineDetail(error);
    assert.match(detail, expected); assert.match(detail, /Existing sessions are left running\.$/);
  }
});

test('native server states keep their own guidance, and unknown remote output is never forwarded', () => {
  assert.equal(offlineDetail(new NativeApiError('Native server is not running. Use SET UP to prepare it.', 'offline')), 'Native server is not running. Use SET UP to prepare it. Existing sessions are left running.');
  const secret = execFailure('unexpected remote banner with token=abc123');
  assert.equal(offlineDetail(secret), GENERIC_OFFLINE_DETAIL);
  assert.equal(offlineDetail(undefined), GENERIC_OFFLINE_DETAIL);
});
