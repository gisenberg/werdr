import type { Api } from './host-manager';
import type { ClientLifecycle } from './client-lifecycle';

type Outcome = { status: 'OK' | 'WARN' | 'ERROR'; message: string };
const failure = (error: unknown): Outcome => ({ status: 'ERROR', message: error instanceof Error ? error.message : String(error) });
function nativeOutcome(value: unknown): Outcome {
  const result = value as { status?: string; diagnostics?: unknown } | null;
  if (!result || !['applied', 'partial', 'failed'].includes(result.status || '') || !Array.isArray(result.diagnostics) || result.diagnostics.some(item => typeof item !== 'string')) return failure('Unexpected host reload response.');
  const status = result.status === 'applied' ? 'OK' : result.status === 'partial' ? 'WARN' : 'ERROR';
  return { status, message: [result.status === 'applied' ? 'Configuration reloaded.' : result.status === 'partial' ? 'Configuration partially reloaded.' : 'Configuration reload failed.', ...result.diagnostics].join(' ') };
}

/** Reload is independent of pane creation, selection, and configuration writes. */
export class ConfigurationReload {
  private pending?: { epoch: number };
  constructor(private readonly api: Api, private readonly preferences: (current: () => boolean) => Promise<boolean>, private readonly lifecycle: ClientLifecycle, private readonly report: (message: string) => void, private readonly changed: () => void) {}
  get busy() { return !!this.pending && this.lifecycle.current(this.pending.epoch); }
  async run(machine: string, label: string) {
    if (!this.lifecycle.active || this.busy) return;
    const pending = { epoch: this.lifecycle.generation }; this.pending = pending;
    const current = () => this.lifecycle.current(pending.epoch);
    this.changed(); this.report(`[WAIT] ${label}: Reloading host configuration and browser preferences.`);
    try {
      const [host, browser] = await Promise.allSettled([
        this.api('/api/action', { machine, action: 'server.reload_config' }),
        this.preferences(current),
      ]);
      if (!current()) return;
      const native = host.status === 'fulfilled' ? nativeOutcome(host.value) : failure(host.reason);
      const local: Outcome = browser.status === 'rejected' ? failure(browser.reason) : browser.value ? { status: 'OK', message: 'Preferences reloaded.' } : { status: 'WARN', message: 'Settings editor is open; preview preserved.' };
      // Put both outcomes first so narrow footers do not hide one of them.
      this.report(`HOST [${native.status}] / BROWSER [${local.status}] / ${label}: ${native.message} / ${local.message}`);
    } finally {
      if (this.pending === pending) { this.pending = undefined; if (current()) this.changed(); }
    }
  }
}
