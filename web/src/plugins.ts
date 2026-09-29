import { PluginInstaller, pluginInstallForm, pluginInstallMarkup } from './plugin-install';
import type { Api } from './host-manager';
import type { Pane } from '../shared/fleet';
import type { CommandTarget } from '../shared/commands';
import type { Plugin, PluginLog, PluginPane } from '../shared/plugins';

interface Target { machine: string; label: string; workspace?: string; pane?: string; selectedText?: string; commandTarget?: CommandTarget; popups?: boolean }
type PendingTarget = Omit<Target, 'selectedText'> & { selectedText?: Promise<string> };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const pluginsMarkup = `<dialog id="plugins-dialog"><h1>PLUGINS</h1><div class="plugin-body"><p id="plugin-host"></p><p id="plugin-context"></p><div class="inline-actions"><button id="plugin-refresh">REFRESH</button><button id="plugin-focus-pane">FOCUS PLUGIN PANE</button><button id="plugin-close-pane">CLOSE PLUGIN PANE</button></div>${pluginInstallForm}<details id="plugin-link-details"><summary>LINK A PLUGIN DIRECTORY</summary><p>Plugins run their declared commands as your user. Link trusted code already present on this host.</p><form id="plugin-link-form"><label>DIRECTORY ON THIS HOST<input id="plugin-link-path" required maxlength="4096" autocomplete="off" spellcheck="false"></label><label class="plugin-checkbox"><input id="plugin-link-enabled" type="checkbox" checked> ENABLE AFTER LINKING</label><button type="submit">LINK PLUGIN</button></form></details><label>FIND PLUGIN<input id="plugin-search" type="search" autocomplete="off"></label><div id="plugin-list"></div><details id="plugin-log-details"><summary>COMMAND LOGS</summary><label>PLUGIN<select id="plugin-log-filter"><option value="">ALL PLUGINS</option></select></label><label>RECENT COMMANDS<select id="plugin-log-limit"><option>10</option><option selected>50</option><option>100</option><option>200</option></select></label><button id="plugin-log-refresh">REFRESH LOGS</button><div id="plugin-logs"></div></details><pre id="plugin-result" role="status"></pre><p id="plugin-error" role="alert"></p></div><div class="plugin-footer"><button id="plugin-done">DONE</button></div></dialog>${pluginInstallMarkup}`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element;
}

export class Plugins {
  private installer: PluginInstaller;
  private target?: Target;
  private items: Plugin[] = [];
  private logs: PluginLog[] = [];
  private busy = false;
  private epoch = 0;
  private poll?: ReturnType<typeof setTimeout>;
  private readingLogs = false;
  private logsDirty = false;
  constructor(private api: Api, private selected: () => PendingTarget | undefined, private selectPane: (machine: string, pane: Pane) => void, private changed: () => void) {
    this.installer = new PluginInstaller(api, () => { this.changed(); if (el<HTMLDialogElement>('plugins-dialog').open) void this.load(); });
    el('plugin-done').onclick = () => el<HTMLDialogElement>('plugins-dialog').close();
    el('plugins-dialog').addEventListener('close', () => { if (!el<HTMLDialogElement>('plugins-dialog').open) { ++this.epoch; clearTimeout(this.poll); this.installer.hide(); } });
    el('plugin-refresh').onclick = () => void this.load();
    el('plugin-search').oninput = () => this.render();
    el('plugin-log-refresh').onclick = () => void this.loadLogs();
    el('plugin-log-filter').onchange = () => void this.loadLogs();
    el('plugin-log-limit').onchange = () => void this.loadLogs();
    el('plugin-log-details').addEventListener('toggle', () => { if (el<HTMLDetailsElement>('plugin-log-details').open) void this.loadLogs(); else clearTimeout(this.poll); });
    el('plugin-focus-pane').onclick = () => void this.change('plugin.pane.focus', { pane_id: this.target?.pane });
    el('plugin-close-pane').onclick = () => { if (confirm(`Close plugin pane ${this.target?.pane} on ${this.target?.label} and end its process?`)) void this.change('plugin.pane.close', { pane_id: this.target?.pane }); };
    el<HTMLFormElement>('plugin-link-form').onsubmit = event => { event.preventDefault(); void this.change('plugin.link', { path: el<HTMLInputElement>('plugin-link-path').value, enabled: el<HTMLInputElement>('plugin-link-enabled').checked }); };
  }
  open() {
    const target = this.selected(); if (!target) return;
    const epoch = ++this.epoch; this.busy = true; this.readingLogs = false; this.logsDirty = false; this.target = { ...target, selectedText: undefined }; this.items = []; this.logs = []; clearTimeout(this.poll);
    el('plugin-host').textContent = target.label;
    el('plugin-context').textContent = target.pane ? `CONTEXT ${target.workspace} / ${target.pane}` : 'GLOBAL CONTEXT';
    el('plugin-error').textContent = ''; el('plugin-result').textContent = '';
    el<HTMLInputElement>('plugin-search').value = ''; el<HTMLInputElement>('plugin-link-path').value = '';
    this.render(); this.renderLogs(); this.installer.open(target.machine); el<HTMLDialogElement>('plugins-dialog').showModal();
    void Promise.resolve(target.selectedText).then(text => {
      if (epoch !== this.epoch || !this.target) return;
      this.target.selectedText = text;
      if (text) el('plugin-context').textContent += ' / TEXT SELECTED';
    }).catch(error => {
      if (epoch === this.epoch) el('plugin-error').textContent = `Selection unavailable: ${(error as Error).message}`;
    }).finally(() => { if (epoch === this.epoch) { this.busy = false; void this.load(false); } });
  }
  private request(action: string, params: object = {}) { return this.api('/api/action', { machine: this.target!.machine, action, ...params }); }
  private async load(clearError = true) {
    if (this.busy || !this.target) return;
    this.busy = true; const epoch = this.epoch; this.render(); if (clearError) el('plugin-error').textContent = '';
    try {
      const { plugins } = await this.request('plugin.list');
      if (epoch !== this.epoch) return;
      this.items = plugins;
      const filter = el<HTMLSelectElement>('plugin-log-filter'), selected = filter.value;
      filter.replaceChildren(new Option('ALL PLUGINS', ''), ...this.items.map(plugin => new Option(plugin.name, plugin.plugin_id)));
      if (this.items.some(plugin => plugin.plugin_id === selected)) filter.value = selected;
      if (el<HTMLDetailsElement>('plugin-log-details').open) void this.loadLogs();
    } catch (error) { if (epoch === this.epoch) el('plugin-error').textContent = (error as Error).message; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }
  private render() {
    this.installer.disable(this.busy);
    for (const id of ['plugin-refresh', 'plugin-focus-pane', 'plugin-close-pane']) el<HTMLButtonElement>(id).disabled = this.busy || id !== 'plugin-refresh' && !this.target?.pane;
    for (const field of el('plugin-link-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) field.disabled = this.busy;
    const parent = el('plugin-list'); parent.replaceChildren();
    const query = el<HTMLInputElement>('plugin-search').value.toLowerCase();
    for (const plugin of this.items.filter(plugin => `${plugin.name} ${plugin.plugin_id} ${plugin.description || ''}`.toLowerCase().includes(query))) {
      const row = node('section', '', 'plugin-row'); row.dataset.plugin = plugin.plugin_id;
      row.append(node('h2', `${plugin.name} [${plugin.enabled ? 'ENABLED' : 'DISABLED'}]`), node('p', `${plugin.plugin_id} / v${plugin.version}`));
      if (plugin.description) row.append(node('p', plugin.description));
      const toggle = this.button(plugin.enabled ? 'DISABLE' : 'ENABLE', () => void this.change(plugin.enabled ? 'plugin.disable' : 'plugin.enable', { plugin_id: plugin.plugin_id }));
      const remove = this.button('UNLINK', () => { if (confirm(`Unlink ${plugin.name} from ${this.target?.label}? Its files and running panes will remain.`)) void this.change('plugin.unlink', { plugin_id: plugin.plugin_id }); });
      row.append(toggle, remove);
      if (plugin.source.kind === 'github') row.append(this.button('UNINSTALL', () => { if (confirm(`Uninstall ${plugin.name} on ${this.target?.label} and remove its managed checkout? Native plugin config and state will be preserved.`)) this.installer.uninstall(plugin.plugin_id); }));
      const details = node('details', ''); details.append(node('summary', 'MANIFEST AND SOURCE'));
      details.append(node('p', `${plugin.manifest_path}\n${plugin.source.kind === 'github' ? `${plugin.source.owner}/${plugin.source.repo} @ ${plugin.source.resolved_commit || plugin.source.requested_ref || 'default'}` : 'LOCAL DIRECTORY'}`));
      details.append(node('p', `HERDR >= ${plugin.min_herdr_version} / ${(plugin.platforms || ['host platform']).join(', ')}`));
      for (const warning of plugin.warnings || []) details.append(node('p', `[WARN] ${warning}`));
      for (const entry of plugin.build || []) details.append(node('pre', `BUILD ${JSON.stringify(entry.command)}`));
      for (const entry of plugin.startup || []) details.append(node('pre', `STARTUP ${JSON.stringify(entry.command)}`));
      for (const entry of plugin.events || []) details.append(node('pre', `${entry.on} ${JSON.stringify(entry.command)}`));
      row.append(details);
      for (const action of plugin.actions || []) {
        const actionRow = node('div', '', 'plugin-entry'); actionRow.dataset.action = action.id;
        const contexts = action.contexts || [];
        const eligible = !contexts.length || contexts.some(context => context === 'global' || context === 'workspace' && this.target?.workspace || (context === 'tab' || context === 'pane') && this.target?.pane || context === 'selection' && this.target?.selectedText);
        const run = this.button(`RUN ${action.title}`, () => void this.change('plugin.action.invoke', { plugin_id: plugin.plugin_id, action_id: action.id, pane_id: this.target?.pane, selected_text: this.target?.selectedText }));
        run.disabled ||= !plugin.enabled || !eligible; actionRow.append(run);
        if (action.description) actionRow.append(node('p', action.description));
        actionRow.append(node('small', `CONTEXT ${(contexts.length ? contexts : ['global']).join(', ')}`), this.command(action.command)); row.append(actionRow);
      }
      for (const pane of plugin.panes || []) row.append(this.paneEntry(plugin, pane));
      parent.append(row);
    }
    if (!parent.childElementCount) parent.textContent = this.busy ? 'Loading native plugins...' : this.items.length ? 'No matching plugins.' : 'No plugins linked on this host.';
  }
  private command(argv: string[]) { const detail = node('details', ''); detail.append(node('summary', 'COMMAND'), node('pre', JSON.stringify(argv))); return detail; }
  private button(label: string, run: () => void) { const button = node('button', label); button.type = 'button'; button.disabled = this.busy; button.onclick = run; return button; }
  private paneEntry(plugin: Plugin, pane: PluginPane) {
    const row = node('div', '', 'plugin-entry'); row.dataset.entrypoint = pane.id;
    row.append(node('h3', pane.title)); if (pane.description) row.append(node('p', pane.description));
    const controls = node('div', '', 'plugin-pane-controls');
    const label = node('label', 'PLACEMENT'), placement = document.createElement('select'); placement.setAttribute('aria-label', `${pane.title} placement`);
    for (const value of ['overlay', 'popup', 'split', 'tab', 'zoomed']) { const option = new Option(value.toUpperCase() + (value === pane.placement ? ' (DEFAULT)' : ''), value); option.disabled = value === 'popup' && !this.target?.popups; placement.add(option); }
    placement.value = pane.placement; placement.disabled = this.busy; label.append(placement); controls.append(label);
    const directionLabel = node('label', 'SPLIT DIRECTION'), direction = document.createElement('select'); direction.setAttribute('aria-label', `${pane.title} split direction`); direction.append(new Option('RIGHT', 'right'), new Option('DOWN', 'down')); direction.disabled = this.busy; directionLabel.append(direction); controls.append(directionLabel);
    const open = this.button(`OPEN ${pane.title}`, () => void this.change('plugin.pane.open', { plugin_id: plugin.plugin_id, entrypoint: pane.id, placement: placement.value, direction: direction.value, pane_id: this.target?.pane, workspace_id: this.target?.workspace, target: this.target?.commandTarget }));
    const update = () => { open.disabled = this.busy || !plugin.enabled || placement.value === 'popup' && (!this.target?.popups || !this.target.commandTarget) || (placement.value === 'tab' ? !this.target?.workspace : !this.target?.pane); directionLabel.hidden = !['split', 'zoomed'].includes(placement.value); };
    placement.onchange = update; update(); controls.append(open); row.append(controls, this.command(pane.command));
    if (pane.placement === 'popup' && !this.target?.popups) row.append(node('p', 'This host needs native popup-session support. Choose another placement or update the host.'));
    return row;
  }
  private async change(action: string, params: object) {
    if (this.busy || !this.target) return;
    this.busy = true; const epoch = this.epoch, target = this.target; this.render(); el('plugin-error').textContent = ''; el('plugin-result').textContent = '';
    try {
      const result = await this.request(action, params); this.changed();
      if (epoch !== this.epoch) return;
      if (result.type === 'popup_opened' && result.popup) { el<HTMLDialogElement>('plugins-dialog').close(); el<HTMLDialogElement>('settings-dialog').close(); return; }
      if (result.plugin_pane?.pane) {
        el<HTMLDialogElement>('plugins-dialog').close(); el<HTMLDialogElement>('settings-dialog').close();
        this.selectPane(target.machine, result.plugin_pane.pane); return;
      }
      if (action === 'plugin.pane.close') { el<HTMLDialogElement>('plugins-dialog').close(); el<HTMLDialogElement>('settings-dialog').close(); return; }
      if (result.log) {
        el('plugin-result').textContent = `STARTED ${result.action.title} / ${result.log.log_id}`;
        el<HTMLDetailsElement>('plugin-log-details').open = true; await this.loadLogs();
      } else el('plugin-result').textContent = `${action}: completed`;
      if (action === 'plugin.link') { el<HTMLInputElement>('plugin-link-path').value = ''; el<HTMLDetailsElement>('plugin-link-details').open = false; }
    } catch (error) { if (epoch === this.epoch) el('plugin-error').textContent = (error as Error).message; }
    finally { if (epoch === this.epoch) { this.busy = false; if (el<HTMLDialogElement>('plugins-dialog').open) await this.load(false); } }
  }
  private async loadLogs() {
    if (!this.target || !el<HTMLDialogElement>('plugins-dialog').open) return;
    if (this.readingLogs) { this.logsDirty = true; return; }
    const epoch = this.epoch; clearTimeout(this.poll); this.readingLogs = true; el<HTMLButtonElement>('plugin-log-refresh').disabled = true;
    try { const filter = el<HTMLSelectElement>('plugin-log-filter').value; const { logs } = await this.request('plugin.log.list', { ...(filter ? { plugin_id: filter } : {}), limit: Number(el<HTMLSelectElement>('plugin-log-limit').value) }); if (epoch === this.epoch) { this.logs = logs; this.renderLogs(); } }
    catch (error) { if (epoch === this.epoch) el('plugin-error').textContent = (error as Error).message; }
    finally {
      if (epoch !== this.epoch) return;
      this.readingLogs = false; el<HTMLButtonElement>('plugin-log-refresh').disabled = false;
      if (this.logsDirty) { this.logsDirty = false; void this.loadLogs(); return; }
      if (this.logs.some(log => log.status === 'running') && el<HTMLDetailsElement>('plugin-log-details').open) this.poll = setTimeout(() => void this.loadLogs(), 1000);
    }
  }
  private renderLogs() {
    const parent = el('plugin-logs'), filter = el<HTMLSelectElement>('plugin-log-filter').value;
    const opened = new Set([...parent.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node => node.dataset.log)); parent.replaceChildren();
    for (const log of this.logs.filter(log => !filter || log.plugin_id === filter)) {
      const row = node('details', ''); row.dataset.log = log.log_id; row.open = opened.has(log.log_id) || log.status === 'failed';
      row.append(node('summary', `[${log.status.toUpperCase()}] ${log.plugin_id} / ${log.action_id || log.event || log.log_id}`));
      row.append(node('p', `${new Date(log.started_unix_ms).toLocaleString()}${log.exit_code !== undefined ? ` / EXIT ${log.exit_code}` : ''}`), node('pre', JSON.stringify(log.command)));
      for (const [label, value] of [['STDOUT', log.stdout], ['STDERR', log.stderr], ['ERROR', log.error]]) if (value) row.append(node('h3', label!), node('pre', value));
      parent.append(row);
    }
    if (!parent.childElementCount) parent.textContent = 'No command logs.';
  }
}
