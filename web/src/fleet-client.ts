import type { FleetEvent, FleetState, Notice } from '../shared/fleet';
export class FleetClient {
  state: FleetState = { generation: '', revision: 0, hosts: [], notices: [] };
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private attempt = 0;
  private waiting = true;
  private sequence = 0;
  private minimumVersion = 0;
  private streamGeneration?: string;
  get version() { return this.sequence; }
  constructor(private readonly changed: (state: FleetState, added?: Notice) => void, private readonly connection: (online: boolean) => void) {}
  acceptSnapshot(state: FleetState, observedVersion = this.sequence): boolean {
    if (observedVersion < this.minimumVersion) return false;
    if (state.generation !== this.state.generation && this.state.generation && observedVersion !== this.sequence) return false;
    if (state.generation === this.state.generation && state.revision < this.state.revision) return false;
    this.state = state; ++this.sequence;
    if (this.streamGeneration && this.streamGeneration !== state.generation) this.socket?.close(1000, 'Fleet generation changed');
    this.changed(this.state); return true;
  }
  start() { this.stopped = false; if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) this.connect(); }
  private connect() {
    if (this.stopped) return;
    clearTimeout(this.timer); this.waiting = true;
    const startedAt = this.sequence; this.streamGeneration = undefined;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/fleet`); this.socket = ws;
    ws.onmessage = message => {
      if (this.socket !== ws) return;
      try {
        const event = JSON.parse(message.data) as FleetEvent;
        if (event.type === 'fleet.snapshot') {
          // HTTP and WebSocket snapshots share one ordering authority. If a
          // concurrent read changed generations since connect began, reconnect
          // before accepting an ambiguous initial stream snapshot.
          if (event.state.generation !== this.state.generation && this.state.generation && startedAt !== this.sequence) { ws.close(1000, 'Fleet generation changed'); return; }
          this.streamGeneration = event.state.generation;
          this.waiting = false; this.attempt = 0; this.acceptSnapshot(event.state, startedAt); this.connection(true); return;
        }
        if (this.waiting) return;
        if (this.streamGeneration !== this.state.generation) { ws.close(1000, 'Fleet generation changed'); return; }
        if (event.revision <= this.state.revision) return;
        if (event.revision !== this.state.revision + 1) { this.resync(); return; }
        let added: Notice | undefined;
        if (event.type === 'fleet.host') this.state = { ...this.state, hosts: this.state.hosts.map(host => host.machine.id === event.host.machine.id ? event.host : host) };
        else if (event.type === 'fleet.catalog') this.state = { ...this.state, hosts: event.hosts };
        else if (event.type === 'fleet.notices') { this.state = { ...this.state, notices: event.notices }; added = event.added; }
        else { this.resync(); return; }
        this.state = { ...this.state, revision: event.revision }; ++this.sequence; this.changed(this.state, added);
      } catch { ws.close(1002, 'Invalid fleet frame'); }
    };
    ws.onclose = () => {
      if (this.socket !== ws || this.stopped) return;
      this.connection(false);
      this.timer = setTimeout(() => this.connect(), Math.min(500 * 2 ** this.attempt++, 15_000));
    };
    ws.onerror = () => ws.close();
  }
  resync() {
    if (this.socket?.readyState === WebSocket.OPEN) { this.waiting = true; this.socket.send(JSON.stringify({ type: 'fleet.resync' })); }
    else this.start();
  }
  stop() { this.minimumVersion = ++this.sequence; this.streamGeneration = undefined; this.stopped = true; clearTimeout(this.timer); this.socket?.close(); this.socket = undefined; this.connection(false); }
}
