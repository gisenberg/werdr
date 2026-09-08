import { noticeEndpointKey, type HostView } from '../shared/fleet';
import type { PopupSession, PopupSize } from '../shared/popups';
import { fontFamilies, type Preferences, palette } from '../shared/settings';
import { TerminalController } from './terminal-controller';

/** A native singleton popup is a terminal session, never a pane in the layout. */
export class PopupSurface {
  private readonly dialog = document.createElement('dialog');
  private readonly pendingDialog = document.createElement('dialog');
  private pending?: { timer?: ReturnType<typeof setTimeout> };
  private readonly content = document.createElement('div');
  private readonly toolbar = document.createElement('div');
  private readonly message = document.createElement('span');
  private readonly closeButton = document.createElement('button');
  private controller?: TerminalController;
  private popup?: PopupSession;
  private endpoint = '';
  private selectedTab = '';
  private online = false;
  private closing = false;
  private measuredFont = '';
  private measuredWidth = 0;
  private terminalMetrics = '';
  private wasReady = false;
  constructor(private area: HTMLElement, private preferences: Preferences, private colors: ReturnType<typeof palette>, private api: (path: string, data?: object) => Promise<any>, private restoreFocus: () => void) {
    this.pendingDialog.id = 'native-popup-pending'; this.pendingDialog.setAttribute('aria-label', 'Opening native popup'); this.pendingDialog.tabIndex = -1;
    this.pendingDialog.textContent = '[WAIT] OPENING HOST POPUP'; document.body.append(this.pendingDialog);
    this.pendingDialog.addEventListener('cancel', event => event.preventDefault());
    this.dialog.id = 'native-popup'; this.dialog.setAttribute('aria-label', 'Native terminal popup');
    this.dialog.tabIndex = -1;
    this.content.className = 'popup-content'; this.toolbar.className = 'popup-toolbar';
    const retry = document.createElement('button'); retry.textContent = '[R] RETRY'; retry.onclick = () => void this.controller?.connect();
    const takeover = document.createElement('button'); takeover.textContent = 'TAKE CONTROL'; takeover.onclick = () => void this.controller?.connect(true);
    this.closeButton.textContent = '[X] CLOSE'; this.closeButton.onclick = () => void this.closeExact();
    this.message.className = 'popup-status'; this.message.setAttribute('role', 'status');
    this.toolbar.append(retry, takeover, this.closeButton); this.dialog.append(this.toolbar, this.content, this.message); document.body.append(this.dialog);
    // Escape belongs to the terminal application, including shells and nested TUIs.
    this.dialog.addEventListener('cancel', event => event.preventDefault());
    document.addEventListener('close', () => queueMicrotask(() => this.present()), true);
    new ResizeObserver(() => this.layout()).observe(area);
    window.visualViewport?.addEventListener('resize', () => this.layout());
  }
  reconcile(host: HostView | undefined, tab: string) {
    const endpoint = host ? JSON.stringify([host.machine.id, noticeEndpointKey(host.machine), host.connectionGeneration]) : '';
    if (endpoint !== this.endpoint) { this.clear(); this.endpoint = endpoint; }
    if (tab !== this.selectedTab) this.cancelPending();
    this.selectedTab = tab; this.online = host?.connection === 'online';
    if (!host?.popup) { this.clear(); return; }
    if (host.popup.status === 'ready') {
      const popup = host.popup.popup;
      if (!popup) { this.clear(true); return; }
      if (this.popup?.terminal_id !== popup.terminal_id || this.popup.owner_tab_id !== popup.owner_tab_id) {
        this.clear(true); this.popup = popup;
        this.controller = new TerminalController(host.machine.id, popup.terminal_id, popup.terminal_id, this.toolbar, this.preferences, this.colors, () => {}, () => this.terminalChanged(), this.api, message => { this.message.textContent = message; }, { kind: 'popup', ownerTabId: popup.owner_tab_id });
        this.controller.chrome({ top: false, right: false, bottom: false, left: false }, '', 'Native terminal popup', true);
        this.content.append(this.controller.element);
      }
    }
    this.closeButton.disabled = !this.online || this.closing;
    this.present();
  }
  beginPending() {
    this.cancelPending(false);
    const pending = {}; this.pending = pending; let completed = false;
    this.pendingDialog.showModal(); this.pendingDialog.focus();
    return (opened: boolean) => {
      if (completed || this.pending !== pending) return;
      completed = true;
      if (opened) this.pending.timer = setTimeout(() => this.cancelPending(), 1000);
      else this.cancelPending();
    };
  }
  private cancelPending(restore = true) {
    clearTimeout(this.pending?.timer); this.pending = undefined;
    if (this.pendingDialog.open) { this.pendingDialog.close(); if (restore) this.restoreFocus(); }
  }
  private present() {
    const wanted = this.popup?.owner_tab_id === this.selectedTab && !!this.controller;
    if (wanted) this.cancelPending(false);
    const otherDialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(dialog => dialog !== this.dialog);
    if (!wanted || otherDialog) {
      this.controller?.show(false); if (this.dialog.open) this.dialog.close(); return;
    }
    if (!this.dialog.open) { this.dialog.showModal(); this.dialog.focus(); this.layout(); this.controller?.show(true); this.controller?.focus(); }
  }
  private terminalChanged() {
    const metrics = this.controller?.cellMetrics, key = `${metrics?.width}:${metrics?.height}`;
    if (key !== this.terminalMetrics) { this.terminalMetrics = key; this.layout(); }
    const ready = !!this.controller?.ready;
    const message = ready ? '' : this.controller?.status || '';
    if (this.message.textContent !== message) this.message.textContent = message;
    if (ready && !this.wasReady && this.dialog.open && document.activeElement === this.dialog) this.controller?.focus();
    this.wasReady = ready;
  }
  private layout() {
    if (!this.popup || !this.dialog.open) return;
    const area = this.area.getBoundingClientRect(), metrics = this.controller?.cellMetrics;
    const font = `${this.preferences.fontSize}px ${fontFamilies[this.preferences.font]}`;
    if (!metrics && font !== this.measuredFont) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) context.font = font;
      this.measuredFont = font; this.measuredWidth = context?.measureText('M').width || this.preferences.fontSize * .6;
    }
    const cellWidth = metrics?.width || this.measuredWidth;
    const cellHeight = metrics?.height || this.preferences.fontSize * 1.2;
    const cols = Math.floor(area.width / cellWidth), rows = Math.floor(area.height / cellHeight);
    const resolve = (size: PopupSize | undefined, available: number, minimum: number) => Math.min(available, Math.max(minimum, size === undefined ? Math.floor(available / 2) : typeof size === 'number' ? size : Math.floor(available * parseInt(size, 10) / 100)));
    const outerCols = resolve(this.popup.width, cols, 6), outerRows = resolve(this.popup.height, rows, 4);
    const width = outerCols * cellWidth, height = outerRows * cellHeight;
    Object.assign(this.dialog.style, { width: `${width}px`, height: `${height}px`, left: `${area.left + (area.width - width) / 2}px`, top: `${area.top + (area.height - height) / 2}px` });
    this.dialog.style.setProperty('--popup-cell-width', `${cellWidth}px`); this.dialog.style.setProperty('--popup-cell-height', `${cellHeight}px`);
    this.dialog.style.setProperty('--popup-right-inset', `${(outerCols - 2 <= 4 ? 1 : 2) * cellWidth}px`);
    this.dialog.dataset.cols = String(outerCols - (outerCols - 2 <= 4 ? 2 : 3)); this.dialog.dataset.rows = String(outerRows - 2);
  }
  private async closeExact() {
    const popup = this.popup, controller = this.controller;
    if (!popup || !controller || this.closing || !this.online) return;
    this.closing = true; this.closeButton.disabled = true;
    try { await this.api('/api/action', { machine: controller.machine, action: 'popup.close_exact', terminal_id: popup.terminal_id, owner_tab_id: popup.owner_tab_id }); }
    catch (error) { if (this.controller === controller) this.message.textContent = error instanceof Error ? error.message : 'Popup close failed.'; }
    finally { if (this.controller === controller) { this.closing = false; this.closeButton.disabled = !this.online; } }
  }
  update(preferences: Preferences, colors: ReturnType<typeof palette>) { this.preferences = preferences; this.colors = colors; this.controller?.update(preferences, colors); this.layout(); }
  recover() { this.controller?.recover(); }
  clear(preservePending = false) { if (!preservePending) this.cancelPending(); const focused = this.dialog.open; this.popup = undefined; this.closing = false; this.wasReady = false; this.terminalMetrics = ''; this.controller?.dispose(); this.controller = undefined; if (this.dialog.open) this.dialog.close(); if (focused) this.restoreFocus(); }
}
