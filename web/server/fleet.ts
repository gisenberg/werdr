import { PaneScrollWatch } from './pane-scroll-watch.ts';
import type { ScrollState } from '../shared/scrollbar.ts';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { noticeEndpointKey, type Agent, type FleetEvent, type FleetState, type HostView, type Machine, type Notice, type Snapshot } from '../shared/fleet.ts';
import { readNotices, semanticNotice } from './notices.ts';
import { nativeEndpoint, NativeApiError, type NativeEndpoint, type NativeEvent, type Subscription } from './native-api.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const lifecycle: Subscription[] = ['workspace.focused', 'tab.focused', 'pane.focused', 'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed', 'workspace.moved', 'workspace.reordered', 'workspace.closed', 'tab.created', 'tab.closed', 'tab.renamed', 'tab.moved', 'pane.created', 'pane.closed', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.agent_detected', 'layout.updated'].map(type => ({ type }));
const identity = (machine: Machine) => JSON.stringify([machine.target, machine.session, machine.enabled, machine.platform]);
const validSnapshot = (value: any): value is Snapshot => value && typeof value.version === 'string' && ['workspaces', 'tabs', 'panes', 'agents', 'layouts'].every(key => Array.isArray(value[key]) && value[key].length <= 4096) && (value.agent_view === undefined || validAgentView(value.agent_view)) && value.tabs.every((tab: any) => tab.custom_label === undefined || typeof tab.custom_label === 'boolean');
const validAgentView = (view: any): boolean => view && Array.isArray(view.pane_ids) && view.pane_ids.length <= 4096 && view.pane_ids.every((id: any) => typeof id === 'string' && id.length <= 256) && new Set(view.pane_ids).size === view.pane_ids.length && (view.definition === null || view.definition && typeof view.definition.source === 'string' && view.definition.source.length <= 120 && (view.definition.label === undefined || typeof view.definition.label === 'string' && view.definition.label.length <= 128));
interface Host {
  view: HostView; epoch: number; api?: NativeEndpoint; timer?: ReturnType<typeof setTimeout>; health?: ReturnType<typeof setInterval>;
  refreshTimer?: ReturnType<typeof setTimeout>; reading: boolean; dirty: boolean; attempts: number; eventSequence: number;
  pendingNotices: { sequence: number; notice: Notice }[];
  watchKey?: string; stopWatch?: () => void; watching: boolean; baseline: boolean; agentStates: Map<string, Agent>; fingerprint?: string;
}
type NativeRequest = (method: string, params?: object, invalidate?: boolean) => Promise<any>;
export class Fleet extends EventEmitter {
  private hosts = new Map<string, Host>();
  private scrollWatches = new Set<() => void>();
  private actionQueues = new WeakMap<Host, { tail: Promise<unknown>; pending: number }>();
  private order: string[] = [];
  private readonly generation = randomBytes(16).toString('hex');
  private revision = 0;
  private notices: Notice[] = [];
  private catalogTimer?: ReturnType<typeof setInterval>;
  private refreshingCatalog = false;
  private stopped = false;
  private noticeQueue: Promise<unknown> = Promise.resolve();
  private connecting = 0;
  constructor(private readonly catalog: () => Promise<Machine[]>, private readonly noticePath: string, private readonly connect = nativeEndpoint) { super(); }
  async start() {
    const stored = await readPrivateJson(this.noticePath);
    this.notices = readNotices(stored);
    if ((stored as { version?: number } | undefined)?.version === 1) await writePrivateJson(this.noticePath, { version: 2, notices: this.notices });
    await this.reloadCatalog();
    this.catalogTimer = setInterval(() => { void this.reloadCatalog().catch(error => this.emit('diagnostic', error)); }, 2000); this.catalogTimer.unref();
  }
  state(): FleetState { return { generation: this.generation, revision: this.revision, hosts: this.order.map(id => this.hosts.get(id)!.view), notices: this.notices }; }
  private publish(event: Omit<Extract<FleetEvent, { revision: number }>, 'revision'> | any) { if (!this.stopped) { for (const reconcile of this.scrollWatches) reconcile(); this.emit('event', { ...event, revision: ++this.revision } as FleetEvent); } }
  private publishHost(host: Host) { this.publish({ type: 'fleet.host', host: host.view }); }
  async reloadCatalog() {
    if (this.refreshingCatalog || this.stopped) return;
    this.refreshingCatalog = true;
    try {
      const machines = await this.catalog();
      if (this.stopped) return;
      let changed = JSON.stringify(this.order) !== JSON.stringify(machines.map(machine => machine.id));
      const current = new Set(machines.map(machine => machine.id));
      for (const [id, host] of this.hosts) if (!current.has(id)) { this.retire(host); this.hosts.delete(id); changed = true; }
      for (const machine of machines) {
        let host = this.hosts.get(machine.id);
        if (!host) {
          host = { view: { machine, connection: machine.enabled ? 'connecting' : 'disabled' }, epoch: 0, reading: false, dirty: false, attempts: 0, eventSequence: 0, pendingNotices: [], watching: false, baseline: false, agentStates: new Map() };
          this.hosts.set(machine.id, host); changed = true;
          if (machine.enabled) this.schedule(host, 0);
        } else if (identity(host.view.machine) !== identity(machine)) {
          this.retire(host); host.view = { machine, connection: machine.enabled ? 'connecting' : 'disabled' }; host.baseline = false; host.agentStates.clear(); host.fingerprint = undefined; changed = true;
          if (machine.enabled) this.schedule(host, 0);
        } else if (host.view.machine.label !== machine.label) { host.view = { ...host.view, machine }; changed = true; }
      }
      this.order = machines.map(machine => machine.id);
      if (changed) this.publish({ type: 'fleet.catalog', hosts: this.state().hosts });
    } finally { this.refreshingCatalog = false; }
  }
  private retire(host: Host) {
    host.epoch++; clearTimeout(host.timer); clearTimeout(host.refreshTimer); clearInterval(host.health);
    host.refreshTimer = undefined;
    host.stopWatch?.(); host.stopWatch = undefined; host.watchKey = undefined; host.api?.close(); host.api = undefined;
    host.reading = false; host.watching = false; host.dirty = false; host.pendingNotices = [];
  }
  private schedule(host: Host, delay: number) {
    if (this.stopped || !host.view.machine.enabled) return;
    clearTimeout(host.timer); host.view = { ...host.view, retryAt: Date.now() + delay };
    host.timer = setTimeout(() => { void this.open(host); }, delay); host.timer.unref();
  }
  private fail(host: Host, error: Error) {
    if (this.stopped || !host.view.machine.enabled) return;
    this.retire(host);
    const incompatible = error instanceof NativeApiError && error.code === 'incompatible';
    host.view = { ...host.view, connection: incompatible ? 'incompatible' : 'offline', detail: incompatible ? error.message : 'SSH or native server unavailable. Existing sessions are left running.' };
    this.schedule(host, Math.min(1000 * 2 ** Math.min(host.attempts++, 5), 30_000)); this.publishHost(host);
    this.emit('diagnostic', new Error(`${host.view.machine.label}: ${error.message}`));
  }
  private async open(host: Host) {
    if (this.stopped || !host.view.machine.enabled || !this.hosts.has(host.view.machine.id)) return;
    // Bound concurrent SSH handshakes without allowing one failed host to stall others.
    if (this.connecting >= 4) { this.schedule(host, 200); return; }
    const epoch = ++host.epoch; this.connecting++; host.baseline = false;
    host.view = { ...host.view, connection: 'connecting', connectionGeneration: randomBytes(16).toString('hex'), detail: undefined, retryAt: undefined }; this.publishHost(host);
    try {
      const api = await this.connect(host.view.machine);
      if (this.stopped || host.epoch !== epoch) { api.close(); return; }
      host.api = api;
      const subscriptions = api.capabilities?.semantic_notifications ? [...lifecycle, { type: 'notification.semantic' }] : lifecycle;
      await api.subscribe(subscriptions, event => { if (host.epoch === epoch) this.event(host, event); }, error => { if (host.epoch === epoch) this.fail(host, error); });
      if (host.epoch !== epoch) return;
      host.view = { ...host.view, version: api.version };
      await this.refreshHost(host);
      if (host.epoch !== epoch) return;
      // Reconcile after status subscriptions are acknowledged, including changes
      // during initial bootstrap. No terminal surfaces are subscribed here.
      await this.watchAgents(host);
      if (host.epoch !== epoch) return;
      await this.refreshHost(host);
      host.baseline = true; host.attempts = 0;
      host.health = setInterval(() => { if (host.epoch === epoch) this.invalidate(host, 0); }, 10_000); host.health.unref();
    } catch (error) { if (host.epoch === epoch) this.fail(host, error as Error); }
    finally { this.connecting--; }
  }
  private event(host: Host, event: NativeEvent) {
    if (event.event === 'notification.semantic') {
      if (host.api?.capabilities?.semantic_notifications) {
        const notice = semanticNotice(event.data, host.view.machine);
        if (notice) {
          // Separate native sockets can deliver a notification before metadata.
          // Only a snapshot requested after this event can validate its target.
          host.pendingNotices.push({ sequence: ++host.eventSequence, notice });
          host.pendingNotices.splice(0, Math.max(0, host.pendingNotices.length - 256));
          this.invalidate(host, 0);
        }
      }
      return;
    }
    host.eventSequence++;
    if (event.event === 'pane.agent_status_changed') {
      const data = event.data;
      const previous = host.agentStates.get(data.pane_id);
      if (previous && typeof data.agent_status === 'string') {
        const next = { ...previous, ...data } as Agent;
        if (host.baseline) this.transition(host, previous, next);
        host.agentStates.set(data.pane_id, next);
      }
    }
    this.invalidate(host, 60);
  }
  private invalidate(host: Host, delay: number) {
    if (host.reading) { host.dirty = true; return; }
    if (host.refreshTimer) return;
    host.refreshTimer = setTimeout(() => {
      host.refreshTimer = undefined;
      void this.refreshHost(host).catch(error => this.fail(host, error));
    }, delay); host.refreshTimer.unref();
  }
  private async refreshHost(host: Host) {
    if (!host.api || this.stopped) return;
    if (host.reading) { host.dirty = true; return; }
    host.reading = true; host.dirty = false;
    const epoch = host.epoch, sequence = host.eventSequence;
    try {
      const result = await host.api.request('session.snapshot');
      if (host.epoch !== epoch) return;
      const snapshot = result?.snapshot;
      if (!validSnapshot(snapshot)) throw new Error('Invalid native metadata snapshot');
      const agentIds = new Set(snapshot.agents.map(agent => agent.pane_id));
      for (const id of host.agentStates.keys()) if (!agentIds.has(id)) host.agentStates.delete(id);
      for (const next of snapshot.agents) {
        const previous = host.agentStates.get(next.pane_id);
        if (!previous || previous.terminal_id !== next.terminal_id) host.agentStates.set(next.pane_id, next);
        else if (sequence === host.eventSequence) {
          if (host.baseline) this.transition(host, previous, next);
          host.agentStates.set(next.pane_id, next);
        }
      }
      const fingerprint = JSON.stringify(snapshot);
      const changed = host.fingerprint !== fingerprint || host.view.connection !== 'online';
      host.fingerprint = fingerprint;
      host.view = { ...host.view, snapshot, connection: 'online', detail: undefined, lastSeen: Date.now(), retryAt: undefined };
      if (changed) this.publishHost(host);
      const ready = host.pendingNotices.filter(item => item.sequence <= sequence);
      host.pendingNotices = host.pendingNotices.filter(item => item.sequence > sequence);
      for (const { notice } of ready) this.recordNotice(host, notice);
      if (host.baseline) await this.watchAgents(host);
    } catch (error) { if (host.epoch === epoch) throw error; } finally {
      if (host.epoch === epoch) {
        host.reading = false;
        if (host.dirty || sequence !== host.eventSequence) this.invalidate(host, 60);
      }
    }
  }
  private async watchAgents(host: Host) {
    if (!host.api || !host.view.snapshot || host.watching) return;
    const ids = host.view.snapshot.panes.map(pane => pane.pane_id).sort();
    const subscriptions: Subscription[] = ids.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id }));
    if (host.view.snapshot.agent_view) subscriptions.push({ type: 'agent.view.changed' });
    const key = JSON.stringify(subscriptions);
    if (host.watchKey === key) return;
    const epoch = host.epoch; host.watching = true;
    try {
      let stop: (() => void) | undefined;
      if (subscriptions.length) stop = await host.api.subscribe(subscriptions, event => { if (host.epoch === epoch) this.event(host, event); }, error => { if (host.epoch === epoch) this.fail(host, error); });
      if (host.epoch !== epoch) { stop?.(); return; }
      host.stopWatch?.(); host.stopWatch = stop; host.watchKey = key;
      this.invalidate(host, 0);
    } catch (error) {
      // A pane may close while a replacement subscription is being established.
      if (error instanceof NativeApiError && ['pane_not_found', 'not_found', 'invalid_params'].includes(error.code)) this.invalidate(host, 100);
      else throw error;
    } finally { if (host.epoch === epoch) host.watching = false; }
  }
  private transition(host: Host, previous: Agent, next: Agent) {
    if (host.api?.capabilities?.semantic_notifications) return;
    if (previous.agent_status === next.agent_status || previous.terminal_id !== next.terminal_id) return;
    const previousLabel = previous.display_agent || previous.agent, nextLabel = next.display_agent || next.agent;
    const completion = next.agent_status === 'done' && (['working', 'blocked'].includes(previous.agent_status) || (previous.agent_status === 'unknown' && !!previousLabel && previousLabel === nextLabel));
    const kind = next.agent_status === 'blocked' ? 'attention' : completion ? 'finished' : undefined;
    if (!kind) return;
    const name = next.name || next.display_agent || next.agent || next.title || next.pane_id;
    const notice: Notice = { id: randomBytes(16).toString('hex'), machineId: host.view.machine.id, machineLabel: host.view.machine.label, endpointKey: noticeEndpointKey(host.view.machine), terminalId: next.terminal_id, paneId: next.pane_id, workspaceId: next.workspace_id, tabId: next.tab_id, title: kind === 'attention' ? `${name} needs attention` : `${name} finished`, body: `${host.view.machine.label} / ${next.workspace_id} / ${next.pane_id}`, kind, sound: kind === 'attention' ? 'request' : 'done', ...(next.agent ? { agent: next.agent } : {}), created: Date.now(), read: false };
    this.recordNotice(host, notice);
  }
  private recordNotice(host: Host, notice: Notice) {
    const epoch = host.epoch;
    const current = () => !this.stopped && host.epoch === epoch && this.hosts.get(host.view.machine.id) === host;
    void this.updateNotices(notices => { notices.unshift(notice); notices.splice(256); }, notice, current).catch(error => this.emit('diagnostic', error));
  }
  private updateNotices(change: (notices: Notice[]) => void, added?: Notice, current = () => !this.stopped) {
    const task = this.noticeQueue.then(async () => {
      if (!current()) return;
      const notices = this.notices.map(notice => ({ ...notice })); change(notices);
      await writePrivateJson(this.noticePath, { version: 2, notices }); this.notices = notices;
      // History survives a disconnect during disk I/O, but its delayed write
      // must not become a new alert from a retired endpoint.
      this.publish({ type: 'fleet.notices', notices, ...(added && current() ? { added } : {}) });
    });
    this.noticeQueue = task.catch(() => {}); return task;
  }
  markNoticesRead(id?: string) { return this.updateNotices(notices => { for (const notice of notices) if (!id || notice.id === id) notice.read = true; }); }
  watchPaneScroll(machine: Machine, pane: string, receive: (state: ScrollState | undefined, ready: boolean) => void) {
    const expected = identity(machine), watch = new PaneScrollWatch(pane, receive);
    const reconcile = () => {
      const host = this.hosts.get(machine.id);
      watch.reconcile(host?.view.connection === 'online' && identity(host.view.machine) === expected ? host.api : undefined);
    };
    this.scrollWatches.add(reconcile); reconcile();
    return () => { this.scrollWatches.delete(reconcile); watch.dispose(); };
  }
  async request(machineId: string, method: string, params: object = {}, invalidate = true) {
    return this.requestScope(machineId)(method, params, invalidate);
  }
  private requestScope(machineId: string): NativeRequest {
    const host = this.hosts.get(machineId);
    if (!host?.api || host.view.connection !== 'online' || !host.view.machine.enabled) throw new NativeApiError('Selected host is not connected', 'offline');
    const epoch = host.epoch, api = host.api;
    const current = () => {
      if (this.stopped || this.hosts.get(machineId) !== host || host.epoch !== epoch || host.api !== api || host.view.connection !== 'online' || !host.view.machine.enabled) throw new NativeApiError('Host changed while the action was running; refresh before retrying.', 'interrupted');
    };
    return async (method, params = {}, invalidate = true) => {
      current(); const result = await api.request(method, params); current();
      if (invalidate) this.invalidate(host, 0); return result;
    };
  }
  async action<T>(machineId: string, operation: (request: NativeRequest) => Promise<T>): Promise<T> {
    // Focus followed by a plugin command is one browser action. Keep other
    // browser mutations out of that interval and pin every step to this endpoint.
    const request = this.requestScope(machineId), host = this.hosts.get(machineId)!;
    let queue = this.actionQueues.get(host);
    if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; this.actionQueues.set(host, queue); }
    if (queue.pending >= 32) throw new NativeApiError('This host has too many pending actions. Wait for an action to finish.', 'busy');
    queue.pending++;
    const result = queue.tail.then(() => operation(request));
    queue.tail = result.then(() => {}, () => {});
    return result.finally(() => { queue.pending--; });
  }
  retry(machineId: string) {
    const host = this.hosts.get(machineId);
    if (!host?.view.machine.enabled) return;
    if (host.api && host.view.connection === 'online') this.invalidate(host, 0);
    else { this.retire(host); host.attempts = 0; this.schedule(host, 0); }
  }
  stop() { this.stopped = true; clearInterval(this.catalogTimer); for (const host of this.hosts.values()) this.retire(host); for (const reconcile of this.scrollWatches) reconcile(); this.scrollWatches.clear(); }
}
