#!/usr/bin/env node
import { readFile, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'werdr/runtime.json'), 'utf8'));
const asset = lock[`${process.platform}-${process.arch}`];
if (!asset) throw new Error('No verified fixture binary is pinned for this platform. Build herdr and set WERDR_TEST_HERDR_BIN.');
const output = resolve(root, '.local/bin/herdr');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let existing;
try { existing = await readFile(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  if (digest(existing) !== asset.sha256) throw new Error(`Refusing to overwrite a different executable at ${output}`);
  console.log(`Verified existing ${lock.version}: ${output}`);
} else {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== asset.sha256) throw new Error('Runtime checksum mismatch');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 });
  // link is atomic and refuses to overwrite a concurrent install or user binary.
  try { await link(temporary, output); } finally { await unlink(temporary); }
  console.log(`Verified ${lock.version}: ${output}`);
}
