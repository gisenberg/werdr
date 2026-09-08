import type { Api } from './host-manager';
import type { PluginInstallJob } from '../shared/plugins';
const stateLabel = (job: PluginInstallJob) => job.state === 'complete' ? 'FINISHED' : job.state.toUpperCase();
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const pluginInstallForm = `<details id="plugin-install-details"><summary>INSTALL FROM GITHUB</summary><p>Review the native manifest and commands before confirming installation on this host.</p><form id="plugin-install-form"><label>GITHUB REPOSITORY<input id="plugin-install-source" required maxlength="1024" placeholder="owner/repository[/subdirectory]" autocomplete="off" spellcheck="false"></label><label>BRANCH, TAG OR COMMIT (OPTIONAL)<input id="plugin-install-ref" maxlength="256" autocomplete="off" spellcheck="false"></label><button type="submit">REVIEW INSTALLATION</button></form></details><div id="plugin-install-jobs"></div>`;
export const pluginInstallMarkup = `<dialog id="plugin-install-dialog"><h1>PLUGIN INSTALLER</h1><p id="plugin-install-status" role="status"></p><pre id="plugin-install-output" tabindex="0" aria-label="Native installer console"></pre><form id="plugin-install-input-form"><label>RESPONSE<input id="plugin-install-input" maxlength="4095" autocomplete="off" spellcheck="false" placeholder="Reply to the native installer prompt"></label><button type="submit">SEND RESPONSE</button></form><p id="plugin-install-error" role="alert"></p><button id="plugin-install-cancel">STOP INSTALLER</button><button id="plugin-install-done">CLOSE</button></dialog>`;
export class PluginInstaller {
  private machine = '';
  private epoch = 0;
  private job?: PluginInstallJob;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private api: Api, private changed: () => void) {
    el<HTMLFormElement>('plugin-install-form').onsubmit = event => { event.preventDefault(); void this.begin({ operation: 'install', source: el<HTMLInputElement>('plugin-install-source').value.trim(), ref: el<HTMLInputElement>('plugin-install-ref').value.trim() }); };
    el<HTMLFormElement>('plugin-install-input-form').onsubmit = event => { event.preventDefault(); void this.respond(); };
    el('plugin-install-cancel').onclick = () => void this.cancel();
    el('plugin-install-done').onclick = () => el<HTMLDialogElement>('plugin-install-dialog').close();
    el('plugin-install-dialog').addEventListener('close', () => { ++this.epoch; clearTimeout(this.timer); this.changed(); void this.load(); });
  }
  open(machine: string) { this.machine = machine; ++this.epoch; clearTimeout(this.timer); el('plugin-install-jobs').replaceChildren(); void this.load(); }
  hide() { ++this.epoch; clearTimeout(this.timer); }
  disable(busy: boolean) { for (const control of el('plugin-install-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = busy; }
  uninstall(plugin: string) { void this.begin({ operation: 'uninstall', plugin }); }
  private async begin(params: object) {
    const machine = this.machine, epoch = this.epoch; this.disable(true); el('plugin-error').textContent = '';
    try { const { job } = await this.api('/api/plugins/install', { machine, ...params }); if (epoch === this.epoch) this.show(job); }
    catch (error) { if (epoch === this.epoch) el('plugin-error').textContent = (error as Error).message; }
    finally { if (machine === this.machine) this.disable(false); }
  }
  private async load() {
    const epoch = this.epoch;
    try {
      const { jobs }: { jobs: PluginInstallJob[] } = await this.api('/api/plugins/jobs?machine=' + encodeURIComponent(this.machine));
      if (epoch !== this.epoch) return;
      const parent = el('plugin-install-jobs'); parent.replaceChildren();
      for (const job of jobs.slice().reverse()) {
        const button = document.createElement('button'); button.textContent = `[${stateLabel(job)}] ${job.operation.toUpperCase()} ${job.source}`;
        button.onclick = () => this.show(job); parent.append(button);
      }
    } catch (error) { if (epoch === this.epoch) el('plugin-error').textContent = (error as Error).message; }
  }
  private show(job: PluginInstallJob) {
    ++this.epoch; clearTimeout(this.timer); this.job = job;
    el('plugin-install-error').textContent = ''; el<HTMLInputElement>('plugin-install-input').value = '';
    el<HTMLDialogElement>('plugin-install-dialog').showModal(); this.render(); void this.poll();
  }
  private render() {
    const job = this.job!;
    el('plugin-install-status').textContent = `${job.label} / ${job.operation.toUpperCase()} ${job.source}${job.ref ? ' @ ' + job.ref : ''} [${stateLabel(job)}]${job.exitCode !== undefined && job.exitCode !== null ? ' / EXIT ' + job.exitCode : ''}`;
    const output = el('plugin-install-output'), follow = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    if (output.textContent !== job.output) { output.textContent = job.output; if (follow) output.scrollTop = output.scrollHeight; }
    el('plugin-install-input-form').hidden = job.state !== 'running' || job.operation !== 'install';
    el('plugin-install-cancel').hidden = job.state !== 'running';
  }
  private async respond() {
    const job = this.job, epoch = this.epoch; if (!job) return;
    const input = el<HTMLInputElement>('plugin-install-input'), button = el('plugin-install-input-form').querySelector('button')!; button.disabled = true;
    try { await this.api('/api/plugins/input', { id: job.id, input: input.value }); if (epoch === this.epoch) { input.value = ''; el('plugin-install-error').textContent = ''; } }
    catch (error) { if (epoch === this.epoch) el('plugin-install-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  }
  private async cancel() {
    const job = this.job, epoch = this.epoch; if (!job) return;
    try { await this.api('/api/plugins/cancel', { id: job.id }); }
    catch (error) { if (epoch === this.epoch) el('plugin-install-error').textContent = (error as Error).message; }
  }
  private async poll() {
    const job = this.job, epoch = this.epoch; clearTimeout(this.timer); if (!job || !el<HTMLDialogElement>('plugin-install-dialog').open) return;
    try { const result = await this.api('/api/plugins/job?id=' + encodeURIComponent(job.id)); if (epoch !== this.epoch) return; this.job = result.job; this.render(); }
    catch (error) { if (epoch === this.epoch) el('plugin-install-error').textContent = (error as Error).message; }
    if (epoch === this.epoch && this.job?.state === 'running') this.timer = setTimeout(() => void this.poll(), 500);
  }
}
