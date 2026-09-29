import type { Terminal } from 'ghostty-web';
import type { WordCell } from './terminal-word';

export type NativeViewport = { content_revision: number; viewport_text: string; scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } };

export function matchesNativeViewport(term: Terminal | undefined, context: NativeViewport) {
  if (!term || term.rows !== context.scroll.viewport_rows) return false;
  return terminalViewportText(term) === context.viewport_text.trimEnd();
}

export function terminalRowCells(term: Terminal, row: number): WordCell[] {
  const core = term.wasmTerm; if (!core) return [];
  const cells = core.getLine(row), result: WordCell[] = [];
  for (let col = 0; col < (cells?.length || 0); col++) {
    const cell = cells![col]; if (cell.width === 0) continue;
    const text = cell.codepoint === 0x10eeee ? ' ' : cell.grapheme_len ? core.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32);
    result.push({ text, start: col, end: col + Math.max(1, cell.width) - 1 });
  }
  return result;
}

export function terminalViewportText(term: Terminal) {
  const core = term.wasmTerm; if (!core) return undefined;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    const cells = core.getLine(row); let line = '';
    for (let col = 0; col < (cells?.length || 0); col++) {
      const cell = cells![col]; if (cell.width === 0) continue;
      line += cell.codepoint === 0x10eeee ? ' ' : cell.grapheme_len ? core.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32);
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n').trimEnd();
}
