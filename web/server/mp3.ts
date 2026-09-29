import { MAX_CUSTOM_SOUND_BYTES } from '../shared/custom-sounds.ts';

/** Structural MPEG Layer III validation, not an audio decoder.
 * Frame layout reference: https://github.com/libsdl-org/mpg123/blob/master/src/libmpg123/parse.c
 * The browser must also decode a selected file before offering it for save.
 */
export function validateMp3(bytes: Uint8Array) {
  const invalid = (): never => { throw new Error('Choose a complete MPEG Layer III MP3 file (maximum 2 MiB).'); };
  if (bytes.length < 8 || bytes.length > MAX_CUSTOM_SOUND_BYTES) invalid();
  let offset = 0, end = bytes.length, frames = 0;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.slice(6, 10).some(value => value > 127)) invalid();
    const length = bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
    offset = 10 + length + (bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0);
    if (offset >= end) invalid();
  }
  if (end >= 128 && bytes[end - 128] === 84 && bytes[end - 127] === 65 && bytes[end - 126] === 71) end -= 128;
  let format: string | undefined;
  while (offset < end) {
    if (offset + 4 > end || bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224) invalid();
    const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4, rateIndex = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) invalid();
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const nextFormat = `${version}:${sampleRate}`;
    if (format !== undefined && format !== nextFormat) invalid();
    format = nextFormat;
    const length = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex] / sampleRate) + ((bytes[offset + 2] >> 1) & 1);
    const mono = (bytes[offset + 3] >> 6) === 3;
    const sideInfo = version === 3 ? mono ? 17 : 32 : mono ? 9 : 17;
    if (length < 4 + sideInfo + ((bytes[offset + 1] & 1) ? 0 : 2) || offset + length > end) invalid();
    offset += length; frames++;
  }
  if (frames < 2) invalid();
}
