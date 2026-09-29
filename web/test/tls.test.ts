import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tlsConfiguration } from '../server/tls.ts';

test('TLS fails closed and reloads matching certificate pairs without replacing the server', async () => {
  assert.equal(await tlsConfiguration(), undefined);
  await assert.rejects(tlsConfiguration('/missing'));
  const directory = await mkdtemp(join(tmpdir(), 'werdr-tls-'));
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
  const generate = () => execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  try {
    generate();
    const firstKey = await readFile(key);
    const tls = (await tlsConfiguration(cert, key))!;
    let replacements = 0;
    const server = { setSecureContext() { replacements++; } };
    assert.equal(await tls.reload(server), false);
    generate();
    const secondKey = await readFile(key);
    await writeFile(key, firstKey);
    await assert.rejects(tls.reload(server)); assert.equal(replacements, 0);
    await writeFile(key, secondKey);
    assert.equal(await tls.reload(server), true); assert.equal(replacements, 1);
    assert.equal(await tls.reload(server), false);
    await writeFile(cert, 'invalid');
    await assert.rejects(tls.reload(server)); assert.equal(replacements, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
