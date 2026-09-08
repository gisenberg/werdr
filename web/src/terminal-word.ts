/** Display-cell counterpart of app::actions::word_bounds_at_column.
 * Keep URL, quoted-path and token rules aligned with the native client.
 * Cell widths come from the rendered terminal, including wide graphemes.
 */
export type WordCell = { text: string; start: number; end: number };
type Span = { start: number; end: number };
const whitespace = (text: string) => /^\p{White_Space}/u.test(text);
const separator = (text: string) => whitespace(text) || '|()[]{},;!'.includes(text);
const contains = (span: Span, index: number) => span.start <= index && index <= span.end;

export function terminalWord(cells: WordCell[], column: number): { start: number; end: number } | undefined {
  // Preserve every scalar for prefix and delimiter matching, while keeping the
  // rendered grapheme's display columns for the resulting selection.
  const scalars = cells.flatMap(cell => Array.from(cell.text || ' ').map(text => ({ ...cell, text })));
  const clicked = scalars.findIndex(cell => cell.start <= column && column <= cell.end);
  if (clicked < 0) return;
  const chars = scalars.map(cell => cell.text);
  const span = url(chars, clicked) || quotedPath(chars, clicked) || token(chars, clicked);
  return span ? { start: scalars[span.start].start, end: scalars[span.end].end } : undefined;
}

function url(chars: string[], clicked: number): Span | undefined {
  for (let start = 0; start < chars.length; start++) {
    if (!['http://', 'https://'].some(prefix => Array.from(prefix).every((char, index) => chars[start + index] === char))) continue;
    let end = start;
    while (end + 1 < chars.length && !whitespace(chars[end + 1])) end++;
    if (clicked < start || clicked > end) { start = end; continue; }
    while (end >= start) {
      const char = chars[end];
      if ('"\'`.,;:!?'.includes(char)) { end--; continue; }
      const close = ')]}'.indexOf(char);
      if (close >= 0) {
        const open = '([{'.charAt(close);
        let balance = 0;
        for (let index = start; index < end; index++) balance += chars[index] === open ? 1 : chars[index] === char ? -1 : 0;
        if (balance <= 0) { end--; continue; }
      }
      break;
    }
    const span = { start, end };
    return contains(span, clicked) ? span : undefined;
  }
}

function quotedPath(chars: string[], clicked: number): Span | undefined {
  if ('"\'`'.includes(chars[clicked])) return;
  for (const quote of ['"', "'", '`']) {
    let open: number | undefined;
    for (let index = 0; index < chars.length; index++) {
      if (chars[index] !== quote) continue;
      let slashes = 0;
      for (let cursor = index; cursor > 0 && chars[cursor - 1] === '\\'; cursor--) slashes++;
      if (slashes % 2) continue;
      if (open === undefined) open = index;
      else {
        if (open < clicked && clicked < index && chars.slice(open + 1, index).includes('/')) return { start: open + 1, end: index - 1 };
        open = undefined;
      }
    }
  }
}

function token(chars: string[], clicked: number): Span | undefined {
  if (separator(chars[clicked])) return;
  let start = clicked, end = clicked;
  while (start > 0 && !separator(chars[start - 1])) start--;
  while (end + 1 < chars.length && !separator(chars[end + 1])) end++;
  const trailing = (char: string) => ')]}>"\'`.,;:!?'.includes(char);
  while (start <= end && '([{<"\'`'.includes(chars[start])) start++;
  if (start < end && chars[end] === '$' && trailing(chars[end - 1])) end--;
  while (start <= end && trailing(chars[end])) end--;
  return contains({ start, end }, clicked) ? { start, end } : undefined;
}
