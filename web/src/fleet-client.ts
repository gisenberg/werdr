import type { FleetEvent, FleetState, Notice } from '../shared/fleet';
export class FleetClient {
  state: FleetState = { revision: 0, hosts: [], notices: [] };
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private attempt = 0;
  private waiting = true;
  constructor(private readonly changed: (state: FleetState, added?: Notice) => void, private readonly connection: (online: boolean) => void) {}
  start() { this.stopped = false; if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) this.connect(); }
  private connect() {
    if (this.stopped) return;
    clearTimeout(this.timer); this.waiting = true;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/fleet`); this.socket = ws;
    ws.onmessage = message => {
      if (this.socket !== ws) return;
      try {
        const event = JSON.parse(message.data) as FleetEvent;
        if (event.type === 'fleet.snapshot') {
          this.state = event.state; this.waiting = false; this.attempt = 0; this.connection(true); this.changed(this.state); return;
        }
        if (this.waiting) return;
        if (event.revision <= this.state.revision) return;
        if (event.revision !== this.state.revision + 1) { this.resync(); return; }
        let added: Notice | undefined;
        if (event.type === 'fleet.host') this.state = { ...this.state, hosts: this.state.hosts.map(host => host.machine.id === event.host.machine.id ? event.host : host) };
        else if (event.type === 'fleet.catalog') this.state = { ...this.state, hosts: event.hosts };
        else if (event.type === 'fleet.notices') { this.state = { ...this.state, notices: event.notices }; added = event.added; }
        else { this.resync(); return; }
        this.state = { ...this.state, revision: event.revision }; this.changed(this.state, added);
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
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.close(); this.socket = undefined; this.connection(false); }
}
