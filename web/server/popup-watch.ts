import { popupSession, type PopupState } from '../shared/popups.ts';
import type { NativeEndpoint } from './native-api.ts';

/** Singleton terminal lifecycle is independent from pane snapshots and output. */
export class PopupWatch {
  private endpoint?: NativeEndpoint;
  private stop?: () => void;
  private epoch = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly receive: (state: PopupState | undefined) => void) {}
  reconcile(endpoint?: NativeEndpoint) {
    if (this.disposed || endpoint === this.endpoint) return;
    this.endpoint = endpoint;
    const epoch = ++this.epoch;
    this.stop?.(); this.stop = undefined; clearTimeout(this.retry);
    this.receive(endpoint?.capabilities?.popup_sessions ? { status: 'loading' } : undefined);
    if (endpoint?.capabilities?.popup_sessions) void this.connect(endpoint, epoch);
  }
  private async connect(endpoint: NativeEndpoint, epoch: number) {
    let sequence = 0, reading = false, dirty = false, stopped = false;
    const current = () => !this.disposed && this.epoch === epoch && !stopped;
    const failed = () => {
      if (!current()) return;
      stopped = true; this.stop?.(); this.stop = undefined;
      this.receive({ status: 'unavailable' });
      this.retry = setTimeout(() => { if (!this.disposed && this.epoch === epoch) void this.connect(endpoint, epoch); }, 5000); this.retry.unref();
    };
    const read = async () => {
      if (!current()) return;
      if (reading) { dirty = true; return; }
      reading = true;
      try {
        do {
          dirty = false; const before = sequence;
          const result = await endpoint.request('popup.get');
          if (!current()) return;
          if (before !== sequence) { dirty = true; continue; }
          this.receive({ status: 'ready', popup: popupSession(result?.popup) });
        } while (dirty && current());
      } catch { failed(); }
      finally { reading = false; }
    };
    try {
      const stop = await endpoint.subscribe([{ type: 'popup.changed' }], event => {
        if (!current() || event.event !== 'popup.changed') return;
        sequence++; void read();
      }, failed);
      if (!current()) { stop(); return; }
      this.stop = stop;
      await read();
    } catch { failed(); }
  }
  dispose() { this.disposed = true; ++this.epoch; this.stop?.(); this.stop = undefined; clearTimeout(this.retry); }
}
