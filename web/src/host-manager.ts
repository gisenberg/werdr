import type { HostView, SetupJob } from '../shared/fleet';
export type Api = (path: string, data?: object) => Promise<any>;
export const hostManagerMarkup = `<dialog id="host-manager"><h1>HOSTS</h1><p>Saved SSH hosts share herdr's native catalog. Use a stable LAN hostname or a Tailscale hostname. SSH keys and host trust belong to the gateway's OpenSSH configuration.</p><div id="managed-hosts"></div><div id="setup-jobs"></div><form id="add-host-form"><h2>ADD HOST</h2><label>SSH TARGET<input id="host-target" placeholder="user@hostname" required maxlength="1024" autocomplete="off" spellcheck="false"></label><label>DISPLAY LABEL<input id="host-label" required maxlength="128" autocomplete="off"></label><label>HERDR SESSION<input id="host-session" value="werdr" required maxlength="64" autocomplete="off" spellcheck="false"></label><label>PLATFORM<select id="host-platform"><option value="posix">LINUX / MACOS</option><option value="windows">WINDOWS</option></select></label><button type="submit">CHECK AND SET UP</button></form><p id="host-error" role="alert"></p><button id="host-manager-done">DONE</button></dialog>
<dialog id="host-rename-dialog"><form id="host-rename-form"><h1>RENAME HOST</h1><label>DISPLAY LABEL<input id="host-rename" required maxlength="128"></label><button type="submit">SAVE LABEL</button><button id="host-rename-cancel" type="button">CANCEL</button><p id="host-rename-error" role="alert"></p></form></dialog>
<dialog id="setup-dialog"><h1>HOST SETUP</h1><p id="setup-status" role="status"></p><pre id="setup-output" tabindex="0" aria-label="Setup console"></pre><form id="setup-input-form"><label>RESPONSE<input id="setup-input" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Reply to the setup prompt"></label><button type="submit">SEND RESPONSE</button></form><p id="setup-error" role="alert"></p><button id="setup-cancel">CANCEL SETUP</button><button id="setup-open-host" hidden>OPEN HOST</button><button id="setup-done">CLOSE</button></dialog>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class HostManager {
  private hosts: HostView[] = [];
  private job?: SetupJob;
  private timer?: ReturnType<typeof setTimeout>;
  private renameId = '';
  constructor(private readonly api: Api, private readonly select: (id: string) => void) {
    element('host-manager-done').onclick = () => element<HTMLDialogElement>('host-manager').close();
    element('host-rename-cancel').onclick = () => element<HTMLDialogElement>('host-rename-dialog').close();
    element<HTMLFormElement>('add-host-form').onsubmit = event => { event.preventDefault(); void this.setup({ target: element<HTMLInputElement>('host-target').value, label: element<HTMLInputElement>('host-label').value, session: element<HTMLInputElement>('host-session').value, platform: element<HTMLSelectElement>('host-platform').value }); };
    let automaticLabel = '';
    element('host-target').oninput = () => {
      const label = element<HTMLInputElement>('host-label');
      if (!label.value || label.value === automaticLabel) { automaticLabel = element<HTMLInputElement>('host-target').value.replace(/^ssh:\/\//, '').split('@').at(-1)!.replace(/:\d+$/, ''); label.value = automaticLabel; }
    };
    element<HTMLFormElement>('host-rename-form').onsubmit = async event => {
      event.preventDefault(); const button = element('host-rename-form').querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
      try { await api('/api/hosts/edit', { id: this.renameId, action: 'rename', label: element<HTMLInputElement>('host-rename').value }); element<HTMLDialogElement>('host-rename-dialog').close(); }
      catch (error) { element('host-rename-error').textContent = (error as Error).message; }
      finally { button.disabled = false; }
    };
    element<HTMLFormElement>('setup-input-form').onsubmit = async event => {
      event.preventDefault(); if (!this.job) return;
      const input = element<HTMLInputElement>('setup-input');
      try { await api('/api/setup/input', { id: this.job.id, input: input.value }); input.value = ''; await this.poll(); }
      catch (error) { element('setup-error').textContent = (error as Error).message; }
    };
    element('setup-cancel').onclick = async () => {
      if (!this.job) return;
      try { await api('/api/setup/cancel', { id: this.job.id }); await this.poll(); }
      catch (error) { element('setup-error').textContent = (error as Error).message; }
    };
    element('setup-open-host').onclick = () => { if (this.job?.machineId) select(this.job.machineId); element<HTMLDialogElement>('setup-dialog').close(); };
    element('setup-done').onclick = () => element<HTMLDialogElement>('setup-dialog').close();
    element('setup-dialog').addEventListener('close', () => clearTimeout(this.timer));
  }
  update(hosts: HostView[]) { this.hosts = hosts; if (element<HTMLDialogElement>('host-manager').open) this.render(); }
  open() {
    element('host-error').textContent = ''; this.render(); element<HTMLDialogElement>('host-manager').showModal();
    void this.api('/api/setup/jobs').then(({ jobs }: { jobs: SetupJob[] }) => {
      const parent = element('setup-jobs'); parent.replaceChildren();
      for (const job of jobs.slice().reverse()) {
        const button = document.createElement('button'); button.textContent = `[${job.state.toUpperCase()}] ${job.label} SETUP`;
        button.onclick = () => this.showJob(job); parent.append(button);
      }
    }).catch(error => { element('host-error').textContent = error.message; });
  }
  private render() {
    const parent = element('managed-hosts'); parent.replaceChildren();
    for (const host of this.hosts) {
      const row = document.createElement('section'); row.className = 'managed-host';
      const name = document.createElement('h2'); name.textContent = `${host.machine.label} [${host.connection.toUpperCase()}]`;
      const detail = document.createElement('p'); detail.textContent = `${host.machine.target || host.machine.label} / ${host.machine.session || 'default'}${host.version ? ' / ' + host.version : ''}`;
      row.append(name, detail);
      if (host.detail) { const message = document.createElement('p'); message.textContent = host.detail; row.append(message); }
      const controls = document.createElement('div'); controls.className = 'inline-actions';
      const button = (label: string, click: () => void) => { const node = document.createElement('button'); node.textContent = label; node.onclick = click; controls.append(node); };
      button('RECONNECT', () => { void this.api('/api/hosts/retry', { id: host.machine.id }).catch(error => { element('host-error').textContent = error.message; }); });
      if (host.machine.target) {
        button('RENAME', () => { this.renameId = host.machine.id; element<HTMLInputElement>('host-rename').value = host.machine.label; element('host-rename-error').textContent = ''; element<HTMLDialogElement>('host-rename-dialog').showModal(); });
        button(host.machine.enabled ? 'DISABLE' : 'ENABLE', () => { void this.edit(host.machine.id, host.machine.enabled ? 'disable' : 'enable'); });
        button('SET UP', () => { void this.setup({ id: host.machine.id }); });
        button('REMOVE', () => { if (confirm(`Remove ${host.machine.label} from the saved catalog? Its remote sessions will keep running.`)) void this.edit(host.machine.id, 'remove'); });
      }
      row.append(controls); parent.append(row);
    }
  }
  private async edit(id: string, action: string) {
    try { await this.api('/api/hosts/edit', { id, action }); }
    catch (error) { element('host-error').textContent = (error as Error).message; }
  }
  private async setup(data: object) {
    const button = element('add-host-form').querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
    try { const { job } = await this.api('/api/hosts/setup', data); this.showJob(job); }
    catch (error) { element('host-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  }
  private showJob(job: SetupJob) {
    this.job = job; element<HTMLDialogElement>('host-manager').close(); element('setup-error').textContent = '';
    element<HTMLDialogElement>('setup-dialog').showModal(); this.renderJob(); void this.poll();
  }
  private renderJob() {
    if (!this.job) return;
    const job = this.job, output = element('setup-output');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    if (output.textContent !== job.output) { output.textContent = job.output; if (follow) output.scrollTop = output.scrollHeight; }
    element('setup-status').textContent = `${job.label} / ${job.target} [${job.state.toUpperCase()}]`;
    element('setup-input-form').hidden = job.state !== 'running'; element('setup-cancel').hidden = job.state !== 'running';
    element('setup-open-host').hidden = job.state !== 'complete' || !job.machineId;
  }
  private async poll() {
    clearTimeout(this.timer); if (!this.job || !element<HTMLDialogElement>('setup-dialog').open) return;
    try { const { job } = await this.api('/api/setup/job?id=' + encodeURIComponent(this.job.id)); this.job = job; this.renderJob(); }
    catch (error) { element('setup-error').textContent = (error as Error).message; }
    if (this.job?.state === 'running' && element<HTMLDialogElement>('setup-dialog').open) this.timer = setTimeout(() => { void this.poll(); }, 750);
  }
}
