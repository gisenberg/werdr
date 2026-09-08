import type { Terminal } from 'ghostty-web';
import { terminalRowCells } from './terminal-viewport';

export type TerminalRange = { start: { row: number; col: number }; end: { row: number; col: number } };

// Native ui::panes::automatic_selection_style chooses a contrasting foreground
// over a 28% blend toward white or black, based on the terminal background.
export function terminalSelectionColors(background: string) {
  const rgb = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16));
  const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const target = luminance(rgb) < .5 ? 255 : 0;
  const selected = rgb.map(value => Math.round(value + (target - value) * .28));
  const light = luminance(selected);
  return { selectionBackground: '#' + selected.map(value => value.toString(16).padStart(2, '0')).join(''), selectionForeground: (light + .05) / .05 > 1.05 / (light + .05) ? '#000000' : '#ffffff' };
}

/** Only presentation is delegated to Ghostty; reads still use the native range. */
export function paintTerminalSelection(term: Terminal, top: number, range?: TerminalRange) {
  if (!range || range.end.row < top || range.start.row >= top + term.rows) { term.clearSelection(); return false; }
  const startRow = Math.max(top, range.start.row), endRow = Math.min(top + term.rows - 1, range.end.row);
  let startCol = startRow === range.start.row ? range.start.col : 0, endCol = endRow === range.end.row ? range.end.col : term.cols - 1;
  startCol = terminalRowCells(term, startRow - top).find(cell => cell.start <= startCol && startCol <= cell.end)?.start ?? startCol;
  endCol = terminalRowCells(term, endRow - top).find(cell => cell.start <= endCol && endCol <= cell.end)?.end ?? endCol;
  term.select(startCol, startRow - top, (endRow - startRow) * term.cols + endCol - startCol + 1);
  return true;
}
