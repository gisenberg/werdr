import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializePlatforms, savePlatform, withPlatform } from '../server/machine-platforms.ts';

test('native host IDs of different generations retain platform hints only for the pinned endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-platform-test-'));
  const path = join(directory, 'platforms.json');
  const machine = { id: 'a'.repeat(28), label: 'Windows fixture', target: '192.168.1.5', session: 'werdr', enabled: true };
  try {
    await initializePlatforms(path);
    await savePlatform(machine, 'windows', new Set([machine.id]));
    await initializePlatforms(path);
    assert.equal(withPlatform(machine).platform, 'windows');
    assert.equal(withPlatform({ ...machine, label: 'Renamed host' }).platform, 'windows');
    assert.equal(withPlatform({ ...machine, target: '192.168.1.6' }).platform, undefined);
    assert.equal(withPlatform({ ...machine, session: 'another-runtime' }).platform, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
