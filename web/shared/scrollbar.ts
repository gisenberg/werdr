// Native reference: src/ui/scrollbar.rs. Geometry is measured in terminal rows.
export interface ScrollState {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
  alternate_screen_active?: boolean;
}
export function scrollState(value: unknown): ScrollState | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as ScrollState;
  if (![input.offset_from_bottom, input.max_offset_from_bottom, input.viewport_rows].every(value => Number.isSafeInteger(value) && value >= 0)
    || input.viewport_rows < 1 || input.offset_from_bottom > input.max_offset_from_bottom
    || input.max_offset_from_bottom > Number.MAX_SAFE_INTEGER - input.viewport_rows
    || input.alternate_screen_active !== undefined && typeof input.alternate_screen_active !== 'boolean') return;
  return { offset_from_bottom: input.offset_from_bottom, max_offset_from_bottom: input.max_offset_from_bottom, viewport_rows: input.viewport_rows, ...(input.alternate_screen_active === undefined ? {} : { alternate_screen_active: input.alternate_screen_active }) };
}
// Ratatui uses f32 ratios before rounding to whole cells.
const nativeRatio = (numerator: number, denominator: number) => Math.fround(Math.fround(numerator) / Math.fround(denominator));
export function scrollbarThumb(scroll: ScrollState, rows: number) {
  if (!scroll.max_offset_from_bottom || rows < 1) return;
  const length = Math.max(1, Math.min(rows, Math.round(nativeRatio(scroll.viewport_rows * rows, scroll.max_offset_from_bottom + scroll.viewport_rows))));
  const top = Math.round(nativeRatio((scroll.max_offset_from_bottom - scroll.offset_from_bottom) * (rows - length), scroll.max_offset_from_bottom));
  return { top, length };
}
export function scrollbarOffset(scroll: ScrollState, rows: number, row: number, grab?: number) {
  const thumb = scrollbarThumb(scroll, rows);
  if (!thumb || rows === thumb.length) return 0;
  const top = Math.max(0, Math.min(rows - thumb.length, Math.max(0, Math.min(rows - 1, row)) - (grab ?? Math.floor(thumb.length / 2))));
  return Math.max(0, scroll.max_offset_from_bottom - Math.round(nativeRatio(top * scroll.max_offset_from_bottom, rows - thumb.length)));
}
