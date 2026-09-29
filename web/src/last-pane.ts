import type { Snapshot } from '../shared/fleet';

/** One previous selection, matching the native toggle rather than an MRU stack. */
export class LastPane {
  private scope?: string;
  private endpoint?: string;
  private boot?: string;
  private suspended = false;
  private current?: { pane: string; terminal: string };
  private previous?: { pane: string; terminal: string };
  reset() { this.scope = undefined; this.endpoint = undefined; this.boot = undefined; this.suspended = false; this.current = undefined; this.previous = undefined; }
  connection(context: { endpoint?: string; enabled: boolean; online: boolean; boot?: unknown; gateway: string; connection?: string }) {
    if (!context.enabled || !context.endpoint) { this.reset(); return; }
    if (this.endpoint !== context.endpoint) { this.reset(); this.endpoint = context.endpoint; }
    if (!context.online) {
      // A stale snapshot can retain history, never authorize an offline target.
      if (this.boot) this.suspended = true;
      else { this.reset(); this.endpoint = context.endpoint; }
      return;
    }
    const boot = typeof context.boot === 'string' && context.boot.length > 0 && context.boot.length <= 256 ? context.boot : undefined;
    const scope = JSON.stringify(boot ? ['runtime', context.endpoint, boot] : ['connection', context.endpoint, context.gateway, context.connection]);
    if (this.scope !== scope) { this.current = undefined; this.previous = undefined; }
    this.scope = scope; this.boot = boot; this.suspended = false;
    return scope;
  }
  observe(scope: string | undefined, pane: string, snapshot: Snapshot) {
    if (this.suspended) return;
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
    if (this.suspended || !scope || scope !== this.scope || current !== this.current?.pane || this.previous?.pane === current) return;
    if (!snapshot.panes.some(item => item.pane_id === current && item.terminal_id === this.current?.terminal)) return;
    const pane = snapshot.panes.find(item => item.pane_id === this.previous?.pane && item.terminal_id === this.previous.terminal);
    if (!pane || !snapshot.workspaces.some(item => item.workspace_id === pane.workspace_id)
      || !snapshot.tabs.some(item => item.tab_id === pane.tab_id && item.workspace_id === pane.workspace_id)) return;
    return pane;
  }
}
