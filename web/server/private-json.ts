import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function readPrivateJson(path: string, maximum = 1024 * 1024): Promise<unknown | undefined> {
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error('Private state must be an owner-only regular file');
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}
export async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}
