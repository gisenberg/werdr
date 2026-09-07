import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('standalone Windows installer uses the runtime manifest release and checksum', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../werdr/runtime.json', import.meta.url), 'utf8'));
  const script = await readFile(new URL('../../werdr/install-windows-server.ps1', import.meta.url), 'utf8');
  for (const [name, value] of [['version', manifest.version], ['url', manifest['windows-x64'].url], ['digest', manifest['windows-x64'].sha256]]) {
    assert.ok(script.includes(`$${name} = '${value}'`), `Windows ${name} must match the reviewed release manifest`);
  }
});
