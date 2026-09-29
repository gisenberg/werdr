import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// The historical screenshot is provisioned privately, never bundled in the public fork.
export async function bootArtwork(directory: string | undefined): Promise<Buffer | undefined> {
  if (!directory) return undefined;
  const path = resolve(directory, 'workbench13-bootscreen.gif');
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid boot artwork');
  const data = await readFile(path);
  if (!['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) throw new Error('Expected GIF boot artwork');
  return data;
}
