import { shortcutActions, type ShortcutAction, type Shortcuts } from '../shared/shortcuts';
import { ShortcutMode } from './shortcut-mode';
export interface ShortcutCommand { id?: ShortcutAction; label: string; disabled?: boolean; palette?: boolean; run(): void }
interface Context { identity: string; attachment: unknown; available: boolean; navigateIdentity: string; ready: boolean }
interface NavigateHandlers { enter(): void; exit(): void; confirm(): void }
export class DesktopShortcuts {
  private mode: ShortcutMode;
  private context?: Context;
  private value: Shortcuts;
  private encoded: string;
  private indicator = document.createElement('div');
  private help = document.createElement('dialog');
  private navigating = false;
  private preservingFocus = false;
  private pendingFocus?: string;
  constructor(value: Shortcuts, private current: () => Context, private commands: () => ShortcutCommand[], private indexed: (action: ShortcutAction, index: number) => void, private focus: () => void, private forward: (event: KeyboardEvent) => void, private navigate: NavigateHandlers) {
    this.value = value; this.encoded = JSON.stringify(value); this.mode = new ShortcutMode(value);
    this.indicator.id = 'shortcut-status'; this.indicator.setAttribute('role', 'status'); this.indicator.hidden = true;
    this.help.id = 'shortcut-help'; this.help.setAttribute('aria-label', 'Keyboard shortcuts');
    document.body.append(this.indicator, this.help);
    this.help.addEventListener('close', () => this.focus());
    document.addEventListener('keydown', this.down, true);
    document.addEventListener('keyup', event => { if (this.mode.up(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    document.addEventListener('pointerdown', event => { if (!(event.target instanceof Element) || !event.target.closest('#navigate-switcher')) this.reset(); }, true);
    document.addEventListener('focusin', event => { if (!(event.target instanceof Element) || !event.target.closest('.pane-content, .copy-layer, #navigate-switcher')) this.reset(); else this.sync(); }, true);
    window.addEventListener('blur', () => { this.mode.blur(); this.paint(); });
    const observer = new MutationObserver(() => { if (this.overlay()) this.reset(); });
    for (const dialog of document.querySelectorAll('dialog')) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    for (const menu of document.querySelectorAll('.context-menu')) observer.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  }
  update(value: Shortcuts) { const encoded = JSON.stringify(value); if (encoded === this.encoded) return; this.value = value; this.encoded = encoded; this.mode.update(value); this.paint(); }
  reset() { this.pendingFocus = undefined; this.mode.reset(); this.paint(); }
  sync() {
    const next = this.current();
    const expectedFocus = this.isNavigating && next.available && this.pendingFocus === next.navigateIdentity;
    if (expectedFocus && next.ready) this.pendingFocus = undefined;
    if (!this.preservingFocus && !expectedFocus && (!this.context || next.identity !== this.context.identity || next.attachment !== this.context.attachment || !next.available)) this.reset();
    this.context = next;
  }
  enterResize() { this.focus(); this.sync(); this.mode.mode = 'resize'; this.paint(); }
  get isNavigating() { return this.mode.mode === 'navigate'; }
  enterNavigate() { this.focus(); this.sync(); this.mode.mode = 'navigate'; this.navigating = true; this.navigate.enter(); this.paint(); }
  preserveNavigateFocus(change: () => void) {
    this.preservingFocus = this.isNavigating;
    try { change(); this.context = this.current(); this.pendingFocus = this.isNavigating && !this.context.ready ? this.context.navigateIdentity : undefined; }
    finally { this.preservingFocus = false; }
  }
  openHelp() {
    this.reset(); this.help.replaceChildren();
    const title = document.createElement('h1'); title.textContent = 'KEYBOARD SHORTCUTS'; title.tabIndex = -1; title.setAttribute('autofocus', '');
    const intro = document.createElement('p'); intro.textContent = `Prefix: ${this.value.prefix}. Press it, release, then press a command. Press the prefix twice to send it to the terminal. Escape cancels. Navigate previews workspaces with its configured Up/Down keys; Enter or 1 through 9 selects, Tab changes panes, and Escape returns. Navigate-only bindings do not apply to terminal typing. Resize mode uses h/j/k/l or arrows; Escape, Enter, or the resize binding exits.`;
    const caveat = document.createElement('p'); caveat.textContent = 'Bindings apply outside editable controls and dialogs. Ctrl/Super+C and Ctrl/Super+V retain clipboard behavior. Browser and OS reserved keys may not reach this page. Configure alternatives in Settings.';
    const list = document.createElement('dl'); const commands = this.commands();
    for (const action of shortcutActions) {
      const command = commands.find(command => command.id === action);
      const term = document.createElement('dt'); term.textContent = this.value.bindings[action].join(' / ') || 'UNBOUND';
      const detail = document.createElement('dd'); detail.textContent = `${command?.label || action.replaceAll('_', ' ')}${command?.disabled || !command ? ' [UNAVAILABLE]' : ''}`; list.append(term, detail);
    }
    const done = document.createElement('button'); done.textContent = 'DONE'; done.onclick = () => this.help.close();
    const header = document.createElement('div'); header.className = 'shortcut-help-header'; header.append(title, done);
    this.help.append(header, intro, caveat, list); this.help.showModal(); title.focus({ preventScroll: true }); this.help.scrollTop = 0;
  }
  private overlay() { return !!document.querySelector('dialog[open], .context-menu:not([hidden])'); }
  private paint() {
    if (this.navigating && !this.isNavigating) { this.navigating = false; this.navigate.exit(); }
    this.indicator.hidden = this.mode.mode === 'terminal';
    this.indicator.textContent = this.isNavigating ? `[NAVIGATE] ${this.value.bindings.navigate_workspace_up.join('/')} / ${this.value.bindings.navigate_workspace_down.join('/')} workspace - Enter select - Tab pane - Escape back` : this.mode.mode === 'resize' ? '[RESIZE] h j k l / ARROWS - Enter or Escape to finish' : `[PREFIX ${this.value.prefix}] ${this.value.bindings.help.join(' / ') || 'Command palette: keyboard help'} - Escape to cancel`;
  }
  private down = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    this.sync();
    const target = event.target instanceof Element ? event.target : undefined;
    const excluded = !this.context?.available || this.overlay() || target?.closest('input, select, [contenteditable]:not([contenteditable=false]), .copy-toolbar') || target?.closest('textarea') && !target.closest('.pane-content');
    if (event.repeat && this.mode.owns(event.code) && (excluded || this.mode.mode !== 'resize' && !this.isNavigating)) { event.preventDefault(); event.stopImmediatePropagation(); if (excluded) this.reset(); return; }
    if (excluded) { this.reset(); return; }
    // Copy and paste are dispatched by selection and image-paste listeners.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) { this.reset(); return; }
    // Workspace commands capture the preview before the mode's exit clears it.
    const result = this.mode.down(event, !!target?.closest('.copy-layer'));
    if (result.consume) { event.preventDefault(); event.stopImmediatePropagation(); }
    const command = result.action ? this.commands().find(command => command.id === result.action) : undefined;
    this.paint();
    if (result.navigate === 'confirm') { this.navigate.confirm(); return; }
    if (result.forward) this.forward(event);
    if (!result.action) return;
    if (result.index !== undefined && this.isNavigating) { this.indexed(result.action, result.index); return; }
    if (!command || command.disabled) { this.reset(); return; }
    if (result.index !== undefined) this.indexed(result.action, result.index); else command.run();
    if (this.overlay()) this.reset();
  };
}
