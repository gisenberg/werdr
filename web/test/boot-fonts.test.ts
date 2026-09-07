import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootFonts } from '../server/boot-fonts.ts';

test('private font provisioning fails closed and exposes only the two embedded-font paths', async () => {
  assert.equal((await bootFonts(undefined)).size, 0);
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fonts-'));
  try {
    await assert.rejects(bootFonts(directory));
    await writeFile(join(directory, 'Apple_2.woff2'), 'invalid');
    await assert.rejects(bootFonts(directory));
    await writeFile(join(directory, 'Apple_2.woff2'), 'wOF2fixture');
    await writeFile(join(directory, 'IBM_CGA.woff2'), 'wOF2fixture');
    await writeFile(join(directory, 'credentials.json'), 'private');
    const fonts = await bootFonts(directory);
    assert.deepEqual([...fonts.keys()], ['/fonts/retro/Apple_2.woff2', '/fonts/retro/IBM_CGA.woff2']);
    await writeFile(join(directory, 'IBM_CGA.woff2'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(bootFonts(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
