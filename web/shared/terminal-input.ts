/** Largest `terminal.input` text the gateway accepts in one message, in UTF-8 bytes. */
export const MAX_TERMINAL_INPUT_BYTES = 32768;
/** Clients split longer input into messages of at most this many UTF-8 bytes. */
export const TERMINAL_INPUT_CHUNK_BYTES = 16384;

/**
 * Split terminal input into ordered chunks that each fit one message.
 * Chunks end on code point boundaries, so no chunk carries half a character;
 * a bracketed paste may span chunks because the terminal reassembles the byte stream.
 */
export function splitTerminalInput(text: string, maxBytes = TERMINAL_INPUT_CHUNK_BYTES): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('Chunk size must hold one UTF-8 code point');
  const chunks: string[] = [];
  let start = 0, bytes = 0;
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index)!, width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4, units = code > 0xffff ? 2 : 1;
    if (bytes + width > maxBytes) { chunks.push(text.slice(start, index)); start = index; bytes = 0; }
    bytes += width; index += units;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}
