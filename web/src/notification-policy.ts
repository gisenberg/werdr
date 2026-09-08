import { noticeEndpointKey, type FleetState, type HostView, type Notice, type Pane } from '../shared/fleet';
import type { Preferences } from '../shared/settings';

export interface NotificationContext { machine: string; workspace: string; tab: string; focused: boolean }
export interface NotificationEffect { kind: 'sound' | 'desktop'; notice: Notice }
interface Pending { notice: Notice; deadline: number; expires: number; validate: boolean }
export interface VisibleNotification { notice: Notice; deadline: number }
export type NotificationTarget = { kind: 'pane'; host: HostView; pane: Pane } | { kind: 'none' | 'offline' | 'stale' };
const durations = { attention: 8000, finished: 5000, update: 3000, custom: 5000 };

function hostFor(state: FleetState, notice: Notice) {
  return state.hosts.find(host => host.machine.id === notice.machineId && notice.endpointKey === noticeEndpointKey(host.machine));
}
function paneFor(host: HostView, notice: Notice) {
  if (!notice.terminalId) return;
  const panes = host.snapshot?.panes;
  // Resolve current ancestry after native pane moves, but never guess between
  // several projections of one terminal or a recycled public pane identifier.
  const exact = panes?.find(pane => pane.pane_id === notice.paneId && pane.terminal_id === notice.terminalId);
  if (exact) return exact;
  let moved: Pane | undefined;
  for (const pane of panes ?? []) if (pane.terminal_id === notice.terminalId) { if (moved) return; moved = pane; }
  return moved;
}
export function notificationTarget(state: FleetState, notice: Notice): NotificationTarget {
  const host = hostFor(state, notice);
  if (!host) return { kind: 'stale' };
  if (!notice.paneId) return { kind: 'none' };
  if (!host.machine.enabled || host.connection !== 'online') return { kind: 'offline' };
  const pane = paneFor(host, notice);
  if (!pane || !host.snapshot?.tabs.some(tab => tab.tab_id === pane.tab_id && tab.workspace_id === pane.workspace_id) || !host.snapshot.workspaces.some(workspace => workspace.workspace_id === pane.workspace_id)) return { kind: 'stale' };
  return { kind: 'pane', host, pane };
}

/** Client-owned native notification policy. All deadlines use one monotonic clock. */
export class NotificationPolicy {
  visible?: VisibleNotification;
  private pending: Pending[] = [];
  private queued: Notice[] = [];
  private seen = new Set<string>();
  reset() { this.visible = undefined; this.pending = []; this.queued = []; this.seen.clear(); }
  receive(notice: Notice, now: number, preferences: Preferences) {
    if (this.seen.has(notice.id)) return;
    this.seen.add(notice.id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    const samePane = (other: Notice) => !!notice.paneId && other.machineId === notice.machineId && other.endpointKey === notice.endpointKey && other.paneId === notice.paneId;
    this.pending = this.pending.filter(item => !samePane(item.notice));
    this.queued = this.queued.filter(item => !samePane(item));
    if (this.visible && samePane(this.visible.notice)) { this.visible = undefined; this.promote(now, preferences); }
    if (notice.kind === 'attention' && !preferences.notificationAttention || notice.kind === 'finished' && !preferences.notificationFinished) return;
    const delay = notice.kind === 'custom' ? 0 : preferences.toastDelaySeconds * 1000;
    if (this.pending.length === 256) this.pending.shift();
    this.pending.push({ notice, deadline: now + delay, expires: now + 1000, validate: delay > 0 || notice.kind === 'finished' });
  }
  tick(now: number, state: FleetState, context: NotificationContext, preferences: Preferences): NotificationEffect[] {
    // Endpoint retirement cancels presentation. Temporary disconnects retain it.
    this.pending = this.pending.filter(item => hostFor(state, item.notice));
    this.queued = this.queued.filter(item => hostFor(state, item));
    if (this.visible && (!hostFor(state, this.visible.notice) || now >= this.visible.deadline)) this.visible = undefined;
    this.promote(now, preferences);
    const effects: NotificationEffect[] = [], pending = this.pending; this.pending = [];
    for (const item of pending) {
      if (item.deadline > now) { this.pending.push(item); continue; }
      const { notice } = item;
      if (notice.kind === 'attention' && !preferences.notificationAttention || notice.kind === 'finished' && !preferences.notificationFinished) continue;
      if (item.validate) {
        const validation = this.validate(state, notice);
        if (validation === 'awaiting' && now < item.expires) { item.deadline = Math.min(now + 50, item.expires); this.pending.push(item); continue; }
        if (validation !== 'current') continue;
      }
      const active = context.machine === notice.machineId && (!!notice.tabId ? context.tab === notice.tabId : !!notice.workspaceId && context.workspace === notice.workspaceId);
      const suppressExternal = active && context.focused;
      if (preferences.notificationSound && notice.sound && !(notice.kind === 'finished' && suppressExternal)) effects.push({ kind: 'sound', notice });
      if ((preferences.toastDelivery === 'browser' || preferences.toastDelivery === 'both') && !active && this.duration(notice, preferences) > 0) {
        if (this.visible) {
          if (this.queued.length === 8) this.queued.shift();
          this.queued.push(notice);
        } else this.visible = { notice, deadline: now + this.duration(notice, preferences) };
      }
      if ((preferences.toastDelivery === 'desktop' || preferences.toastDelivery === 'both') && !suppressExternal) effects.push({ kind: 'desktop', notice });
    }
    return effects;
  }
  consume(id: string, now: number, preferences: Preferences) {
    if (this.visible?.notice.id !== id) return false;
    this.visible = undefined; this.promote(now, preferences); return true;
  }
  get nextDeadline() {
    const deadlines = this.pending.map(item => item.deadline);
    if (this.visible) deadlines.push(this.visible.deadline);
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }
  private duration(notice: Notice, preferences: Preferences) { return preferences.toastNativeDuration ? durations[notice.kind] : preferences.toastSeconds * 1000; }
  private promote(now: number, preferences: Preferences) {
    if (this.visible) return;
    while (this.queued.length) {
      const notice = this.queued.shift()!, duration = this.duration(notice, preferences);
      if (duration > 0) { this.visible = { notice, deadline: now + duration }; break; }
    }
  }
  private validate(state: FleetState, notice: Notice): 'current' | 'awaiting' | 'stale' {
    if (!notice.paneId) return notice.kind === 'finished' ? 'stale' : 'current';
    const host = hostFor(state, notice), pane = host && paneFor(host, notice);
    const agent = pane && host?.snapshot?.agents.find(agent => agent.pane_id === pane.pane_id && agent.terminal_id === notice.terminalId);
    if (!agent) return 'awaiting';
    if (notice.kind === 'custom' || notice.kind === 'update') return 'current';
    if (notice.kind === 'attention') return agent.agent_status === 'blocked' ? 'current' : 'stale';
    return agent.agent_status === 'done' ? 'current' : agent.agent_status === 'working' ? 'awaiting' : 'stale';
  }
}
