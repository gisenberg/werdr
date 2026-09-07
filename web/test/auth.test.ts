import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authentication, LoginLimiter, parseCredentials, verifyCredentials } from '../server/auth.ts';

const salt = Buffer.alloc(16, 7);
const credentials = { username: 'test-user', passwordHash: `scrypt$${salt.toString('hex')}$${scryptSync('test-password', salt, 32).toString('hex')}` };
test('wmux password hashes verify without retaining plaintext and reject malformed records', async () => {
  assert.equal(await verifyCredentials(parseCredentials(credentials), 'test-user', 'test-password'), true);
  assert.equal(await verifyCredentials(credentials, 'wrong-user', 'test-password'), false);
  assert.equal(await verifyCredentials(credentials, 'test-user', 'wrong-password'), false);
  assert.equal(await verifyCredentials(credentials, 'test-user', 'x'.repeat(4097)), false);
  for (const value of [null, {}, { ...credentials, passwordHash: 'scrypt$00$00' }, { ...credentials, username: '' }]) assert.throws(() => parseCredentials(value));
});
test('tokens rotate durably with private permissions and configured credentials fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-auth-'));
  const path = join(directory, 'token'), creds = join(directory, 'credentials.json');
  try {
    await writeFile(creds, JSON.stringify(credentials), { mode: 0o600 });
    const auth = await authentication(path, creds);
    const old = await readFile(path, 'utf8');
    const next = await auth.rotateToken();
    assert.equal(auth.verifyToken(old), false); assert.equal(auth.verifyToken(next), true);
    assert.equal((await authentication(path, creds)).verifyToken(next), true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await auth.verifyPassword('test-user', 'test-password'), true);
    assert.equal((await authentication(path)).passwordEnabled, false);
    await chmod(creds, 0o644); await assert.rejects(authentication(path, creds));
    await chmod(creds, 0o600); await writeFile(creds, '{}'); await assert.rejects(authentication(path, creds));
    await assert.rejects(authentication(path, join(directory, 'missing')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('login attempts are bounded by peer address and recover after the window', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 10; i++) assert.equal(limiter.take('peer', 0), true);
  assert.equal(limiter.take('peer', 1), false);
  assert.equal(limiter.take('other', 1), true);
  assert.equal(limiter.take('peer', 60000), true);
});
