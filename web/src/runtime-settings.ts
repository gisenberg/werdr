import type { Api } from './host-manager';
interface RuntimeValues {
  default_shell: string; shell_mode: 'auto' | 'login' | 'non_login'; new_cwd: string;
  scrollback_limit_bytes: number; worktree_directory: string; resume_agents_on_restore: boolean;
}
interface Target { machine: string; label: string }
export const runtimeSettingsMarkup = `<dialog id="runtime-settings-dialog"><h1>HOST RUNTIME SETTINGS</h1><p id="runtime-settings-host"></p><p>These settings apply to Herdr sessions on this host. Shell and directory changes affect new terminals. Agent restoration applies when a session is restored.</p><form id="runtime-settings-form"><fieldset id="runtime-settings-fields">
<label>DEFAULT SHELL <input id="runtime-default-shell" maxlength="4096" placeholder="Host default"></label>
<label>SHELL STARTUP <select id="runtime-shell-mode"><option value="auto">AUTO</option><option value="login">LOGIN</option><option value="non_login">NON-LOGIN</option></select></label>
<label>NEW TERMINAL DIRECTORY <input id="runtime-new-cwd" maxlength="4096" list="runtime-cwd-policies" required></label><datalist id="runtime-cwd-policies"><option value="follow"><option value="home"><option value="current"></datalist><p>Use follow, home, current, or a directory on this host.</p>
<label>SCROLLBACK BYTES PER PANE <input id="runtime-scrollback" type="number" min="0" max="9007199254740991" step="1" required></label>
<label>WORKTREE DIRECTORY <input id="runtime-worktrees" maxlength="4096" required></label>
<label><input id="runtime-resume" type="checkbox"> RESUME AGENTS WHEN RESTORING SESSIONS</label>
<button type="submit">SAVE AND RELOAD</button></fieldset></form><p id="runtime-settings-result" role="status"></p><p id="runtime-settings-error" role="alert"></p><div class="inline-actions"><button id="runtime-settings-refresh">RELOAD SETTINGS</button><button id="runtime-settings-done">DONE</button></div></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class RuntimeSettings {
  private target?: Target;
  private revision?: string;
  private busy = false;
  private epoch = 0;
  constructor(private api: Api, private selected: () => Target | undefined) {
    el('runtime-settings-done').onclick = () => el<HTMLDialogElement>('runtime-settings-dialog').close();
    el('runtime-settings-dialog').addEventListener('close', () => { ++this.epoch; });
    el('runtime-settings-refresh').onclick = () => void this.load();
    el<HTMLFormElement>('runtime-settings-form').onsubmit = event => { event.preventDefault(); void this.save(); };
  }
  open() {
    const target = this.selected(); if (!target || this.busy) return;
    this.target = { ...target }; this.revision = undefined; ++this.epoch;
    el('runtime-settings-host').textContent = target.label;
    el('runtime-settings-result').textContent = ''; el('runtime-settings-error').textContent = '';
    el<HTMLFormElement>('runtime-settings-form').reset(); this.render();
    el<HTMLDialogElement>('runtime-settings-dialog').showModal(); void this.load();
  }
  private render() {
    el<HTMLFieldSetElement>('runtime-settings-fields').disabled = this.busy || !this.revision;
    el<HTMLButtonElement>('runtime-settings-refresh').disabled = this.busy;
  }
  private apply(value: { revision: string; settings: RuntimeValues }) {
    this.revision = value.revision;
    const v = value.settings;
    el<HTMLInputElement>('runtime-default-shell').value = v.default_shell;
    el<HTMLSelectElement>('runtime-shell-mode').value = v.shell_mode;
    el<HTMLInputElement>('runtime-new-cwd').value = v.new_cwd;
    el<HTMLInputElement>('runtime-scrollback').value = String(v.scrollback_limit_bytes);
    el<HTMLInputElement>('runtime-worktrees').value = v.worktree_directory;
    el<HTMLInputElement>('runtime-resume').checked = v.resume_agents_on_restore;
  }
  private async load() {
    if (this.busy || !this.target) return;
    const epoch = this.epoch; this.busy = true; this.render(); el('runtime-settings-error').textContent = ''; el('runtime-settings-result').textContent = 'Reading host configuration...';
    try {
      const value = await this.api('/api/runtime-settings?machine=' + encodeURIComponent(this.target.machine));
      if (epoch === this.epoch) { this.apply(value); el('runtime-settings-result').textContent = ''; }
    } catch (error) { if (epoch === this.epoch) { this.revision = undefined; el('runtime-settings-result').textContent = ''; el('runtime-settings-error').textContent = (error as Error).message; } }
    finally { this.busy = false; this.render(); }
  }
  private async save() {
    if (this.busy || !this.target || !this.revision) return;
    const epoch = this.epoch;
    const settings: RuntimeValues = {
      default_shell: el<HTMLInputElement>('runtime-default-shell').value,
      shell_mode: el<HTMLSelectElement>('runtime-shell-mode').value as RuntimeValues['shell_mode'],
      new_cwd: el<HTMLInputElement>('runtime-new-cwd').value,
      scrollback_limit_bytes: el<HTMLInputElement>('runtime-scrollback').valueAsNumber,
      worktree_directory: el<HTMLInputElement>('runtime-worktrees').value,
      resume_agents_on_restore: el<HTMLInputElement>('runtime-resume').checked,
    };
    if (!Number.isSafeInteger(settings.scrollback_limit_bytes)) { el('runtime-settings-error').textContent = 'Enter a whole number of scrollback bytes.'; return; }
    this.busy = true; this.render(); el('runtime-settings-error').textContent = ''; el('runtime-settings-result').textContent = 'Saving and reloading host configuration...';
    try {
      const value = await this.api('/api/runtime-settings', { machine: this.target.machine, revision: this.revision, settings });
      if (epoch !== this.epoch) return;
      this.apply(value);
      const reload = value.reload?.result;
      el('runtime-settings-result').textContent = reload?.status === 'applied' ? '[OK] Configuration saved and reloaded.' : '[WARN] Configuration saved; reload needs attention.';
      el('runtime-settings-error').textContent = value.reload?.error?.message || (reload?.diagnostics || []).join('\n');
    } catch (error) { if (epoch === this.epoch) { el('runtime-settings-result').textContent = ''; el('runtime-settings-error').textContent = (error as Error).message; } }
    finally { this.busy = false; this.render(); }
  }
}
