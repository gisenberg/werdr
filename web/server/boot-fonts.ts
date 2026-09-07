import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Exact embedded-font routes only. Runtime-provisioned assets are outside the public source tree.
const names = ['Apple_2.woff2', 'IBM_CGA.woff2'] as const;
export async function bootFonts(directory: string | undefined): Promise<ReadonlyMap<string, Buffer>> {
  const fonts = new Map<string, Buffer>();
  if (!directory) return fonts;
  for (const name of names) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid boot font');
    const data = await readFile(path);
    if (data.toString('ascii', 0, 4) !== 'wOF2') throw new Error('Expected a WOFF2 boot font');
    fonts.set(`/fonts/retro/${name}`, data);
  }
  return fonts;
}
