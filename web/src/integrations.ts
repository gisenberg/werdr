import type { Api } from './host-manager';
interface Integration { target: string; label: string; command: string; available: boolean; state: 'not_installed' | 'current' | 'outdated' }
interface Target { machine: string; label: string }
export const integrationsMarkup = `<dialog id="integrations-dialog"><h1>INTEGRATIONS</h1><p id="integration-host"></p><p>Manage herdr's agent hooks on this host.</p><div class="inline-actions"><button id="integration-refresh">REFRESH</button><button id="integration-recommended">INSTALL RECOMMENDED</button></div><div id="integration-list"></div><pre id="integration-results" role="status"></pre><p id="integration-error" role="alert"></p><button id="integration-done">DONE</button></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class Integrations {
  private target?: Target;
  private items: Integration[] = [];
  private busy = false;
  private epoch = 0;
  constructor(private api: Api, private selected: () => Target | undefined) {
    el('integration-done').onclick = () => el<HTMLDialogElement>('integrations-dialog').close();
    el('integrations-dialog').addEventListener('close', () => { ++this.epoch; });
    el('integration-refresh').onclick = () => void this.load();
    el('integration-recommended').onclick = () => void this.change('integration.install', this.items.filter(item => item.state === 'outdated' || item.available && item.state === 'not_installed'));
  }
  open() {
    if (this.busy) return;
    const target = this.selected(); if (!target) return;
    ++this.epoch; this.target = { ...target }; this.items = [];
    el('integration-host').textContent = target.label; el('integration-results').textContent = ''; el('integration-error').textContent = '';
    this.render(); el<HTMLDialogElement>('integrations-dialog').showModal(); void this.load();
  }
  private async load() {
    if (this.busy || !this.target) return;
    this.busy = true; const epoch = this.epoch; this.render(); el('integration-error').textContent = '';
    try { const { integrations } = await this.api('/api/action', { machine: this.target.machine, action: 'integration.list' }); if (epoch === this.epoch) this.items = integrations; }
    catch (error) { if (epoch === this.epoch) el('integration-error').textContent = (error as Error).message; }
    finally { this.busy = false; this.render(); }
  }
  private render() {
    el<HTMLButtonElement>('integration-refresh').disabled = this.busy;
    el<HTMLButtonElement>('integration-recommended').disabled = this.busy || !this.items.some(item => item.state === 'outdated' || item.available && item.state === 'not_installed');
    const parent = el('integration-list'); parent.replaceChildren();
    for (const item of this.items) {
      const row = document.createElement('section'); row.className = 'integration-row'; row.dataset.target = item.target;
      const title = document.createElement('h2'); title.textContent = `${item.label} [${item.state.toUpperCase().replaceAll('_', ' ')}]`;
      const detail = document.createElement('p'); detail.textContent = `${item.command} / ${item.available ? 'AVAILABLE' : 'COMMAND NOT FOUND'}`; row.append(title, detail);
      const install = document.createElement('button'); install.textContent = item.state === 'current' ? 'REINSTALL' : item.state === 'outdated' ? 'UPDATE' : 'INSTALL'; install.disabled = this.busy;
      install.onclick = () => void this.change('integration.install', [item]); row.append(install);
      if (item.state !== 'not_installed') { const remove = document.createElement('button'); remove.textContent = 'UNINSTALL'; remove.disabled = this.busy; remove.onclick = () => { if (confirm(`Remove herdr's ${item.label} integration from ${this.target?.label}?`)) void this.change('integration.uninstall', [item]); }; row.append(remove); }
      parent.append(row);
    }
    if (!this.items.length) parent.textContent = this.busy ? 'Loading native integrations...' : 'No integrations reported.';
  }
  private async change(action: string, items: Integration[]) {
    if (this.busy || !this.target || !items.length) return;
    const target = this.target, epoch = this.epoch; this.busy = true; this.render(); el('integration-error').textContent = ''; el('integration-results').textContent = '';
    const messages: string[] = [];
    try {
      for (const item of items) {
        if (epoch !== this.epoch) break;
        try { const result = await this.api('/api/action', { machine: target.machine, action, target: item.target }); messages.push(`${item.label}:`, ...(result.details?.messages || ['Completed.'])); }
        catch (error) { messages.push(`[ERROR] ${item.label}: ${(error as Error).message}`); }
        if (epoch === this.epoch) el('integration-results').textContent = messages.join('\n');
      }
    } finally { this.busy = false; if (epoch === this.epoch) await this.load(); }
  }
}
