export const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;

/** Identify transferable file bytes without decoding pixels or trusting a filename. */
export function clipboardImageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | undefined {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'png';
  if (starts(255, 216, 255)) return 'jpg';
  if (starts(71, 73, 70, 56, 55, 97) || starts(71, 73, 70, 56, 57, 97)) return 'gif';
  if (starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'webp';
  if (starts(66, 77)) return 'bmp';
}
