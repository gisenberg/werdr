import { type PaneChrome } from '../shared/pane-chrome';
import type { Terminal } from 'ghostty-web';
import { loadGhostty } from './terminal-loader';
import { fontFamilies, type Preferences, palette } from '../shared/settings';
import { NativeKeyboard } from './native-keyboard';
import { NativeMouse } from './native-mouse';
import { NativeLinks } from './native-links';
import { NativeScrollbar } from './native-scrollbar';
import { NativeCopyMode } from './native-copy-mode';
import { TerminalImagePaste } from './terminal-image-paste';
import { NativeSelection } from './native-selection';
import { terminalSelectionColors } from './terminal-selection';
type Colors = ReturnType<typeof palette>;
export class TerminalController {
  readonly element = document.createElement('section');
  private readonly content = document.createElement('div');
  private readonly shield = document.createElement('div');
  private readonly title = document.createElement('button');
  private readonly titleLabel = document.createElement('span');
  readonly copyMode: NativeCopyMode;
  private readonly links: NativeLinks;
  private readonly mouse: NativeMouse;
  private readonly scrollbar: NativeScrollbar;
  private readonly selectionMode: NativeSelection;
  private terminal?: Terminal;
  private socket?: WebSocket;
  private keyboard?: NativeKeyboard;
  private imagePaste?: TerminalImagePaste;
  private cleanup?: () => void;
  private fit?: () => void;
  private epoch = 0;
  private attempt = 0;
  private failure?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private visible = true;
  private chromeMask = -1;
  private description = '';
  ready = false;
  get attachmentGeneration() { return this.epoch; }
  get status() { return this.shield.textContent || 'Attaching to Herdr...'; }
  sendKey(event: KeyboardEvent) { if (this.ready && this.visible) this.keyboard?.sendKey(event); }
  readSelection() { return this.copyMode.active ? this.copyMode.readText() : this.selectionMode.hasSelection ? this.selectionMode.readText() : Promise.resolve(this.terminal?.getSelection() || ''); }
  constructor(readonly machine: string, readonly pane: string, readonly terminalId: string, toolbarHost: HTMLElement, private preferences: Preferences, private colors: Colors, private select: () => void, private changed: () => void, api: (path: string, data?: object) => Promise<any>, private report: (message: string, failed?: boolean) => void) {
    this.element.className = 'terminal-pane'; this.element.dataset.pane = pane;
    this.content.className = 'pane-content'; this.shield.className = 'pane-shield'; this.shield.setAttribute('role', 'status');
    this.title.append(this.titleLabel);
    this.title.className = 'pane-title'; this.title.onclick = () => { select(); this.focus(); };
    this.element.append(this.title, this.content, this.shield);
    this.copyMode = new NativeCopyMode(this.element, this.content, toolbarHost, () => this.terminal, (action, params) => api('/api/action', { machine, id: pane, action, ...params }), () => this.focus(), report, () => { this.selectionMode.clear(); this.links.cancel(); this.mouse.release(); });
    this.links = new NativeLinks(this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active, (action, params) => api('/api/action', { machine, id: pane, action, ...params }), report);
    this.mouse = new NativeMouse(this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active, text => this.imagePaste?.send({ type: 'terminal.input', text }));
    this.selectionMode = new NativeSelection(this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active && !this.mouse.reporting, () => this.preferences.copyOnSelect, () => this.preferences.scrollLines, (action, params) => api('/api/action', { machine, id: pane, action, ...params }), report);
    this.scrollbar = new NativeScrollbar(this.element, this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active, () => { select(); this.links.cancel(); this.mouse.release(); this.selectionMode.clear(); }, offset_from_bottom => api('/api/action', { machine, id: pane, action: 'pane.scroll', offset_from_bottom }), report);
    this.scrollbar.preference(preferences.paneScrollbars);
    this.element.addEventListener('pointerdown', select); this.element.addEventListener('focusin', select);
  }
  activate(active: boolean) { if (!active) { this.imagePaste?.cancel(); this.scrollbar.suspend(); this.mouse.release(); this.copyMode.exit(true, false); this.links.cancel(); this.selectionMode.clear(); } if (this.element.classList.contains('pane-active') !== active) { this.element.classList.toggle('pane-active', active); this.scrollbar.sync(); } }
  chrome(chrome: PaneChrome, label: string, description: string, active: boolean) {
    const mask = Number(chrome.top) | Number(chrome.right) << 1 | Number(chrome.bottom) << 2 | Number(chrome.left) << 3;
    if (mask !== this.chromeMask) {
      this.chromeMask = mask;
      for (const edge of ['right', 'bottom', 'left'] as const) this.element.style.setProperty(`--pane-border-${edge}`, chrome[edge] ? '1px' : '0px');
      this.element.dataset.topBorder = String(chrome.top); this.title.hidden = !chrome.top;
    }
    if (this.titleLabel.textContent !== label) this.titleLabel.textContent = label;
    if (this.title.title !== (label || description)) this.title.title = label || description;
    if (description !== this.description) {
      this.description = description; this.title.setAttribute('aria-label', description); this.element.setAttribute('aria-label', description);
    }
    this.activate(active);
  }
  show(visible: boolean) {
    const changed = this.visible !== visible; this.visible = visible; this.element.hidden = !visible; if (!visible) { this.imagePaste?.cancel(); this.scrollbar.suspend(); this.links.cancel(); this.mouse.release(); this.selectionMode.clear(); }
    if (visible) { if (changed) { this.fit?.(); this.recover(); } if (!this.terminal && !this.cleanup) void this.connect(); }
  }
  update(preferences: Preferences, colors: Colors) {
    if (this.preferences.copyOnSelect !== preferences.copyOnSelect) this.selectionMode.clear();
    this.preferences = preferences; this.colors = colors; this.scrollbar.preference(preferences.paneScrollbars);
    if (this.terminal) { Object.assign(this.terminal.options, this.options()); if (this.visible) this.fit?.(); }
  }
  private options() { return { focusOnOpen: false, fontFamily: fontFamilies[this.preferences.font], fontSize: this.preferences.fontSize, cursorBlink: this.preferences.cursorBlink, theme: { background: this.colors.panel_bg, foreground: this.colors.text, cursor: this.colors.accent, ...terminalSelectionColors(this.colors.panel_bg) } }; }
  // Ghostty.focus() queues another focus call that can outlive this selection.
  focus() { if (this.copyMode.active) this.copyMode.focus(); else this.terminal?.textarea?.focus({ preventScroll: true }); }
  recover() {
    // Connectivity recovery resumes only exhausted attachments. Healthy sockets
    // and their scheduled retries retain their renderer and ownership.
    if (this.visible && this.socket?.readyState === WebSocket.CLOSED && !this.timer) void this.connect();
  }
  private reset() {
    this.imagePaste?.cancel();
    this.scrollbar.reset(); this.mouse.setEnabled(false); this.copyMode.exit(true, false); this.links.cancel(); this.selectionMode.clear();
    this.imagePaste?.dispose(); this.imagePaste = undefined;
    ++this.epoch; clearTimeout(this.timer); this.timer = undefined; this.socket?.close(); this.socket = undefined;
    this.cleanup?.(); this.cleanup = undefined; this.keyboard = undefined; this.fit = undefined; this.terminal = undefined;
    this.content.replaceChildren(); this.ready = false; this.shield.hidden = false;
  }
  dispose() { this.reset(); this.scrollbar.dispose(); this.mouse.dispose(); this.links.dispose(); this.selectionMode.dispose(); this.element.remove(); }
  async connect(takeover = false, retry = false) {
    this.reset(); if (!this.visible) return; if (!retry) this.attempt = 0;
    const epoch = this.epoch; if (!retry) this.failure = undefined; this.shield.textContent = this.failure || 'Attaching to Herdr...'; this.changed();
    // Reserve the pending instance so a metadata update cannot start another load.
    this.cleanup = () => {};
    let library: Awaited<ReturnType<typeof loadGhostty>>;
    try { library = await loadGhostty(); } catch { if (epoch === this.epoch) { this.cleanup = undefined; this.shield.textContent = 'Terminal renderer could not load. Retry attachment.'; this.changed(); } return; }
    if (epoch !== this.epoch) return;
    const term = new library.Terminal(this.options()); this.terminal = term;
    const fit = new library.FitAddon(); term.loadAddon(fit); term.open(this.content);
    let desired = { cols: term.cols, rows: term.rows };
    const fitVisible = () => { if (this.visible && this.content.clientWidth > 0 && this.content.clientHeight > 0) { fit.fit(); desired = { cols: term.cols, rows: term.rows }; this.scrollbar.sync(); } };
    this.fit = fitVisible; fitVisible();
    const params = new URLSearchParams({ machine: this.machine, pane: this.pane, cols: String(term.cols), rows: String(term.rows), takeover: takeover ? '1' : '0' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal?${params}`); this.socket = ws;
    const images = new TerminalImagePaste(this.content, term.textarea!, () => epoch === this.epoch && this.ready && this.visible && this.element.classList.contains('pane-active') && !this.copyMode.active, data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); else if (typeof data !== 'string') throw new Error('Terminal disconnected before image transfer.'); }, this.report);
    this.imagePaste = images;
    const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) images.send(value); };
    let forwarded = { ...desired };
    const sendSize = () => {
      if (ws.readyState !== WebSocket.OPEN || desired.cols === forwarded.cols && desired.rows === forwarded.rows) return;
      send({ type: 'terminal.resize', ...desired }); forwarded = { ...desired };
    };
    // ResizeObserver can run while the handshake is pending. Preserve its most
    // recent dimensions rather than losing the resize before the socket opens.
    ws.onopen = sendSize;
    const keyboard = new NativeKeyboard(this.content, term, term.createInputEncoder(), library, () => this.ready && this.visible && !this.copyMode.active, text => send({ type: 'terminal.input', text }));
    this.keyboard = keyboard;
    let applyingFrame = false, scrollReady = false, settled = false;
    let paintedSize: { width: number; height: number } | undefined;
    const boot = document.querySelector<HTMLDialogElement>('#boot')!;
    const reveal = () => {
      if (!settled && scrollReady && paintedSize?.width === desired.cols && paintedSize.height === desired.rows) settled = true;
      if (epoch !== this.epoch || !settled) return;
      if (!this.ready) { this.ready = true; this.scrollbar.sync(); }
      if (!boot.open) { this.shield.hidden = true; this.changed(); }
    };
    // Optional metadata must not indefinitely block a compatible terminal.
    const scrollTimeout = setTimeout(() => { scrollReady = true; reveal(); }, 2000);
    boot.addEventListener('close', reveal);
    const input = term.onData(text => { this.selectionMode.clear(); if (!this.copyMode.active) send({ type: 'terminal.input', text }); });
    const resize = term.onResize(({ cols, rows }) => { this.scrollbar.sync(); this.links.cancel(); this.selectionMode.clear(); this.copyMode.afterFrame(); if (!applyingFrame && this.visible) { desired = { cols, rows }; sendSize(); } });
    const observer = new ResizeObserver(fitVisible); observer.observe(this.content);
    // AttachScroll uses crossterm modifier bits, unlike SGR mouse reports.
    const scrollPoint = (event: { clientX: number; clientY: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) => {
      const point = this.mouse.point(event);
      return point ? { column: point.column, row: point.row, modifiers: (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0) } : {};
    };
    const wheel = (event: WheelEvent) => { if (this.copyMode.active || !event.deltaY) return; this.links.cancel(); event.preventDefault(); event.stopImmediatePropagation(); send({ type: 'terminal.scroll', ...scrollPoint(event), direction: event.deltaY < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 90) * this.preferences.scrollLines)) }); };
    this.content.addEventListener('wheel', wheel, { passive: false, capture: true });
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
    const touchMove = (event: TouchEvent) => {
      if (this.copyMode.active) return;
      if (touchY === undefined || event.touches.length !== 1) return;
      const delta = touchY - event.touches[0].clientY; if (Math.abs(delta) < 12) return;
      this.links.cancel(); event.preventDefault(); event.stopImmediatePropagation(); touchY = event.touches[0].clientY;
      send({ type: 'terminal.scroll', ...scrollPoint(event.touches[0]), direction: delta < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.round(Math.abs(delta) / 14))) });
    };
    this.content.addEventListener('touchstart', touchStart, { passive: true, capture: true }); this.content.addEventListener('touchmove', touchMove, { passive: false, capture: true });
    const textarea = this.content.querySelector('textarea');
    if (textarea) for (const [key, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })) textarea.setAttribute(key, value);
    ws.onmessage = event => {
      if (epoch !== this.epoch) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'terminal.capabilities') { images.capabilities(frame.clipboard_image_max_bytes); return; }
        if (frame.type === 'terminal.image') { images.result(frame.status, frame.message); return; }
        if (frame.type === 'terminal.scroll-state') { this.scrollbar.update(frame.scroll); scrollReady = frame.ready !== false; if (scrollReady) { clearTimeout(scrollTimeout); fitVisible(); reveal(); } return; }
        if (frame.type === 'terminal.keyboard') { keyboard.update(frame.flags, frame.modify_other_keys_level); return; }
        if (frame.type === 'terminal.mouse' && typeof frame.enabled === 'boolean') { if (frame.enabled) this.selectionMode.clear(); this.mouse.setEnabled(frame.enabled); return; }
        if (frame.type === 'terminal.closed') { this.scrollbar.reset(); this.mouse.setEnabled(false); this.links.cancel(); this.selectionMode.clear(); this.copyMode.exit(false, false); this.ready = false; this.shield.hidden = false; this.failure = typeof frame.reason === 'string' ? frame.reason : 'Terminal detached'; this.shield.textContent = this.failure || 'Terminal detached'; this.changed(); return; }
        if (frame.type !== 'terminal.frame' || frame.encoding !== 'ansi') return;
        this.links.invalidate();
        const size = { width: frame.width, height: frame.height };
        const bytes = Uint8Array.from(atob(frame.bytes), c => c.charCodeAt(0));
        applyingFrame = true;
        try { if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height); } finally { applyingFrame = false; }
        term.write(bytes, () => { if (epoch === this.epoch) { paintedSize = size; this.failure = undefined; this.attempt = 0; this.copyMode.afterFrame(); this.selectionMode.afterFrame(); reveal(); } });
      } catch { ws.close(1002, 'Invalid frame'); }
    };
    ws.onclose = () => {
      if (epoch !== this.epoch) return;
      this.scrollbar.reset(); this.mouse.setEnabled(false); this.copyMode.exit(false, false); this.links.cancel(); this.selectionMode.clear();
      images.dispose();
      this.ready = false; this.shield.hidden = false;
      if (this.attempt >= 5) { this.shield.textContent = this.failure || 'Terminal unavailable or already controlled. Retry or use TAKE CONTROL.'; this.changed(); return; }
      this.shield.textContent = this.failure || 'Connection lost. Reattaching...'; this.changed();
      this.timer = setTimeout(() => { this.timer = undefined; if (epoch === this.epoch) void this.connect(false, true); }, Math.min(1000 * 2 ** this.attempt++, 10000));
    };
    this.cleanup = () => { clearTimeout(scrollTimeout); keyboard.dispose(); boot.removeEventListener('close', reveal); observer.disconnect(); input.dispose(); resize.dispose(); this.content.removeEventListener('wheel', wheel, true); this.content.removeEventListener('touchstart', touchStart, true); this.content.removeEventListener('touchmove', touchMove, true); term.dispose(); };
  }
}
