import type { Terminal } from 'ghostty-web';
import { scrollbarOffset, scrollbarThumb, scrollState, type ScrollState } from '../shared/scrollbar';

let nextScrollTarget = 0;
export class NativeScrollbar {
  readonly element = document.createElement('div');
  private readonly track = document.createElement('span');
  private readonly thumb = document.createElement('span');
  private state?: ScrollState;
  private live = false;
  private enabled = true;
  private pending?: number;
  private requested?: number;
  private sending = false;
  private epoch = 0;
  private stateRevision = 0;
  private drag?: { id: number; grab: number };
  constructor(private readonly pane: HTMLElement, private readonly content: HTMLElement, private readonly terminal: () => Terminal | undefined,
    private readonly available: () => boolean, private readonly select: () => void,
    private readonly scroll: (offset: number) => Promise<unknown>, private readonly report: (message: string, failed?: boolean) => void) {
    this.element.className = 'pane-scrollbar'; this.element.hidden = true;
    this.element.setAttribute('role', 'scrollbar'); this.element.setAttribute('aria-label', 'Terminal scrollback');
    if (!this.content.id) this.content.id = `terminal-scroll-target-${++nextScrollTarget}`;
    this.element.setAttribute('aria-controls', this.content.id);
    this.element.setAttribute('aria-orientation', 'vertical'); this.element.tabIndex = 0;
    this.track.className = 'pane-scrollbar-track'; this.thumb.className = 'pane-scrollbar-thumb';
    this.track.setAttribute('aria-hidden', 'true'); this.thumb.setAttribute('aria-hidden', 'true'); this.element.append(this.track, this.thumb);
    this.element.addEventListener('pointerdown', this.down); this.element.addEventListener('pointermove', this.move);
    this.element.addEventListener('pointerup', this.up); this.element.addEventListener('pointercancel', this.abort);
    this.element.addEventListener('lostpointercapture', this.abort); this.element.addEventListener('keydown', this.key);
    window.addEventListener('blur', this.abort); this.pane.append(this.element);
  }
  update(value: unknown) { ++this.stateRevision; const next = scrollState(value); this.live = !!next; if (next) this.state = next; else this.suspend(); if (!this.sending && this.pending === undefined) this.requested = undefined; this.sync(); }
  preference(enabled: boolean) { if (this.enabled !== enabled && !enabled) this.suspend(); this.enabled = enabled; this.sync(); }
  suspend() { ++this.epoch; this.pending = undefined; this.requested = undefined; this.cancel(); }
  reset() { this.suspend(); this.live = false; this.state = undefined; this.sync(); }
  private geometry() {
    const terminal = this.terminal(), metrics = terminal?.renderer?.getMetrics();
    if (!terminal || !metrics || metrics.width <= 0 || metrics.height <= 0) return;
    return { width: metrics.width, height: metrics.height, rows: terminal.rows };
  }
  sync() {
    const geometry = this.geometry(), state = this.state;
    // Unknown screen identity cannot safely reserve a column for an application.
    const reserved = !!(this.enabled && geometry && state?.alternate_screen_active === false && Math.floor(this.pane.clientWidth / geometry.width) > 4);
    this.content.style.marginRight = reserved ? `${geometry!.width}px` : '0px';
    const thumb = reserved && state ? scrollbarThumb(state, geometry!.rows) : undefined;
    this.element.hidden = !thumb;
    if (!thumb || !geometry || !state) { this.cancel(); return; }
    this.element.style.width = `${geometry.width}px`; this.element.style.height = `${geometry.rows * geometry.height}px`;
    this.element.style.top = `${this.content.offsetTop}px`; this.element.style.lineHeight = `${geometry.height}px`;
    this.element.style.fontFamily = this.terminal()!.options.fontFamily || 'monospace';
    this.element.style.fontSize = `${this.terminal()!.options.fontSize}px`;
    const track = '▕\n'.repeat(geometry.rows), thumbText = `${this.pane.classList.contains('pane-active') ? '▐' : '▕'}\n`.repeat(thumb.length);
    if (this.track.textContent !== track) this.track.textContent = track;
    if (this.thumb.textContent !== thumbText) this.thumb.textContent = thumbText;
    this.thumb.style.top = `${thumb.top * geometry.height}px`;
    this.element.setAttribute('aria-valuemin', '0'); this.element.setAttribute('aria-valuemax', String(state.max_offset_from_bottom));
    this.element.setAttribute('aria-valuenow', String(state.max_offset_from_bottom - state.offset_from_bottom));
    this.element.setAttribute('aria-valuetext', this.live ? `${state.offset_from_bottom} lines above bottom` : 'Scroll position unavailable');
    this.element.setAttribute('aria-disabled', String(!this.live || !this.available()));
  }
  private row(clientY: number) {
    const geometry = this.geometry();
    return geometry ? Math.floor((clientY - this.element.getBoundingClientRect().top) / geometry.height) : 0;
  }
  private request(offset: number) {
    if (!this.live || !this.available() || !this.state) return;
    this.requested = this.pending = Math.max(0, Math.min(this.state.max_offset_from_bottom, offset));
    if (!this.sending) void this.flush();
  }
  private async flush() {
    this.sending = true;
    try {
      while (this.pending !== undefined && this.live && this.available()) {
        const offset = this.pending, epoch = this.epoch, revision = this.stateRevision; this.pending = undefined;
        try {
          const result = await this.scroll(offset) as { pane?: { scroll?: unknown } };
          if (epoch === this.epoch && revision === this.stateRevision) { const state = scrollState(result?.pane?.scroll); if (state) { this.state = state; this.sync(); } }
        }
        catch (error) { if (epoch === this.epoch) { this.pending = undefined; this.requested = undefined; this.cancel(); this.report((error as Error).message, true); } }
      }
    } finally { this.sending = false; if (!this.available()) this.pending = undefined; if (this.pending === undefined) this.requested = undefined; }
  }
  private down = (event: PointerEvent) => {
    const geometry = this.geometry(), state = this.state;
    if (event.button !== 0 || !geometry || !state || !this.live || !this.available()) return;
    const thumb = scrollbarThumb(state, geometry.rows); if (!thumb) return;
    event.preventDefault(); event.stopPropagation(); this.select(); this.element.focus({ preventScroll: true });
    const row = this.row(event.clientY), grabbed = row >= thumb.top && row < thumb.top + thumb.length;
    this.drag = { id: event.pointerId, grab: grabbed ? row - thumb.top : Math.floor(thumb.length / 2) };
    this.element.setPointerCapture(event.pointerId);
    if (!grabbed) this.request(scrollbarOffset(state, geometry.rows, row));
  };
  private move = (event: PointerEvent) => {
    const geometry = this.geometry();
    if (!this.drag || event.pointerId !== this.drag.id || !geometry || !this.state) return;
    event.preventDefault(); this.request(scrollbarOffset(this.state, geometry.rows, this.row(event.clientY), this.drag.grab));
  };
  private up = (event: PointerEvent) => { if (this.drag?.id === event.pointerId) { this.move(event); this.cancel(); } };
  private abort = (event: Event) => { if (event.type === 'blur' || this.drag) this.suspend(); };
  private cancel = () => {
    const drag = this.drag; this.drag = undefined;
    if (drag && this.element.hasPointerCapture(drag.id)) this.element.releasePointerCapture(drag.id);
  };
  private key = (event: KeyboardEvent) => {
    if (!this.state || !this.live || !this.available() || event.altKey || event.ctrlKey || event.metaKey) return;
    const { viewport_rows: rows, max_offset_from_bottom: max } = this.state;
    const offset = this.requested ?? this.state.offset_from_bottom;
    const target: Record<string, number> = { ArrowUp: offset + 1, ArrowDown: offset - 1, PageUp: offset + rows, PageDown: offset - rows, Home: max, End: 0 };
    if (target[event.key] === undefined) return;
    event.preventDefault(); event.stopPropagation(); this.select(); this.request(target[event.key]);
  };
  dispose() { this.reset(); window.removeEventListener('blur', this.abort); this.element.remove(); }
}
