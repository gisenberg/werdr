import { scrollState, type ScrollState } from '../shared/scrollbar.ts';
import type { NativeEndpoint } from './native-api.ts';

// One metadata subscription per attached terminal, using the existing host API.
// Output bytes never trigger a snapshot request or a fleet-wide publication.
export class PaneScrollWatch {
  private endpoint?: NativeEndpoint;
  private stop?: () => void;
  private epoch = 0;
  private disposed = false;
  constructor(private readonly pane: string, private readonly receive: (state: ScrollState | undefined, ready: boolean) => void) {}
  reconcile(endpoint: NativeEndpoint | undefined) {
    if (this.disposed || endpoint === this.endpoint) return;
    this.endpoint = endpoint; const epoch = ++this.epoch;
    this.stop?.(); this.stop = undefined; this.receive(undefined, !endpoint);
    if (endpoint) void this.connect(endpoint, epoch);
  }
  private async connect(endpoint: NativeEndpoint, epoch: number) {
    let sequence = 0;
    const current = () => !this.disposed && this.epoch === epoch;
    try {
      const stop = await endpoint.subscribe([{ type: 'pane.scroll_changed', pane_id: this.pane }], event => {
        if (!current() || event.event !== 'pane.scroll_changed' || event.data?.pane_id !== this.pane) return;
        sequence++; this.receive(scrollState(event.data.scroll), true);
      }, () => {
        if (!current()) return;
        ++this.epoch; this.stop?.(); this.stop = undefined; this.receive(undefined, true);
      });
      if (!current()) { stop(); return; }
      this.stop = stop;
      const before = sequence;
      const result = await endpoint.request('pane.get', { pane_id: this.pane });
      if (current() && sequence === before) this.receive(scrollState(result.pane?.scroll), true);
    } catch {
      if (!current()) return;
      this.stop?.(); this.stop = undefined; this.receive(undefined, true);
      // Missing optional methods affect this gutter only. The host and terminal
      // remain usable; reconnecting the endpoint negotiates the feature again.
    }
  }
  dispose() { this.disposed = true; ++this.epoch; this.stop?.(); this.stop = undefined; }
}
