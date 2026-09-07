import { publicId } from './herdr.ts';
import { NativeApiError } from './native-api.ts';

type Request = (method: string, params?: object, invalidate?: boolean) => Promise<any>;

export async function paneExists(value: Record<string, unknown>, request: Request) {
  try { await request('pane.get', { pane_id: publicId(value.id) }, false); return { exists: true }; }
  catch (error) { if (error instanceof NativeApiError && error.code === 'pane_not_found') return { exists: false }; throw error; }
}

export async function openScrollbackEditor(value: Record<string, unknown>, request: Request) {
  const pane_id = publicId(value.id);
  const { pane: source } = await request('pane.get', { pane_id }, false);
  const scope = { workspace_id: source.workspace_id };
  const before = await request('pane.list', scope, false);
  const known = new Set(before.panes.map((pane: { pane_id: string }) => pane.pane_id));
  await request('pane.focus', { pane_id });
  await request('pane.edit_scrollback', { pane_id });
  const after = await request('pane.list', scope, false);
  const added = after.panes.filter((pane: { pane_id: string; workspace_id: string; tab_id: string }) => !known.has(pane.pane_id) && pane.workspace_id === source.workspace_id && pane.tab_id === source.tab_id);
  // Native editor invocation currently returns no pane ID. Do not select an
  // arbitrary terminal if a concurrent native client also created a pane.
  if (added.length === 1) {
    const { pane_id, workspace_id, tab_id } = added[0];
    return { pane: { pane_id, workspace_id, tab_id } };
  }
  return { notice: added.length ? 'The host editor was invoked. Choose its pane from the native pane list.' : 'The host editor was invoked, but no editor terminal remains. Graphical editors open on the host; check its editor configuration if nothing opened.' };
}
