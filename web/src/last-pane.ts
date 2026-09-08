import type { Snapshot } from '../shared/fleet';

/** One previous selection, matching the native toggle rather than an MRU stack. */
export class LastPane {
  private scope?: string;
  private current?: { pane: string; terminal: string };
  private previous?: { pane: string; terminal: string };
  reset() { this.scope = undefined; this.current = undefined; this.previous = undefined; }
  observe(scope: string | undefined, pane: string, snapshot: Snapshot) {
    if (!scope) { this.reset(); return; }
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    const selected = snapshot.panes.find(item => item.pane_id === pane);
    if (!selected) return;
    if (pane === this.current?.pane) {
      if (selected.terminal_id === this.current.terminal) return;
      this.current = undefined; this.previous = undefined;
    }
    this.previous = this.current; this.current = { pane, terminal: selected.terminal_id };
  }
  target(scope: string | undefined, current: string, snapshot: Snapshot) {
    if (!scope || scope !== this.scope || current !== this.current?.pane || this.previous?.pane === current) return;
    if (!snapshot.panes.some(item => item.pane_id === current && item.terminal_id === this.current?.terminal)) return;
    const pane = snapshot.panes.find(item => item.pane_id === this.previous?.pane && item.terminal_id === this.previous.terminal);
    if (!pane || !snapshot.workspaces.some(item => item.workspace_id === pane.workspace_id)
      || !snapshot.tabs.some(item => item.tab_id === pane.tab_id && item.workspace_id === pane.workspace_id)) return;
    return pane;
  }
}
