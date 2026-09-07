import type { Terminal } from 'ghostty-web';
import { loadGhostty } from './terminal-loader';
import { fontFamilies, type Preferences, palette } from '../shared/settings';
type Colors = ReturnType<typeof palette>;
export class TerminalController {
  readonly element = document.createElement('section');
  private readonly content = document.createElement('div');
  private readonly shield = document.createElement('div');
  private readonly title = document.createElement('button');
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
  constructor(readonly machine: string, readonly pane: string, readonly terminalId: string, private preferences: Preferences, private colors: Colors, private select: () => void, private changed: () => void) {
    this.element.className = 'terminal-pane'; this.element.dataset.pane = pane;
    this.content.className = 'pane-content'; this.shield.className = 'pane-shield'; this.shield.setAttribute('role', 'status');
    this.title.className = 'pane-title'; this.title.onclick = () => { select(); this.focus(); };
    this.element.append(this.title, this.content, this.shield);
    this.element.addEventListener('pointerdown', select); this.element.addEventListener('focusin', select);
  }
  activate(active: boolean) { this.element.classList.toggle('pane-active', active); }
  label(label: string, active: boolean) { if (this.title.textContent !== label) { this.title.textContent = label; this.title.title = label; } this.activate(active); this.element.setAttribute('aria-label', label); }
  show(visible: boolean) {
    const changed = this.visible !== visible; this.visible = visible; this.element.hidden = !visible;
    if (visible) { if (changed) { this.fit?.(); this.recover(); } if (!this.terminal && !this.cleanup) void this.connect(); }
  }
  update(preferences: Preferences, colors: Colors) {
    this.preferences = preferences; this.colors = colors;
    if (this.terminal) { Object.assign(this.terminal.options, this.options()); if (this.visible) this.fit?.(); }
  }
  private options() { return { fontFamily: fontFamilies[this.preferences.font], fontSize: this.preferences.fontSize, cursorBlink: this.preferences.cursorBlink, theme: { background: this.colors.panel_bg, foreground: this.colors.text, cursor: this.colors.accent, selectionBackground: this.colors.selection_bg } }; }
  focus() { this.terminal?.focus(); }
  recover() {
    // Connectivity recovery resumes only exhausted attachments. Healthy sockets
    // and their scheduled retries retain their renderer and ownership.
    if (this.visible && this.socket?.readyState === WebSocket.CLOSED && !this.timer) void this.connect();
  }
  private reset() {
    ++this.epoch; clearTimeout(this.timer); this.timer = undefined; this.socket?.close(); this.socket = undefined;
    this.cleanup?.(); this.cleanup = undefined; this.fit = undefined; this.terminal = undefined;
    this.content.replaceChildren(); this.ready = false; this.shield.hidden = false;
  }
  dispose() { this.reset(); this.element.remove(); }
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
    let applyingFrame = false;
    const boot = document.querySelector<HTMLDialogElement>('#boot')!;
    const reveal = () => { if (epoch === this.epoch && this.ready && !boot.open) { this.shield.hidden = true; this.changed(); } };
    boot.addEventListener('close', reveal);
    const input = term.onData(text => send({ type: 'terminal.input', text }));
    const resize = term.onResize(({ cols, rows }) => { if (!applyingFrame && this.visible) send({ type: 'terminal.resize', cols, rows }); });
    const observer = new ResizeObserver(fitVisible); observer.observe(this.content);
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopImmediatePropagation(); send({ type: 'terminal.scroll', direction: event.deltaY < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 90) * this.preferences.scrollLines)) }); };
    this.content.addEventListener('wheel', wheel, { passive: false, capture: true });
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
    const touchMove = (event: TouchEvent) => {
      if (touchY === undefined || event.touches.length !== 1) return;
      const delta = touchY - event.touches[0].clientY; if (Math.abs(delta) < 12) return;
      event.preventDefault(); event.stopImmediatePropagation(); touchY = event.touches[0].clientY;
      send({ type: 'terminal.scroll', direction: delta < 0 ? 'up' : 'down', lines: Math.min(100, Math.max(1, Math.round(Math.abs(delta) / 14))) });
    };
    this.content.addEventListener('touchstart', touchStart, { passive: true, capture: true }); this.content.addEventListener('touchmove', touchMove, { passive: false, capture: true });
    const textarea = this.content.querySelector('textarea');
    if (textarea) for (const [key, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })) textarea.setAttribute(key, value);
    ws.onmessage = event => {
      if (epoch !== this.epoch) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'terminal.closed') { this.ready = false; this.shield.hidden = false; this.failure = typeof frame.reason === 'string' ? frame.reason : 'Terminal detached'; this.shield.textContent = this.failure || 'Terminal detached'; this.changed(); return; }
        if (frame.type !== 'terminal.frame' || frame.encoding !== 'ansi') return;
        const bytes = Uint8Array.from(atob(frame.bytes), c => c.charCodeAt(0));
        applyingFrame = true;
        try { if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height); } finally { applyingFrame = false; }
        term.write(bytes, () => { if (epoch === this.epoch) { this.ready = true; this.failure = undefined; this.attempt = 0; reveal(); } });
      } catch { ws.close(1002, 'Invalid frame'); }
    };
    ws.onclose = () => {
      if (epoch !== this.epoch) return;
      this.ready = false; this.shield.hidden = false;
      if (this.attempt >= 5) { this.shield.textContent = this.failure || 'Terminal unavailable or already controlled. Retry or use TAKE CONTROL.'; this.changed(); return; }
      this.shield.textContent = this.failure || 'Connection lost. Reattaching...'; this.changed();
      this.timer = setTimeout(() => { this.timer = undefined; if (epoch === this.epoch) void this.connect(false, true); }, Math.min(1000 * 2 ** this.attempt++, 10000));
    };
    this.cleanup = () => { boot.removeEventListener('close', reveal); observer.disconnect(); input.dispose(); resize.dispose(); this.content.removeEventListener('wheel', wheel, true); this.content.removeEventListener('touchstart', touchStart, true); this.content.removeEventListener('touchmove', touchMove, true); term.dispose(); };
  }
}
