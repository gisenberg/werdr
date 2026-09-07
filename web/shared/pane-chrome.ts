import type { Pane } from './fleet';
import type { Rect } from './layout';
import type { Preferences } from './settings';

export interface PaneChrome { top: boolean; right: boolean; bottom: boolean; left: boolean }

/** Native apply_pane_chrome rules, expressed in browser surface coordinates. */
export function paneChrome(rect: Rect, width: number, height: number, multiPane: boolean, preferences: Preferences): PaneChrome {
  const enabled = multiPane && preferences.paneBorders;
  const outer = preferences.paneOuterBorders;
  const rightEdge = Math.abs(rect.x + rect.width - width) < .01;
  const bottomEdge = Math.abs(rect.y + rect.height - height) < .01;
  return {
    top: enabled && (outer || rect.y > .01),
    left: enabled && (outer || rect.x > .01),
    right: enabled && (rightEdge ? outer : preferences.paneGaps),
    bottom: enabled && (bottomEdge ? outer : preferences.paneGaps),
  };
}

export function paneBorderLabel(pane: Pane, preferences: Preferences): string {
  return (pane.title || pane.label || (preferences.showAgentLabelsOnPaneBorders ? pane.display_agent || pane.agent || '' : '')).trim();
}
