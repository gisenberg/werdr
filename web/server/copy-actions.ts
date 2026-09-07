import { publicId } from './herdr.ts';
import { ManagementError } from './machine-management.ts';

const motions = new Set(['line_end', 'first_non_blank', 'next_word_start', 'previous_word_start', 'next_word_end', 'next_big_word_start', 'previous_big_word_start', 'next_big_word_end', 'previous_paragraph', 'next_paragraph']);
function integer(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new ManagementError(`Invalid ${label}.`);
  return value;
}
function point(value: unknown): { row: number; col: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('Invalid terminal position.');
  const p = value as Record<string, unknown>;
  return { row: integer(p.row, 0xffffffff, 'terminal row'), col: integer(p.col, 0xffff, 'terminal column') };
}
function revision(value: unknown): number {
  const result = integer(value, Number.MAX_SAFE_INTEGER, 'content revision');
  if (result % 2) throw new ManagementError('Terminal content is changing. Retry with a stable revision.');
  return result;
}

export const copyReadActions = new Set(['pane.copy_motion', 'pane.copy_search', 'pane.selection.read']);

// PaneInfo.revision is not the terminal content revision. Bracket the scroll
// geometry with native content checks instead of trusting that metadata field.
export async function copyContext(value: Record<string, unknown>, request: (method: string, params: object, invalidate?: boolean) => Promise<any>) {
  const pane_id = publicId(value.id), cursor = { row: 0, col: 0 }, motion = 'line_end';
  const initial = await request('pane.copy_motion', { pane_id, cursor, motion }, false);
  const content_revision = revision(initial.content_revision);
  const result = await request('pane.get', { pane_id }, false);
  const scroll = result.pane?.scroll;
  if (!scroll) throw new ManagementError('Native scrollback geometry is unavailable.', 409);
  const offset_from_bottom = integer(scroll.offset_from_bottom, Number.MAX_SAFE_INTEGER, 'native scroll offset');
  const max_offset_from_bottom = integer(scroll.max_offset_from_bottom, Number.MAX_SAFE_INTEGER, 'native scrollback size');
  const viewport_rows = integer(scroll.viewport_rows, 0xffffffff, 'native viewport rows');
  if (!viewport_rows || offset_from_bottom > max_offset_from_bottom) throw new ManagementError('Invalid native scrollback geometry.', 409);
  const visible = await request('pane.read', { pane_id, source: 'visible', format: 'text', strip_ansi: true }, false);
  if (typeof visible.read?.text !== 'string' || visible.read.truncated) throw new ManagementError('Native viewport text is unavailable.', 409);
  const after = await request('pane.get', { pane_id }, false);
  if (after.pane?.scroll?.offset_from_bottom !== offset_from_bottom || after.pane?.scroll?.max_offset_from_bottom !== max_offset_from_bottom || after.pane?.scroll?.viewport_rows !== viewport_rows) throw new ManagementError('Native viewport changed. Retry after scrolling finishes.', 409);
  await request('pane.copy_motion', { pane_id, cursor, motion, content_revision }, false);
  return { pane_id, content_revision, viewport_text: visible.read.text, scroll: { offset_from_bottom, max_offset_from_bottom, viewport_rows } };
}

export function copyAction(value: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const method = String(value.action), pane_id = publicId(value.id);
  switch (method) {
    case 'pane.scroll': return { method, params: { pane_id, offset_from_bottom: integer(value.offset_from_bottom, Number.MAX_SAFE_INTEGER, 'scroll offset') } };
    case 'pane.copy_motion':
      if (typeof value.motion !== 'string' || !motions.has(value.motion)) throw new ManagementError('Invalid copy motion.');
      return { method, params: { pane_id, cursor: point(value.cursor), motion: value.motion, ...(value.content_revision === undefined ? {} : { content_revision: revision(value.content_revision) }) } };
    case 'pane.selection.read':
      // Browser copies must identify the exact native content they selected.
      return { method, params: { pane_id, anchor: point(value.anchor), cursor: point(value.cursor), content_revision: revision(value.content_revision) } };
    case 'pane.copy_search': {
      if (typeof value.query !== 'string' || !value.query.length || Buffer.byteLength(value.query) > 4096 || value.query.includes('\0')) throw new ManagementError('Invalid terminal search.');
      if (value.direction !== 'forward' && value.direction !== 'backward') throw new ManagementError('Invalid search direction.');
      let previous;
      if (value.previous !== undefined) {
        if (!value.previous || typeof value.previous !== 'object' || Array.isArray(value.previous)) throw new ManagementError('Invalid previous match.');
        const range = value.previous as Record<string, unknown>;
        previous = { start: point(range.start), end: point(range.end) };
      }
      return { method, params: { pane_id, query: value.query, direction: value.direction, cursor: point(value.cursor), content_revision: revision(value.content_revision), ...(previous ? { previous } : {}) } };
    }
    default: throw new ManagementError('Unsupported copy action.');
  }
}
