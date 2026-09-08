import { commandCatalog, type CommandCatalog } from '../shared/commands.ts';
import type { NativeEndpoint } from './native-api.ts';

/** Config metadata has its own lifetime; pane output never triggers a catalog read. */
export class CommandCatalogWatch {
  private endpoint?: NativeEndpoint;
  private stop?: () => void;
  private epoch = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly receive: (catalog: CommandCatalog | undefined) => void) {}
  reconcile(endpoint?: NativeEndpoint) {
    if (this.disposed || endpoint === this.endpoint) return;
    this.endpoint = endpoint;
    const epoch = ++this.epoch;
    this.stop?.(); this.stop = undefined; clearTimeout(this.retry);
    this.receive(endpoint?.capabilities?.command_catalog ? { status: 'loading', commands: [] } : undefined);
    if (endpoint?.capabilities?.command_catalog) void this.connect(endpoint, epoch);
  }
  private async connect(endpoint: NativeEndpoint, epoch: number) {
    let sequence = 0, reading = false, dirty = false, stopped = false;
    const current = () => !this.disposed && this.epoch === epoch && !stopped;
    const failed = () => {
      if (!current()) return;
      stopped = true; this.stop?.(); this.stop = undefined;
      this.receive({ status: 'unavailable', commands: [] });
      this.retry = setTimeout(() => { if (!this.disposed && this.epoch === epoch) void this.connect(endpoint, epoch); }, 5000); this.retry.unref();
    };
    const read = async () => {
      if (!current()) return;
      if (reading) { dirty = true; return; }
      reading = true;
      try {
        do {
          dirty = false; const before = sequence;
          const result = await endpoint.request('command.list');
          if (!current()) return;
          if (before !== sequence) { dirty = true; continue; }
          this.receive({ status: 'ready', commands: commandCatalog(result?.commands) });
        } while (dirty && current());
      } catch { failed(); }
      finally { reading = false; }
    };
    try {
      const stop = await endpoint.subscribe([{ type: 'command.manifest_changed' }], event => {
        if (!current() || event.event !== 'command.manifest_changed') return;
        sequence++; this.receive({ status: 'loading', commands: [] }); void read();
      }, failed);
      if (!current()) { stop(); return; }
      this.stop = stop;
      await read();
    } catch { failed(); }
  }
  dispose() { this.disposed = true; ++this.epoch; this.stop?.(); this.stop = undefined; clearTimeout(this.retry); }
}
