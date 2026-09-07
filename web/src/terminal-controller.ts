import type { Terminal } from 'ghostty-web';
import { loadGhostty } from './terminal-loader';
import { fontFamilies, type Preferences, palette } from '../shared/settings';
import { NativeKeyboard } from './native-keyboard';
import { NativeMouse } from './native-mouse';
import { NativeLinks } from './native-links';
import { NativeCopyMode } from './native-copy-mode';
type Colors = ReturnType<typeof palette>;
export class TerminalController {
  readonly element = document.createElement('section');
  private readonly content = document.createElement('div');
  private readonly shield = document.createElement('div');
  private readonly title = document.createElement('button');
  readonly copyMode: NativeCopyMode;
  private readonly links: NativeLinks;
  private readonly mouse: NativeMouse;
  private terminal?: Terminal;
  private socket?: WebSocket;
  private cleanup?: () => void;
  private fit?: () => void;
  private epoch = 0;
  private attempt = 0;
  private failure?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private visible = true;
  ready = false;
  get status() { return this.shield.textContent || 'Attaching to Herdr...'; }
  get selection() { return this.terminal?.getSelection() || ''; }
  constructor(readonly machine: string, readonly pane: string, readonly terminalId: string, private preferences: Preferences, private colors: Colors, private select: () => void, private changed: () => void, api: (path: string, data?: object) => Promise<any>, report: (message: string, failed?: boolean) => void) {
    this.element.className = 'terminal-pane'; this.element.dataset.pane = pane;
    this.content.className = 'pane-content'; this.shield.className = 'pane-shield'; this.shield.setAttribute('role', 'status');
    this.title.className = 'pane-title'; this.title.onclick = () => { select(); this.focus(); };
    this.element.append(this.title, this.content, this.shield);
    this.copyMode = new NativeCopyMode(this.element, this.content, () => this.terminal, (action, params) => api('/api/action', { machine, id: pane, action, ...params }), () => this.focus(), report);
    this.links = new NativeLinks(this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active, (action, params) => api('/api/action', { machine, id: pane, action, ...params }), report);
    this.mouse = new NativeMouse(this.content, () => this.terminal, () => this.ready && this.visible && !this.copyMode.active, text => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'terminal.input', text })); });
    this.element.addEventListener('pointerdown', select); this.element.addEventListener('focusin', select);
  }
  activate(active: boolean) { if (!active) { this.mouse.release(); this.copyMode.exit(true, false); this.links.cancel(); } this.element.classList.toggle('pane-active', active); }
  label(label: string, active: boolean) { if (this.title.textContent !== label) { this.title.textContent = label; this.title.title = label; } this.activate(active); this.element.setAttribute('aria-label', label); }
  show(visible: boolean) {
    const changed = this.visible !== visible; this.visible = visible; this.element.hidden = !visible; if (!visible) { this.links.cancel(); this.mouse.release(); }
    if (visible) { if (changed) { this.fit?.(); this.recover(); } if (!this.terminal && !this.cleanup) void this.connect(); }
  }
  update(preferences: Preferences, colors: Colors) {
    this.preferences = preferences; this.colors = colors;
    if (this.terminal) { Object.assign(this.terminal.options, this.options()); if (this.visible) this.fit?.(); }
  }
  private options() { return { focusOnOpen: false, fontFamily: fontFamilies[this.preferences.font], fontSize: this.preferences.fontSize, cursorBlink: this.preferences.cursorBlink, theme: { background: this.colors.panel_bg, foreground: this.colors.text, cursor: this.colors.accent, selectionBackground: this.colors.selection_bg } }; }
  // Ghostty.focus() queues another focus call that can outlive this selection.
  focus() { if (this.copyMode.active) this.copyMode.focus(); else this.terminal?.textarea?.focus({ preventScroll: true }); }
  recover() {
    // Connectivity recovery resumes only exhausted attachments. Healthy sockets
    // and their scheduled retries retain their renderer and ownership.
    if (this.visible && this.socket?.readyState === WebSocket.CLOSED && !this.timer) void this.connect();
  }
  private reset() {
    this.mouse.setEnabled(false); this.copyMode.exit(true, false); this.links.cancel();
    ++this.epoch; clearTimeout(this.timer); this.timer = undefined; this.socket?.close(); this.socket = undefined;
    this.cleanup?.(); this.cleanup = undefined; this.fit = undefined; this.terminal = undefined;
    this.content.replaceChildren(); this.ready = false; this.shield.hidden = false;
  }
  dispose() { this.reset(); this.mouse.dispose(); this.links.dispose(); this.element.remove(); }
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
    const fitVisible = () => { if (this.visible && this.content.clientWidth > 0 && this.content.clientHeight > 0) fit.fit(); };
    this.fit = fitVisible; fitVisible();
    const params = new URLSearchParams({ machine: this.machine, pane: this.pane, cols: String(term.cols), rows: String(term.rows), takeover: takeover ? '1' : '0' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal?${params}`); this.socket = ws;
    const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const keyboard = new NativeKeyboard(this.content, term, term.createInputEncoder(), library, () => this.ready && this.visible && !this.copyMode.active, text => send({ type: 'terminal.input', text }));
    let applyingFrame = false;
    const boot = document.querySelector<HTMLDialogElement>('#boot')!;
    const reveal = () => { if (epoch === this.epoch && this.ready && !boot.open) { this.shield.hidden = true; this.changed(); } };
    boot.addEventListener('close', reveal);
    const input = term.onData(text => { if (!this.copyMode.active) send({ type: 'terminal.input', text }); });
    const resize = term.onResize(({ cols, rows }) => { this.links.cancel(); this.copyMode.afterFrame(); if (!applyingFrame && this.visible) send({ type: 'terminal.resize', cols, rows }); });
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
        if (frame.type === 'terminal.keyboard') { keyboard.update(frame.flags, frame.modify_other_keys_level); return; }
        if (frame.type === 'terminal.mouse' && typeof frame.enabled === 'boolean') { this.mouse.setEnabled(frame.enabled); return; }
        if (frame.type === 'terminal.closed') { this.mouse.setEnabled(false); this.links.cancel(); this.copyMode.exit(false, false); this.ready = false; this.shield.hidden = false; this.failure = typeof frame.reason === 'string' ? frame.reason : 'Terminal detached'; this.shield.textContent = this.failure || 'Terminal detached'; this.changed(); return; }
        if (frame.type !== 'terminal.frame' || frame.encoding !== 'ansi') return;
        this.links.invalidate();
        const bytes = Uint8Array.from(atob(frame.bytes), c => c.charCodeAt(0));
        applyingFrame = true;
        try { if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height); } finally { applyingFrame = false; }
        term.write(bytes, () => { if (epoch === this.epoch) { this.ready = true; this.failure = undefined; this.attempt = 0; this.copyMode.afterFrame(); reveal(); } });
      } catch { ws.close(1002, 'Invalid frame'); }
    };
    ws.onclose = () => {
      if (epoch !== this.epoch) return;
      this.mouse.setEnabled(false); this.copyMode.exit(false, false); this.links.cancel();
      this.ready = false; this.shield.hidden = false;
      if (this.attempt >= 5) { this.shield.textContent = this.failure || 'Terminal unavailable or already controlled. Retry or use TAKE CONTROL.'; this.changed(); return; }
      this.shield.textContent = this.failure || 'Connection lost. Reattaching...'; this.changed();
      this.timer = setTimeout(() => { this.timer = undefined; if (epoch === this.epoch) void this.connect(false, true); }, Math.min(1000 * 2 ** this.attempt++, 10000));
    };
    this.cleanup = () => { keyboard.dispose(); boot.removeEventListener('close', reveal); observer.disconnect(); input.dispose(); resize.dispose(); this.content.removeEventListener('wheel', wheel, true); this.content.removeEventListener('touchstart', touchStart, true); this.content.removeEventListener('touchmove', touchMove, true); term.dispose(); };
  }
}
