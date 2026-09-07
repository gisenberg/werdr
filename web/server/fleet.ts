import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Agent, AgentStatus, FleetEvent, FleetState, HostView, Machine, Notice, Snapshot } from '../shared/fleet.ts';
import { nativeEndpoint, NativeApiError, type NativeEndpoint, type NativeEvent, type Subscription } from './native-api.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const lifecycle: Subscription[] = ['workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed', 'workspace.moved', 'workspace.reordered', 'workspace.closed', 'tab.created', 'tab.closed', 'tab.renamed', 'tab.moved', 'pane.created', 'pane.closed', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.agent_detected', 'layout.updated'].map(type => ({ type }));
const identity = (machine: Machine) => JSON.stringify([machine.target, machine.session, machine.enabled, machine.platform]);
const validSnapshot = (value: any): value is Snapshot => value && typeof value.version === 'string' && ['workspaces', 'tabs', 'panes', 'agents', 'layouts'].every(key => Array.isArray(value[key]) && value[key].length <= 4096);
interface Host {
  view: HostView; epoch: number; api?: NativeEndpoint; timer?: ReturnType<typeof setTimeout>; health?: ReturnType<typeof setInterval>;
  refreshTimer?: ReturnType<typeof setTimeout>; reading: boolean; dirty: boolean; attempts: number; eventSequence: number;
  watchKey?: string; stopWatch?: () => void; watching: boolean; baseline: boolean; agentStates: Map<string, Agent>; fingerprint?: string;
}
export class Fleet extends EventEmitter {
  private hosts = new Map<string, Host>();
  private order: string[] = [];
  private revision = 0;
  private notices: Notice[] = [];
  private catalogTimer?: ReturnType<typeof setInterval>;
  private refreshingCatalog = false;
  private stopped = false;
  private noticeQueue: Promise<unknown> = Promise.resolve();
  private connecting = 0;
  constructor(private readonly catalog: () => Promise<Machine[]>, private readonly noticePath: string, private readonly connect = nativeEndpoint) { super(); }
  async start() {
    const stored = await readPrivateJson(this.noticePath) as any;
    if (stored !== undefined) {
      if (stored.version !== 1 || !Array.isArray(stored.notices) || stored.notices.length > 256 || stored.notices.some((notice: any) => !notice || typeof notice.id !== 'string' || typeof notice.created !== 'number' || typeof notice.read !== 'boolean' || !['attention', 'finished'].includes(notice.kind) || ['machineId', 'machineLabel', 'paneId', 'workspaceId', 'tabId', 'title', 'body'].some(key => typeof notice[key] !== 'string' || notice[key].length > 1024))) throw new Error('Invalid fleet notification store');
      this.notices = stored.notices;
    }
    await this.reloadCatalog();
    this.catalogTimer = setInterval(() => { void this.reloadCatalog().catch(error => this.emit('diagnostic', error)); }, 2000); this.catalogTimer.unref();
  }
  state(): FleetState { return { revision: this.revision, hosts: this.order.map(id => this.hosts.get(id)!.view), notices: this.notices }; }
  private publish(event: Omit<Extract<FleetEvent, { revision: number }>, 'revision'> | any) { if (!this.stopped) this.emit('event', { ...event, revision: ++this.revision } as FleetEvent); }
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
          host = { view: { machine, connection: machine.enabled ? 'connecting' : 'disabled' }, epoch: 0, reading: false, dirty: false, attempts: 0, eventSequence: 0, watching: false, baseline: false, agentStates: new Map() };
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
    host.stopWatch?.(); host.stopWatch = undefined; host.watchKey = undefined; host.api?.close(); host.api = undefined;
    host.reading = false; host.watching = false; host.dirty = false;
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
    const epoch = ++host.epoch; this.connecting++;
    host.view = { ...host.view, connection: 'connecting', detail: undefined, retryAt: undefined }; this.publishHost(host);
    try {
      const api = await this.connect(host.view.machine);
      if (this.stopped || host.epoch !== epoch) { api.close(); return; }
      host.api = api;
      await api.subscribe(lifecycle, event => { if (host.epoch === epoch) this.event(host, event); }, error => { if (host.epoch === epoch) this.fail(host, error); });
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
    const key = JSON.stringify(ids);
    if (host.watchKey === key) return;
    const epoch = host.epoch; host.watching = true;
    try {
      let stop: (() => void) | undefined;
      if (ids.length) stop = await host.api.subscribe(ids.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })), event => { if (host.epoch === epoch) this.event(host, event); }, error => { if (host.epoch === epoch) this.fail(host, error); });
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
    if (previous.agent_status === next.agent_status || previous.terminal_id !== next.terminal_id) return;
    const completion = ['idle', 'done'].includes(next.agent_status) && (['working', 'blocked'].includes(previous.agent_status) || (previous.agent_status === 'unknown' && !!previous.agent && previous.agent === next.agent));
    const kind = next.agent_status === 'blocked' ? 'attention' : completion ? 'finished' : undefined;
    if (!kind) return;
    const name = next.name || next.display_agent || next.agent || next.title || next.pane_id;
    const notice: Notice = { id: randomBytes(16).toString('hex'), machineId: host.view.machine.id, machineLabel: host.view.machine.label, paneId: next.pane_id, workspaceId: next.workspace_id, tabId: next.tab_id, title: kind === 'attention' ? `${name} needs attention` : `${name} finished`, body: `${host.view.machine.label} / ${next.workspace_id} / ${next.pane_id}`, kind, created: Date.now(), read: false };
    void this.updateNotices(notices => { notices.unshift(notice); notices.splice(256); }, notice).catch(error => this.emit('diagnostic', error));
  }
  private updateNotices(change: (notices: Notice[]) => void, added?: Notice) {
    const task = this.noticeQueue.then(async () => {
      const notices = this.notices.map(notice => ({ ...notice })); change(notices);
      await writePrivateJson(this.noticePath, { version: 1, notices }); this.notices = notices;
      this.publish({ type: 'fleet.notices', notices, ...(added ? { added } : {}) });
    });
    this.noticeQueue = task.catch(() => {}); return task;
  }
  markNoticesRead(id?: string) { return this.updateNotices(notices => { for (const notice of notices) if (!id || notice.id === id) notice.read = true; }); }
  async request(machineId: string, method: string, params: object = {}, invalidate = true) {
    const host = this.hosts.get(machineId);
    if (!host?.api || host.view.connection !== 'online' || !host.view.machine.enabled) throw new NativeApiError('Selected host is not connected', 'offline');
    const epoch = host.epoch;
    const result = await host.api.request(method, params);
    if (host.epoch !== epoch) throw new NativeApiError('Host changed while the action was running; refresh before retrying.', 'interrupted');
    if (invalidate) this.invalidate(host, 0); return result;
  }
  retry(machineId: string) {
    const host = this.hosts.get(machineId);
    if (!host?.view.machine.enabled) return;
    if (host.api && host.view.connection === 'online') this.invalidate(host, 0);
    else { this.retire(host); host.attempts = 0; this.schedule(host, 0); }
  }
  stop() { this.stopped = true; clearInterval(this.catalogTimer); for (const host of this.hosts.values()) this.retire(host); }
}
