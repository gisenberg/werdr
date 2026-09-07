import type { Terminal } from 'ghostty-web';

export type NativeViewport = { content_revision: number; viewport_text: string; scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } };

export function matchesNativeViewport(term: Terminal | undefined, context: NativeViewport) {
  if (!term || term.rows !== context.scroll.viewport_rows) return false;
  const core = term.wasmTerm; if (!core) return false;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    const cells = core.getLine(row); let line = '';
    for (let col = 0; col < (cells?.length || 0); col++) {
      const cell = cells![col]; if (cell.width === 0) continue;
      line += cell.codepoint === 0x10eeee ? ' ' : cell.grapheme_len ? core.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32);
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n').trimEnd() === context.viewport_text.trimEnd();
}
