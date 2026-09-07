import type { Layout, LayoutNode } from '../shared/layout.ts';
import { publicId } from './herdr.ts';
// Exported native layouts can contain commands and environment variables.
// Only geometry and public identities cross the browser boundary.
export function browserLayout(value: any): Layout {
  const layout = value.layout;
  let count = 0;
  const ids = new Set<string>();
  function node(value: any, depth: number): LayoutNode {
    if (++count > 1023 || depth > 64 || !value) throw new Error('Invalid native layout');
    if (value.type === 'pane') {
      const id = publicId(value.pane_id); if (ids.has(id)) throw new Error('Duplicate native pane'); ids.add(id);
      return { type: 'pane', pane_id: id };
    }
    if (value.type !== 'split' || !['right', 'down'].includes(value.direction) || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio >= 1) throw new Error('Invalid native split');
    return { type: 'split', direction: value.direction, ratio: value.ratio, first: node(value.first, depth + 1), second: node(value.second, depth + 1) };
  }
  if (!layout || typeof layout.zoomed !== 'boolean') throw new Error('Invalid native layout');
  const root = node(layout.root, 0), focused = publicId(layout.focused_pane_id);
  if (!ids.has(focused)) throw new Error('Invalid native focus');
  return { workspace_id: publicId(layout.workspace_id), tab_id: publicId(layout.tab_id), zoomed: layout.zoomed, focused_pane_id: focused, root };
}
