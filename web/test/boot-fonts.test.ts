import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootFonts, bootFontNames } from '../server/boot-fonts.ts';

test('private font provisioning fails closed and exposes only the exact embedded-font paths', async () => {
  assert.equal((await bootFonts(undefined)).size, 0);
  const directory = await mkdtemp(join(tmpdir(), 'werdr-fonts-'));
  try {
    await assert.rejects(bootFonts(directory));
    await writeFile(join(directory, 'Apple_2.woff2'), 'invalid');
    await assert.rejects(bootFonts(directory));
    for (const name of bootFontNames) await writeFile(join(directory, name), 'wOF2fixture');
    await writeFile(join(directory, 'credentials.json'), 'private');
    const fonts = await bootFonts(directory);
    assert.deepEqual([...fonts.keys()], bootFontNames.map(name => `/fonts/retro/${name}`));
    await writeFile(join(directory, 'IBM_CGA.woff2'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(bootFonts(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private artwork validates its exact screenshot without publishing neighboring files', async () => {
  const { bootArtwork } = await import('../server/boot-artwork.ts');
  assert.equal(await bootArtwork(undefined), undefined);
  const directory = await mkdtemp(join(tmpdir(), 'werdr-artwork-'));
  try {
    await assert.rejects(bootArtwork(directory));
    await writeFile(join(directory, 'workbench13-bootscreen.gif'), 'invalid');
    await assert.rejects(bootArtwork(directory));
    await writeFile(join(directory, 'workbench13-bootscreen.gif'), 'GIF89afixture');
    assert.equal((await bootArtwork(directory))?.toString(), 'GIF89afixture');
    await writeFile(join(directory, 'workbench13-bootscreen.gif'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(bootArtwork(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
