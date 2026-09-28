import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { MAX_CUSTOM_SOUND_BYTES, validSoundId } from '../shared/custom-sounds.ts';
import { validateMp3 } from './mp3.ts';

const MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 128, DRAFT_LIFETIME = 24 * 60 * 60 * 1000;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const privateOwner = (info: { mode: number; uid: number }) => process.platform === 'win32' || !(info.mode & 0o077) && info.uid === process.getuid?.();
export class SoundReferenceError extends Error { constructor() { super('A selected custom sound is missing or invalid. Select it again or reset that sound.'); } }

export async function soundStore(directory: string, referenced: () => Iterable<string>, options: { now?: () => number; maxBytes?: number; maxFiles?: number } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateOwner(info)) throw new Error('Sound storage must be an owner-only directory.');
  const now = options.now || Date.now, maxBytes = options.maxBytes ?? MAX_BYTES, maxFiles = options.maxFiles ?? MAX_FILES;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const next = queue.then(operation); queue = next.catch(() => {}); return next;
  };
  const path = (id: string) => { if (!validSoundId(id)) throw new Error('Invalid sound ID.'); return join(directory, `${id}.mp3`); };
  const sync = async () => { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
  const read = async (id: string) => {
    const handle = await open(path(id), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || !privateOwner(info) || info.size > MAX_CUSTOM_SOUND_BYTES) throw new Error('Invalid private sound asset.');
      const buffer = Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1); let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      const bytes = buffer.subarray(0, length);
      if (length > MAX_CUSTOM_SOUND_BYTES || hash(bytes) !== id) throw new Error('Sound asset failed integrity validation.');
      return bytes;
    } finally { await handle.close(); }
  };
  const collect = async () => {
    const keep = new Set(referenced()); let bytes = 0, files = 0, entries = 0, removed = false;
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (++entries > MAX_FILES * 2) throw new Error('Sound directory has too many entries.');
      const match = /^([a-f0-9]{64})(?:\.mp3|\.[a-f0-9]{16}\.tmp)$/.exec(entry.name);
      if (!match) throw new Error('Unexpected file in private sound directory.');
      const name = join(directory, entry.name), info = await lstat(name);
      if (!info.isFile() || !privateOwner(info)) throw new Error('Invalid private sound asset.');
      if (!keep.has(match[1]) && now() - info.mtimeMs >= DRAFT_LIFETIME) { await unlink(name); removed = true; continue; }
      bytes += info.size; files++;
    }
    if (removed) await sync();
    return { bytes, files };
  };
  return {
    read: (id: string) => serial(() => read(id)),
    collect: () => serial(collect),
    upload: (input: Uint8Array, authorize = () => {}) => {
      // Own bytes before entering the queue; callers cannot mutate a pending upload.
      if (input.length > MAX_CUSTOM_SOUND_BYTES) return Promise.reject(new Error('Sound exceeds 2 MiB.'));
      const bytes = Buffer.from(input);
      return serial(async () => {
        authorize();
        validateMp3(bytes); const id = hash(bytes), destination = path(id);
        try { await read(id); const date = new Date(now()); await utimes(destination, date, date); return id; }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        const usage = await collect();
        if (usage.bytes + bytes.length > maxBytes || usage.files >= maxFiles) throw new Error('Custom sound storage is full. Unsaved uploads expire after 24 hours.');
        const temporary = join(directory, `${id}.${randomBytes(8).toString('hex')}.tmp`);
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, destination); await sync(); return id;
        } finally { await unlink(temporary).catch((error: any) => { if (error.code !== 'ENOENT') throw error; }); }
      });
    },
    // Hold the same lock as cleanup until the settings reference is durable.
    withReferences: <T>(ids: Iterable<string>, save: () => Promise<T>) => {
      const wanted = [...new Set(ids)];
      return serial(async () => {
        try { for (const id of wanted) await read(id); } catch { throw new SoundReferenceError(); }
        return save();
      });
    },
  };
}
