import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Exact embedded-font routes only. Runtime-provisioned assets are outside the public source tree.
export const bootFontNames = [
  'Amiga_Topaz_v1.woff2',
  'Amstrad_CPC.woff2',
  'Apple_2.woff2',
  'Atari_8_bit.woff2',
  'BBC_Micro.woff2',
  'Commodore_VIC-20.woff2',
  'IBM_2915.woff2',
  'IBM_CGA.woff2',
  'Lisa_Console.woff2',
  'MSX_1.woff2',
  'Memotech_MTX512.woff2',
  'Mullard_SAA_5050.woff2',
  'Oric_Atmos.woff2',
  'SAM_Coupe.woff2',
  'Spectrum.woff2',
  'Tatung_Einstein.woff2',
  'VT100.woff2',
] as const;
export async function bootFonts(directory: string | undefined): Promise<ReadonlyMap<string, Buffer>> {
  const fonts = new Map<string, Buffer>();
  if (!directory) return fonts;
  for (const name of bootFontNames) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid boot font');
    const data = await readFile(path);
    if (data.toString('ascii', 0, 4) !== 'wOF2') throw new Error('Expected a WOFF2 boot font');
    fonts.set(`/fonts/retro/${name}`, data);
  }
  return fonts;
}
