export type LayoutNode = { type: 'pane'; pane_id: string } | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };
export interface Layout { workspace_id: string; tab_id: string; zoomed: boolean; focused_pane_id: string; root: LayoutNode }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Divider { path: boolean[]; direction: 'right' | 'down'; ratio: number; area: Rect; rect: Rect }
export function geometry(root: LayoutNode, width: number, height: number, gap = 5) {
  const panes = new Map<string, Rect>(), dividers: Divider[] = [];
  function visit(node: LayoutNode, area: Rect, path: boolean[]) {
    if (node.type === 'pane') { panes.set(node.pane_id, area); return; }
    const horizontal = node.direction === 'right', size = horizontal ? area.width : area.height;
    const spacing = Math.min(gap, size), firstSize = Math.max(0, size - spacing) * node.ratio;
    const first = { ...area }, second = { ...area }, rect = { ...area };
    if (horizontal) { first.width = firstSize; second.x += firstSize + spacing; second.width -= firstSize + spacing; rect.x += firstSize; rect.width = spacing; }
    else { first.height = firstSize; second.y += firstSize + spacing; second.height -= firstSize + spacing; rect.y += firstSize; rect.height = spacing; }
    dividers.push({ path, direction: node.direction, ratio: node.ratio, area, rect });
    visit(node.first, first, [...path, false]); visit(node.second, second, [...path, true]);
  }
  visit(root, { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) }, []);
  return { panes, dividers };
}
