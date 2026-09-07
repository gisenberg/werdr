import type { Api } from './host-manager';
interface Worktree { path: string; branch?: string; is_bare: boolean; is_detached: boolean; is_prunable: boolean; is_linked_worktree: boolean; open_workspace_id?: string; label: string }
interface Target { machine: string; label: string; workspace: string; cwd?: string }
export const worktreesMarkup = `<dialog id="worktrees-dialog"><h1>WORKTREES</h1><p id="worktree-host"></p><form id="worktree-source"><label>REPOSITORY PATH ON THIS HOST<input id="worktree-cwd" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Use selected workspace"></label><label class="check-label"><input id="worktree-trust" type="checkbox">Trust repository ownership for this operation (Git safe.directory)</label><button type="submit">LIST WORKTREES</button></form><p id="worktree-repository"></p><div id="worktree-list"></div><form id="worktree-create"><h2>CREATE WORKTREE</h2><label>BRANCH<input id="worktree-branch" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Native generated name when empty"></label><label>BASE REF<input id="worktree-base" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Native default"></label><label>WORKTREE PATH<input id="worktree-path" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Native configured worktree directory"></label><label>WORKSPACE LABEL<input id="worktree-label" maxlength="256" autocomplete="off"></label><p>Git may run the repository's checkout hooks when creating a worktree.</p><button type="submit">CREATE AND OPEN</button></form><p id="worktree-status" role="status"></p><p id="worktree-error" role="alert"></p><button id="worktree-done">DONE</button></dialog>
<dialog id="worktree-remove-dialog"><h1>REMOVE WORKTREE</h1><p id="worktree-remove-description"></p><p>This closes the worktree's workspace and removes its checkout through herdr.</p><label class="check-label"><input id="worktree-force" type="checkbox">Force removal, including uncommitted changes</label><p id="worktree-remove-error" role="alert"></p><button id="worktree-remove-confirm">REMOVE WORKTREE</button><button id="worktree-remove-cancel">CANCEL</button></dialog>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export class Worktrees {
  private target?: Target;
  private epoch = 0;
  private busy = false;
  private removing?: Worktree;
  private repository = '';
  constructor(private api: Api, private selected: () => Target | undefined, private openPane: (machine: string, pane: any) => void, private changed: () => void) {
    el('worktree-done').onclick = () => el<HTMLDialogElement>('worktrees-dialog').close();
    el('worktrees-dialog').addEventListener('close', () => { ++this.epoch; });
    el('worktree-cwd').oninput = () => { el<HTMLInputElement>('worktree-trust').checked = false; el('worktree-list').replaceChildren(); el('worktree-repository').textContent = ''; };
    el<HTMLFormElement>('worktree-source').onsubmit = event => { event.preventDefault(); void this.list(); };
    el<HTMLFormElement>('worktree-create').onsubmit = event => {
      event.preventDefault(); void this.run(async target => {
        const result = await this.api('/api/action', { ...this.source(target), action: 'worktree.create', branch: this.value('branch'), base: this.value('base'), path: this.value('path'), label: this.value('label') });
        this.changed(); if (el<HTMLDialogElement>('worktrees-dialog').open) { this.openPane(target.machine, result.root_pane); el<HTMLDialogElement>('worktrees-dialog').close(); }
      });
    };
    el('worktree-remove-cancel').onclick = () => el<HTMLDialogElement>('worktree-remove-dialog').close();
    el('worktree-remove-confirm').onclick = () => void this.run(async target => {
      if (!this.removing?.open_workspace_id) return;
      await this.api('/api/action', { machine: target.machine, action: 'worktree.remove', id: this.removing.open_workspace_id, trust: el<HTMLInputElement>('worktree-trust').checked, force: el<HTMLInputElement>('worktree-force').checked });
      this.changed(); el<HTMLDialogElement>('worktree-remove-dialog').close();
      el<HTMLInputElement>('worktree-cwd').value = this.repository;
      try { await this.load(target); } catch (error) { el('worktree-error').textContent = (error as Error).message; }
    }, 'worktree-remove-error');
  }
  private value(name: string) { return el<HTMLInputElement>('worktree-' + name).value.trim(); }
  private source(target: Target) { return { machine: target.machine, id: target.workspace || undefined, cwd: this.value('cwd'), trust: el<HTMLInputElement>('worktree-trust').checked }; }
  open() {
    if (this.busy) return;
    const target = this.selected(); if (!target) return;
    ++this.epoch; this.repository = ''; this.target = { ...target }; el('worktree-host').textContent = `${target.label} / ${target.workspace || 'EXPLICIT REPOSITORY'}`;
    el<HTMLInputElement>('worktree-cwd').value = target.cwd || ''; el<HTMLInputElement>('worktree-trust').checked = false;
    for (const name of ['branch', 'base', 'path', 'label']) el<HTMLInputElement>('worktree-' + name).value = '';
    el('worktree-list').replaceChildren(); el('worktree-repository').textContent = ''; el('worktree-error').textContent = '';
    el<HTMLDialogElement>('worktrees-dialog').showModal(); if (target.workspace || target.cwd) void this.list();
  }
  private async run(task: (target: Target) => Promise<void>, errorId = 'worktree-error') {
    if (this.busy || !this.target) return;
    this.busy = true; const epoch = this.epoch; el(errorId).textContent = ''; el('worktree-status').textContent = 'Waiting for herdr on ' + this.target.label + '...';
    const controls = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#worktrees-dialog button, #worktrees-dialog input, #worktree-remove-dialog button, #worktree-remove-dialog input')];
    const states = controls.map(node => node.disabled); controls.forEach(node => { node.disabled = true; });
    try { await task(this.target); } catch (error) { if (epoch === this.epoch) el(errorId).textContent = (error as Error).message; }
    finally { this.busy = false; el('worktree-status').textContent = ''; controls.forEach((node, index) => { node.disabled = states[index]; }); }
  }
  private list() { return this.run(target => this.load(target)); }
  private async load(target: Target) {
    const epoch = this.epoch;
    const result = await this.api('/api/action', { ...this.source(target), action: 'worktree.list' });
    if (epoch !== this.epoch) return;
    this.repository = result.source.repo_root; el('worktree-host').textContent = `${target.label} / ${result.source.repo_name}`;
    el('worktree-repository').textContent = `${result.source.repo_name} / ${result.source.repo_root}`;
    const parent = el('worktree-list'); parent.replaceChildren();
    for (const item of result.worktrees as Worktree[]) {
      const row = document.createElement('section'); row.className = 'worktree-row';
      const heading = document.createElement('h2'); heading.textContent = `${item.label || item.branch || 'DETACHED'} [${item.open_workspace_id ? 'OPEN' : item.is_prunable ? 'PRUNABLE' : item.is_bare ? 'BARE' : 'CLOSED'}]`;
      const path = document.createElement('p'); path.textContent = item.path; row.append(heading, path);
      const open = document.createElement('button'); open.textContent = 'OPEN WORKTREE'; open.disabled = item.is_bare || item.is_prunable;
      open.onclick = () => void this.run(async target => { const result = await this.api('/api/action', { ...this.source(target), action: 'worktree.open', path: item.path }); this.changed(); if (el<HTMLDialogElement>('worktrees-dialog').open) { this.openPane(target.machine, result.root_pane); el<HTMLDialogElement>('worktrees-dialog').close(); } }); row.append(open);
      if (item.is_linked_worktree && item.open_workspace_id) {
        const remove = document.createElement('button'); remove.textContent = 'REMOVE'; remove.onclick = () => { this.removing = item; el('worktree-remove-description').textContent = `${target.label} / ${item.path}`; el<HTMLInputElement>('worktree-force').checked = false; el('worktree-remove-error').textContent = ''; el<HTMLDialogElement>('worktree-remove-dialog').showModal(); }; row.append(remove);
      }
      if (item.is_linked_worktree && !item.open_workspace_id) { const detail = document.createElement('p'); detail.textContent = 'Open this worktree before removing it through herdr.'; row.append(detail); }
      parent.append(row);
    }
    if (!parent.children.length) parent.textContent = 'No worktrees in this repository.';
  }
}
