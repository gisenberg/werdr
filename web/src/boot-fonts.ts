// Runtime-provisioned fonts are embedded only by the boot presentation.
const fonts = [
  ['Retro BBC Micro', 'BBC_Micro.woff2'],
  ['Retro Spectrum', 'Spectrum.woff2'],
  ['Retro Atari ST', 'Atari_8_bit.woff2'],
  ['Retro Atari 8-bit', 'Atari_8_bit.woff2'],
  ['Retro Amiga Topaz', 'Amiga_Topaz_v1.woff2'],
  ['Retro VT100', 'VT100.woff2'],
  ['Retro Amstrad CPC', 'Amstrad_CPC.woff2'],
  ['Retro Apple II', 'Apple_2.woff2'],
  ['Retro IBM CGA', 'IBM_CGA.woff2'],
  ['Retro IBM 2915', 'IBM_2915.woff2'],
  ['Retro MSX', 'MSX_1.woff2'],
  ['Retro Lisa Console', 'Lisa_Console.woff2'],
  ['Retro VIC-20', 'Commodore_VIC-20.woff2'],
  ['Retro Memotech MTX', 'Memotech_MTX512.woff2'],
  ['Retro SAA 5050', 'Mullard_SAA_5050.woff2'],
  ['Retro Oric Atmos', 'Oric_Atmos.woff2'],
  ['Retro SAM Coupe', 'SAM_Coupe.woff2'],
  ['Retro Tatung Einstein', 'Tatung_Einstein.woff2'],
];
for (const [family, file] of fonts) document.fonts.add(new FontFace(family, `url(/fonts/retro/${file})`, { weight: "400" }));
