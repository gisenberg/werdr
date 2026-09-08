import { defaults, fontFamilies, fonts, palette, themeNames, validatePreferences, type Preferences, type SettingsState } from '../shared/settings';
import type { Api } from './host-manager';
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const settingsMarkup = `<dialog id="settings-dialog"><form id="settings-form"><h1>SETTINGS</h1><p>Appearance and behavior shared by your browsers. Changes preview until you save.</p><div id="settings-fields"></div><details><summary>CUSTOM THEME COLORS</summary><div id="settings-colors"></div></details><fieldset><legend>THIS DEVICE</legend><label><input id="settings-device-font" type="checkbox"> Override terminal font size on this device</label><label>DEVICE FONT SIZE<input id="settings-device-size" type="number" min="10" max="32" value="14"></label></fieldset><fieldset><legend>NATIVE HOST</legend><button id="settings-integrations" type="button">MANAGE HOST INTEGRATIONS</button><button id="settings-plugins" type="button">MANAGE HOST PLUGINS</button></fieldset><p id="settings-error" role="alert"></p><div class="settings-actions"><button type="submit">SAVE SETTINGS</button><button id="settings-cancel" type="button">CANCEL</button><button id="settings-reset" type="button">PREVIEW DEFAULTS</button></div></form></dialog>`;
type Control = { key: keyof Preferences; label: string; choices?: readonly string[]; min?: number; max?: number };
const groups: [string, Control[]][] = [
  ['APPEARANCE', [
    { key: 'appearance', label: 'COLOR MODE', choices: ['theme', 'system', 'dark', 'light'] },
    { key: 'theme', label: 'SELECTED THEME', choices: themeNames },
    { key: 'darkTheme', label: 'DARK THEME', choices: themeNames }, { key: 'lightTheme', label: 'LIGHT THEME', choices: themeNames },
    { key: 'font', label: 'TERMINAL FONT', choices: fonts }, { key: 'fontSize', label: 'FONT SIZE', min: 10, max: 32 },
    { key: 'cursorBlink', label: 'BLINKING CURSOR' }, { key: 'sidebarWidth', label: 'SIDEBAR WIDTH', min: 160, max: 640 },
    { key: 'sidebarSectionPercent', label: 'WORKSPACE SECTION (%)', min: 10, max: 90 },
    { key: 'compact', label: 'COMPACT CHROME' }, { key: 'indicators', label: 'STATUS INDICATORS', choices: ['text', 'dots', 'symbols'] },
    { key: 'hideSingleTab', label: 'HIDE TAB BAR FOR ONE TAB' },
    { key: 'tabBarPosition', label: 'DESKTOP TAB BAR POSITION', choices: ['top', 'bottom'] },
    { key: 'paneScrollbars', label: 'TERMINAL SCROLLBARS' },
    { key: 'paneBorders', label: 'SPLIT PANE BORDERS' }, { key: 'paneOuterBorders', label: 'OUTER PANE BORDERS' },
    { key: 'paneGaps', label: 'GAPS BETWEEN PANES' }, { key: 'showAgentLabelsOnPaneBorders', label: 'AGENT LABELS ON PANE BORDERS' },
  ]],
  ['NAVIGATION', [{ key: 'agentSort', label: 'AGENT ORDER', choices: ['priority', 'native'] }, { key: 'confirmClose', label: 'CONFIRM PROCESS CLOSURE' }, { key: 'scrollLines', label: 'SCROLL LINES', min: 1, max: 20 }]],
  ['TERMINAL SELECTION', [{ key: 'copyOnSelect', label: 'COPY ON MOUSE SELECTION' }]],
  ['NOTIFICATIONS', [{ key: 'notificationAttention', label: 'ATTENTION ALERTS' }, { key: 'notificationFinished', label: 'COMPLETION ALERTS' }, { key: 'notificationSound', label: 'ALERT SOUND' }, { key: 'toastSeconds', label: 'TOAST SECONDS (0 DISABLES TOASTS)', min: 0, max: 60 }, { key: 'toastPosition', label: 'TOAST POSITION', choices: ['top-right', 'bottom-right'] }]],
];
export class Settings {
  private state: SettingsState = { revision: 0, preferences: structuredClone(defaults) };
  preferences: Preferences = structuredClone(defaults);
  private readonly media = matchMedia('(prefers-color-scheme: light)');
  private deviceSize?: number;
  private navigationSave?: Promise<void>;
  constructor(private readonly api: Api, private readonly changed: (preferences: Preferences, colors: Record<string, string>) => void) {
    try { const size = Number(localStorage.getItem('werdr-device-font-size')); if (Number.isInteger(size) && size >= 10 && size <= 32) this.deviceSize = size; } catch {}
    this.media.addEventListener('change', () => this.apply(this.preferences));
    window.addEventListener('storage', event => { if (event.key === 'werdr-device-font-size') { const size = Number(event.newValue); this.deviceSize = size >= 10 && size <= 32 ? size : undefined; this.apply(this.state.preferences); } });
    element('settings-cancel').onclick = () => element<HTMLDialogElement>('settings-dialog').close();
    element('settings-dialog').addEventListener('close', () => this.apply(this.state.preferences));
    element('settings-reset').onclick = () => { this.fill(structuredClone(defaults)); this.preview(); };
    element('settings-form').addEventListener('input', () => this.preview());
    element<HTMLFormElement>('settings-form').onsubmit = async event => {
      event.preventDefault(); const button = element('settings-form').querySelector<HTMLButtonElement>('button[type=submit]')!; button.disabled = true;
      try {
        const preferences = this.read();
        const size = element<HTMLInputElement>('settings-device-size').valueAsNumber;
        if (element<HTMLInputElement>('settings-device-font').checked && (!Number.isInteger(size) || size < 10 || size > 32)) throw new Error('Device font size must be between 10 and 32.');
        this.state = await api('/api/settings', { revision: this.state.revision, preferences });
        this.deviceSize = element<HTMLInputElement>('settings-device-font').checked ? size : undefined;
        try { if (this.deviceSize) localStorage.setItem('werdr-device-font-size', String(this.deviceSize)); else localStorage.removeItem('werdr-device-font-size'); } catch {}
        element<HTMLDialogElement>('settings-dialog').close(); this.apply(this.state.preferences);
      } catch (error) { element('settings-error').textContent = (error as Error).message; }
      finally { button.disabled = false; }
    };
    this.apply(this.preferences);
  }
  saveSidebarSplit(sidebarSectionPercent: number) {
    return this.saveNavigation(preferences => ({ ...preferences, sidebarSectionPercent }));
  }
  saveWorkspaceGroup(key: string, collapsed: boolean) {
    return this.saveNavigation(preferences => {
      const groups = new Set(preferences.collapsedWorkspaceGroups);
      if (collapsed) groups.add(key); else groups.delete(key);
      return { ...preferences, collapsedWorkspaceGroups: [...groups] };
    });
  }
  private saveNavigation(update: (preferences: Preferences) => Preferences) {
    const task = (this.navigationSave || Promise.resolve()).catch(() => {}).then(() => this.persistNavigation(update));
    this.navigationSave = task;
    return task.finally(() => { if (this.navigationSave === task) this.navigationSave = undefined; });
  }
  private async persistNavigation(update: (preferences: Preferences) => Preferences) {
    // Read the latest revision so a navigation change preserves other preferences.
    // A racing save still conflicts at the server instead of overwriting it.
    try {
      const latest: SettingsState = await this.api('/api/settings');
      this.state = await this.api('/api/settings', { revision: latest.revision, preferences: validatePreferences(update(latest.preferences)) });
      this.apply(this.state.preferences);
    } catch (error) {
      try { this.state = await this.api('/api/settings'); } catch {}
      this.apply(this.state.preferences);
      throw error;
    }
  }
  async refresh() {
    try { await this.navigationSave; } catch {}
    if (element<HTMLDialogElement>('settings-dialog').open) return;
    const latest: SettingsState = await this.api('/api/settings');
    if (latest.revision >= this.state.revision) { this.state = latest; this.apply(this.state.preferences); }
  }
  async open() {
    try { await this.refresh(); this.fill(this.state.preferences); element('settings-error').textContent = ''; element<HTMLDialogElement>('settings-dialog').showModal(); }
    catch (error) { element('status').textContent = (error as Error).message; }
  }
  private fill(preferences: Preferences) {
    const parent = element('settings-fields'); parent.replaceChildren();
    for (const [title, controls] of groups) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = title; group.append(legend);
      for (const control of controls) {
        const label = document.createElement('label'); label.textContent = control.label;
        const input = document.createElement(control.choices ? 'select' : 'input'); input.dataset.setting = control.key;
        if (input instanceof HTMLSelectElement) for (const choice of control.choices!) { const option = document.createElement('option'); option.value = choice; option.textContent = choice.replaceAll('-', ' ').toUpperCase(); input.append(option); }
        if (input instanceof HTMLInputElement) {
          input.type = control.min === undefined ? 'checkbox' : 'number';
          if (input.type === 'checkbox') input.checked = preferences[control.key] as boolean;
          else { input.min = String(control.min); input.max = String(control.max); }
        }
        input.value = String(preferences[control.key]); label.append(input); group.append(label);
      }
      parent.append(group);
    }
    const colors = element('settings-colors'); colors.replaceChildren();
    for (const key of Object.keys(palette(defaults, false))) {
      const label = document.createElement('label'); label.textContent = key.replaceAll('_', ' ').toUpperCase();
      const input = document.createElement('input'); input.dataset.color = key; input.value = preferences.customColors[key] || ''; input.placeholder = 'Theme default'; input.maxLength = 7; label.append(input); colors.append(label);
    }
    element<HTMLInputElement>('settings-device-font').checked = !!this.deviceSize;
    element<HTMLInputElement>('settings-device-size').value = String(this.deviceSize || preferences.fontSize);
  }
  private read() {
    const value: Record<string, unknown> = { ...this.state.preferences, customColors: {} };
    for (const input of element('settings-fields').querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')) value[input.dataset.setting!] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input instanceof HTMLInputElement && input.type === 'number' ? input.valueAsNumber : input.value;
    for (const input of element('settings-colors').querySelectorAll<HTMLInputElement>('[data-color]')) if (input.value.trim()) (value.customColors as Record<string, string>)[input.dataset.color!] = input.value.trim();
    return validatePreferences(value);
  }
  private preview() {
    try {
      const preferences = this.read();
      if (element<HTMLInputElement>('settings-device-font').checked) preferences.fontSize = element<HTMLInputElement>('settings-device-size').valueAsNumber;
      element('settings-error').textContent = ''; this.apply(validatePreferences(preferences), true);
    } catch (error) { element('settings-error').textContent = (error as Error).message; }
  }
  private apply(preferences: Preferences, preview = false) {
    this.preferences = { ...preferences, ...(!preview && this.deviceSize ? { fontSize: this.deviceSize } : {}) };
    const colors = palette(this.preferences, this.media.matches), root = document.documentElement;
    for (const [key, color] of Object.entries(colors)) root.style.setProperty(`--herdr-${key.replaceAll('_', '-')}`, color);
    const rgb = colors.panel_bg.slice(1).match(/../g)!.map(value => parseInt(value, 16));
    root.style.colorScheme = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 128 ? 'light' : 'dark';
    root.style.setProperty('--sidebar-width', `${preferences.sidebarWidth}px`); root.style.setProperty('--wmux-mono-font', fontFamilies[preferences.font]);
    root.dataset.tabBarPosition = preferences.tabBarPosition;
    root.dataset.density = preferences.compact ? 'compact' : 'comfortable'; root.dataset.indicators = preferences.indicators; root.dataset.toastPosition = preferences.toastPosition;
    this.changed(this.preferences, colors);
  }
}
