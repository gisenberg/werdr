import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionStore, SESSION_SECONDS } from '../server/sessions.ts';

test('tokens persist hashed, concurrent writes serialize, and revocations survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-sessions-')); const path = join(directory, 'sessions.json');
  const version = 'a'.repeat(64);
  try {
    const store = await sessionStore(path);
    const secrets = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create(i % 2 ? 'token' : 'password', 'Test browser', version)));
    const data = await readFile(path, 'utf8');
    for (const secret of secrets) assert.equal(data.includes(secret), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const loaded = await sessionStore(path);
    assert.equal(loaded.list('', version).length, 12);
    assert.ok(loaded.get(secrets[0], version));
    assert.equal(loaded.get(secrets[0], version, Date.now() + SESSION_SECONDS * 1000 + 1), undefined);
    assert.equal(loaded.get(secrets[1], 'b'.repeat(64)), undefined);
    const current = loaded.get(secrets[0], version)!.id;
    await loaded.revoke(record => record.id !== current);
    const revoked = await sessionStore(path);
    assert.ok(revoked.get(secrets[0], version));
    for (const secret of secrets.slice(1)) assert.equal(revoked.get(secret, version), undefined);
    await revoked.revoke(() => true);
    assert.equal((await sessionStore(path)).get(secrets[0], version), undefined);
    await chmod(path, 0o644); await assert.rejects(sessionStore(path)); await chmod(path, 0o600);
    for (const data of [{ version: 2, sessions: [] }, { version: 1, sessions: [{}] }]) { await writeFile(path, JSON.stringify(data)); await assert.rejects(sessionStore(path)); }
    await writeFile(path, '{'); await assert.rejects(sessionStore(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
