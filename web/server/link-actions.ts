import { publicId } from './herdr.ts';
import { integer, revision } from './copy-actions.ts';

export async function activatePaneLink(value: Record<string, unknown>, request: (method: string, params: object) => Promise<any>) {
  // Validate the complete request before changing the native focus.
  const params = {
    pane_id: publicId(value.id),
    viewport_row: integer(value.viewport_row, 0xffff, 'viewport row'),
    col: integer(value.col, 0xffff, 'terminal column'),
    content_revision: revision(value.content_revision),
    offset_from_bottom: integer(value.offset_from_bottom, Number.MAX_SAFE_INTEGER, 'scroll offset'),
  };
  await request('pane.focus', { pane_id: params.pane_id });
  return request('pane.link.activate', params);
}
