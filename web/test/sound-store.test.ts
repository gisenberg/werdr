import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { soundStore } from '../server/sound-store.ts';
import { validateMp3 } from '../server/mp3.ts';
import { MAX_CUSTOM_SOUND_BYTES } from '../shared/custom-sounds.ts';

const sample = () => readFile(new URL('../../assets/sounds/done.mp3', import.meta.url));
test('MP3 validation accepts real bundled audio and rejects malformed, truncated and oversized payloads', async () => {
  const bytes = await sample(); validateMp3(bytes);
  validateMp3(await readFile(new URL('../../assets/sounds/request.mp3', import.meta.url)));
  const tag = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 3, 0, 0, 0]);
  validateMp3(Buffer.concat([tag, bytes]));
  const trailer = Buffer.alloc(128); trailer.write('TAG'); validateMp3(Buffer.concat([bytes, trailer]));
  for (const invalid of [Buffer.alloc(0), Buffer.from('not an MP3'), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('junk')]), Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1), tag, Buffer.from([73, 68, 51, 4, 0, 0, 255, 0, 0, 0])]) assert.throws(() => validateMp3(invalid));
});

test('sound storage is private, content-addressed, immutable and durable across reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'werdr-sounds-')), directory = join(root, 'sounds');
  try {
    const bytes = await sample(), store = await soundStore(directory, () => []);
    const id = await store.upload(bytes); assert.match(id, /^[a-f0-9]{64}$/);
    assert.equal(await store.upload(bytes), id); assert.deepEqual(await readdir(directory), [`${id}.mp3`]);
    assert.deepEqual(await store.read(id), bytes);
    assert.deepEqual(await (await soundStore(directory, () => [id])).read(id), bytes);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, `${id}.mp3`))).mode & 0o777, 0o600);
    await assert.rejects(store.read('../secret'), /Invalid sound ID/);
    await writeFile(join(directory, `${id}.mp3`), 'tampered'); await assert.rejects(store.read(id), /integrity/);
    await assert.rejects(store.upload(bytes), /integrity/);
    const linkId = 'f'.repeat(64); await symlink(join(directory, `${id}.mp3`), join(directory, `${linkId}.mp3`));
    await assert.rejects(store.read(linkId)); await assert.rejects(store.collect(), /private sound/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup protects drafts and durable references, serializes saves, and enforces storage bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'werdr-sound-gc-')), directory = join(root, 'sounds');
  let referenced: string[] = [], clock = Date.now();
  try {
    const bytes = await sample(), store = await soundStore(directory, () => referenced, { now: () => clock, maxFiles: 1, maxBytes: bytes.length });
    const id = await store.upload(bytes);
    const other = await readFile(new URL('../../assets/sounds/request.mp3', import.meta.url));
    await assert.rejects(store.upload(other), /storage is full/);
    assert.equal((await store.collect()).files, 1, 'fresh draft is retained');
    const old = new Date(clock - 25 * 60 * 60 * 1000); await utimes(join(directory, `${id}.mp3`), old, old);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
    const save = store.withReferences([id], async () => { started(); await gate; referenced = [id]; return 'saved'; });
    await began; const cleanup = store.collect(); release(); assert.equal(await save, 'saved');
    assert.equal((await cleanup).files, 1, 'cleanup observes the durable save');
    await assert.rejects(store.withReferences(['e'.repeat(64)], async () => { throw new Error('must not save'); }), /missing or invalid/);
    referenced = []; clock += 1;
    assert.equal((await store.collect()).files, 0); assert.deepEqual(await readdir(directory), []);
    await assert.rejects(store.read(id), /ENOENT/);
    await assert.rejects(store.upload(Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1)), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
