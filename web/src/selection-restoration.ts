import type { HostView, Snapshot } from '../shared/fleet';

export interface Selection { machine: string; workspace: string; tab: string; pane: string }
export interface SelectionIdentity { endpoint?: string; terminal?: string }
type ResolvedSelection = { selection: Selection; terminal?: string };
const coordinates = ['machine', 'workspace', 'tab', 'pane'] as const;

export function initialSelection(search: string, savedText: string | null): { selection: Selection; restore: boolean } {
  let saved: Partial<Selection> = {};
  try { const value = JSON.parse(savedText || '{}'); if (value && typeof value === 'object') saved = value; } catch {}
  const query = new URLSearchParams(search);
  const explicit = coordinates.some(key => query.has(key));
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  // URL coordinates form one request. Never fill its descendants from another
  // saved selection; a pane-only or tab-only link resolves its native parents.
  const machine = query.has('machine') ? query.get('machine') || 'local' : text(saved.machine) || 'local';
  const selection = { machine, workspace: '', tab: '', pane: '' };
  for (const key of ['workspace', 'tab', 'pane'] as const) selection[key] = explicit ? query.get(key) || '' : text(saved[key]);
  return { selection, restore: explicit || coordinates.some(key => !!text(saved[key])) };
}

export function resolveSelection(request: Selection, snapshot: Snapshot): ResolvedSelection | undefined {
  const pane = request.pane ? snapshot.panes.find(item => item.pane_id === request.pane) : undefined;
  if (request.pane && !pane) return;
  if (pane && ((request.tab && pane.tab_id !== request.tab) || (request.workspace && pane.workspace_id !== request.workspace))) return;
  let tab = snapshot.tabs.find(item => item.tab_id === (pane?.tab_id || request.tab));
  if ((pane || request.tab) && !tab) return;
  if (pane && tab && pane.workspace_id !== tab.workspace_id) return;
  if (tab && request.workspace && tab.workspace_id !== request.workspace) return;
  const workspace = snapshot.workspaces.find(item => item.workspace_id === (tab?.workspace_id || request.workspace || snapshot.focused_workspace_id)) || (!request.workspace && !tab ? snapshot.workspaces[0] : undefined);
  if ((request.workspace || tab) && !workspace) return;
  tab ||= snapshot.tabs.find(item => item.workspace_id === workspace?.workspace_id && item.tab_id === workspace?.active_tab_id) || snapshot.tabs.find(item => item.workspace_id === workspace?.workspace_id);
  const focused = snapshot.layouts.find(item => item.tab_id === tab?.tab_id)?.focused_pane_id;
  const target = pane || snapshot.panes.find(item => item.tab_id === tab?.tab_id && item.pane_id === focused) || snapshot.panes.find(item => item.tab_id === tab?.tab_id);
  return { selection: { machine: request.machine, workspace: workspace?.workspace_id || '', tab: tab?.tab_id || '', pane: target?.pane_id || '' }, terminal: target?.terminal_id };
}

export class SelectionRestoration {
  private pending?: { request: Selection; endpoint?: string; result?: ResolvedSelection; loading?: boolean; rejected?: boolean; retryAt?: number; checkedAt?: number; attempt: number };
  private timer?: ReturnType<typeof setTimeout>;
  message = 'Checking requested selection...';
  constructor(selection: Selection | undefined, private readonly read: (machine: string) => Promise<Snapshot>, private readonly changed: () => void, private readonly identity?: SelectionIdentity) {
    if (selection) this.pending = { request: selection, attempt: 0 };
  }
  get active() { return !!this.pending; }
  cancel() { this.pending = undefined; clearTimeout(this.timer); }
  supersede() { if (this.pending) { this.pending.rejected = true; clearTimeout(this.timer); this.message = 'Selection changed. Choose a workspace or host.'; } }
  update(host: HostView | undefined): Selection | undefined {
    const pending = this.pending; if (!pending) return;
    if (!host || host.machine.id !== pending.request.machine) { this.message = 'Requested host is unavailable. Choose a host or workspace.'; return; }
    const endpoint = JSON.stringify([host.machine.id, host.machine.target || '', host.machine.session || '']);
    if (this.identity?.endpoint && this.identity.endpoint !== endpoint) { pending.rejected = true; this.message = 'Requested host endpoint changed. Choose the host again.'; return; }
    if (pending.endpoint && pending.endpoint !== endpoint) { pending.rejected = true; pending.result = undefined; this.message = 'Requested host endpoint changed. Choose the host again.'; return; }
    if (pending.rejected) return;
    if (!host.machine.enabled || host.connection !== 'online') { this.message = host.detail || 'Requested host is offline. Waiting for reconnect, or choose another host.'; return; }
    if (pending.result) {
      const cached = host.snapshot && resolveSelection(pending.result.selection, host.snapshot);
      if (cached && JSON.stringify(cached) === JSON.stringify(pending.result)) { this.cancel(); return pending.result.selection; }
      this.message = 'Waiting for native workspace update...';
      if (Date.now() - pending.checkedAt! < 2000) return;
      pending.result = undefined;
    }
    if (pending.loading || (pending.retryAt && Date.now() < pending.retryAt)) return;
    pending.endpoint = endpoint; pending.loading = true; this.message = 'Checking requested selection...';
    void this.read(pending.request.machine).then(snapshot => {
      if (this.pending !== pending || pending.rejected) return;
      pending.result = resolveSelection(pending.request, snapshot);
      if (this.identity?.terminal && pending.result?.terminal !== this.identity.terminal) pending.result = undefined;
      if (!pending.result) { pending.rejected = true; this.message = 'Requested workspace, tab, or pane is unavailable. Choose a workspace or host.'; }
      else {
        this.message = 'Waiting for native workspace update...'; pending.checkedAt = Date.now();
        this.timer = setTimeout(() => { if (this.pending === pending) this.changed(); }, 2000);
      }
    }).catch(() => {
      if (this.pending !== pending || pending.rejected) return;
      this.message = 'Unable to verify requested selection. Retrying, or choose another workspace.';
      const delay = Math.min(500 * 2 ** pending.attempt++, 5000); pending.retryAt = Date.now() + delay;
      this.timer = setTimeout(() => { if (this.pending === pending) this.changed(); }, delay);
    }).finally(() => { pending.loading = false; if (this.pending === pending) this.changed(); });
    return;
  }
}
