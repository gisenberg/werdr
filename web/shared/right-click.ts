/** Browser-representable modifier combinations; Shift always retains menu access. */
export const rightClickModifiers = ['', 'ctrl', 'alt', 'meta', 'ctrl+alt', 'ctrl+meta', 'alt+meta', 'ctrl+alt+meta'] as const;
export type RightClickModifier = typeof rightClickModifiers[number];
export interface MouseModifiers { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

/** Match native routing: reporting plus pane ownership or an exact configured chord. */
export function rightClickRoute(reporting: boolean, paneOwns: boolean, configured: RightClickModifier, event: MouseModifiers): 'menu' | 'pane' {
  if (!reporting || event.shiftKey) return 'menu';
  const held = [event.ctrlKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.metaKey ? 'meta' : ''].filter(Boolean).join('+');
  return paneOwns && !held || configured !== '' && held === configured ? 'pane' : 'menu';
}
