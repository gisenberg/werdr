import type { Terminal } from 'ghostty-web';
import { matchesNativeViewport, terminalRowCells, terminalViewportText, type NativeViewport } from './terminal-viewport';
import { terminalWord } from './terminal-word';
import { writeTerminalClipboard } from './terminal-clipboard';
import { paintTerminalSelection } from './terminal-selection';

type Point = { row: number; col: number };
type Position = { x: number; y: number };
type Selection = {
  origin: Point; position: Position; cols: number; rows: number; text: string;
  pressed: boolean; finishing: boolean; visible: boolean; word?: { start: number; end: number }; copying: boolean;
  ready: Promise<void>; context?: NativeViewport; anchor?: Point; cursor?: Point;
  scrolling?: Promise<void>; targetOffset?: number; nextOffset?: number;
};

/** Normal-mode mouse selection uses native buffer coordinates and native text reads. */
export class NativeSelection {
  private state?: Selection;
  get hasSelection() { return !!this.state?.visible; }
  commandSelection(): import('../shared/commands').CommandSelection | undefined {
    const state = this.state;
    if (!state?.visible) return;
    if (!this.current(state) || state.scrolling || !state.context || !state.anchor || !state.cursor || !matchesNativeViewport(this.terminal(), state.context)) throw new Error('Terminal selection changed. Select the text again before running the command.');
    return { anchor: { ...state.anchor }, cursor: { ...state.cursor }, content_revision: state.context.content_revision };
  }
  private lastClick?: Point & { at: number };
  private edgeTimer?: ReturnType<typeof setInterval>;
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private touched = -Infinity;

  constructor(private content: HTMLElement, private terminal: () => Terminal | undefined, private available: () => boolean, private copyOnSelect: () => boolean, private scrollLines: () => number, private request: (action: string, params?: object) => Promise<any>, private report: (message: string, failed?: boolean) => void) {
    content.addEventListener('mousedown', this.down, true);
    content.addEventListener('click', this.click, true);
    content.addEventListener('wheel', this.wheel, { capture: true, passive: false });
    content.addEventListener('touchstart', this.touch, { capture: true, passive: true });
    document.addEventListener('mousemove', this.move, true); document.addEventListener('mouseup', this.up, true);
    document.addEventListener('keydown', this.key, true); window.addEventListener('blur', this.blur);
  }
  clear() {
    this.state = undefined; this.lastClick = undefined;
    clearInterval(this.edgeTimer); this.edgeTimer = undefined; clearTimeout(this.highlightTimer); this.highlightTimer = undefined;
    this.terminal()?.clearSelection(); delete this.content.dataset.nativeSelection;
  }
  dispose() {
    this.clear();
    this.content.removeEventListener('mousedown', this.down, true); this.content.removeEventListener('click', this.click, true); this.content.removeEventListener('wheel', this.wheel, true); this.content.removeEventListener('touchstart', this.touch, true);
    document.removeEventListener('mousemove', this.move, true); document.removeEventListener('mouseup', this.up, true);
    document.removeEventListener('keydown', this.key, true); window.removeEventListener('blur', this.blur);
  }
  afterFrame() {
    const state = this.state, term = this.terminal();
    if (!state || state.scrolling) return;
    if (!this.current(state) || !term || (state.context ? !matchesNativeViewport(term, state.context) : terminalViewportText(term) !== state.text)) {
      const visible = state.visible; this.clear();
      if (visible) this.report('Terminal content changed. Select the text again.', true);
    }
  }
  async readText(state = this.state): Promise<string> {
    if (!state?.visible) return '';
    await state.ready;
    if (state.scrolling) await state.scrolling;
    if (!this.current(state) || !state.context || !state.anchor || !state.cursor) throw new Error('Terminal selection changed before it could be read.');
    const result = await this.request('pane.selection.read', { anchor: state.anchor, cursor: state.cursor, content_revision: state.context.content_revision });
    if (!this.current(state)) throw new Error('Terminal selection changed before it could be read.');
    if (typeof result.text !== 'string') throw new Error('Native selection text is unavailable.');
    return result.text;
  }
  private current(state: Selection) { return this.state === state && this.available() && this.terminal()?.cols === state.cols && this.terminal()?.rows === state.rows; }
  private stop(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); }
  private touch = () => { this.touched = performance.now(); this.clear(); };
  private blur = () => this.clear();
  private click = (event: MouseEvent) => { if (this.available() && performance.now() - this.touched >= 1000 && event.target instanceof HTMLCanvasElement) this.stop(event); };
  private point(position: Position): Point | undefined {
    const term = this.terminal(), canvas = this.content.querySelector('canvas'), metrics = term?.renderer?.getMetrics();
    if (!term || !canvas || !metrics || metrics.width <= 0 || metrics.height <= 0) return;
    const rect = canvas.getBoundingClientRect();
    return { row: Math.floor((position.y - rect.top) / metrics.height), col: Math.floor((position.x - rect.left) / metrics.width) };
  }
  private down = (event: MouseEvent) => {
    if (event.button !== 0 || !this.available() || performance.now() - this.touched < 1000 || !(event.target instanceof HTMLCanvasElement)) return;
    const term = this.terminal(), position = { x: event.clientX, y: event.clientY }, point = this.point(position);
    if (!term || !point || point.row < 0 || point.col < 0 || point.row >= term.rows || point.col >= term.cols) return;
    this.stop(event); term.textarea?.focus({ preventScroll: true }); term.clearSelection();
    const previous = this.lastClick, now = performance.now(); this.clear();
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const double = plain && previous && now - previous.at <= 350 && Math.abs(previous.row - point.row) <= 1 && Math.abs(previous.col - point.col) <= 1;
    const word = double ? terminalWord(terminalRowCells(term, point.row), point.col) : undefined;
    if (double && !word) return;
    if (plain && !double) this.lastClick = { ...point, at: now };
    const text = terminalViewportText(term); if (text === undefined) return;
    const state: Selection = { origin: point, position, cols: term.cols, rows: term.rows, text, pressed: true, finishing: false, visible: !!word, word, copying: false, ready: Promise.resolve() };
    this.state = state;
    state.ready = this.prepare(state).catch(error => this.fail(state, error));
    if (word && this.copyOnSelect()) this.copy(state);
  };
  private async prepare(state: Selection) {
    const context: NativeViewport = await this.request('pane.copy_context');
    if (!this.current(state)) return;
    if (context.viewport_text.trimEnd() !== state.text || !matchesNativeViewport(this.terminal(), context)) throw new Error('Terminal content changed. Select the text again.');
    state.context = context;
    const row = this.top(context) + state.origin.row;
    state.anchor = { row, col: state.word?.start ?? state.origin.col };
    state.cursor = state.word ? { row, col: state.word.end } : { ...state.anchor };
    if (!state.word) this.update(state, true, true);
    this.draw(state);
  }
  private fail(state: Selection, error: unknown) {
    if (this.state !== state) return;
    const visible = state.visible; this.clear();
    if (visible) this.report((error as Error).message || 'Native selection is unavailable.', true);
  }
  private move = (event: MouseEvent) => {
    const state = this.state; if (!state?.pressed || state.word) return;
    this.stop(event); state.position = { x: event.clientX, y: event.clientY };
    const point = this.point(state.position);
    if (point && (point.row !== state.origin.row || point.col !== state.origin.col)) { state.visible = true; this.lastClick = undefined; }
    this.update(state, true, true);
  };
  private up = (event: MouseEvent) => {
    const state = this.state; if (!state?.pressed || event.button !== 0) return;
    this.stop(event); state.pressed = false; state.finishing = !!state.scrolling; state.nextOffset = undefined;
    clearInterval(this.edgeTimer); this.edgeTimer = undefined;
    if (!state.visible) { const click = this.lastClick; this.clear(); this.lastClick = click; return; }
    if (!state.word && this.copyOnSelect()) this.copy(state);
  };
  private key = (event: KeyboardEvent) => {
    const state = this.state;
    if (!state || !this.content.contains(event.target as Node) || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    // The browser command palette operates on the selected context.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') return;
    if (!this.copyOnSelect() && state.visible && event.key.toLowerCase() === 'c' && (event.ctrlKey !== event.metaKey) && !event.shiftKey && !event.altKey) {
      this.stop(event); state.pressed = false; state.finishing = !!state.scrolling; state.nextOffset = undefined; clearInterval(this.edgeTimer); this.edgeTimer = undefined; this.copy(state); return;
    }
    this.clear();
  };
  private copy(state: Selection) {
    if (state.copying) return;
    state.copying = true;
    void writeTerminalClipboard(this.readText(state)).then(() => {
      if (this.state !== state) return;
      this.report('Copied native terminal selection.');
      if (state.word && this.copyOnSelect()) this.highlightTimer = setTimeout(() => { if (this.state === state) this.clear(); }, 500);
      else this.clear();
    }).catch(error => {
      if (this.state !== state) return;
      state.copying = false; this.report(`Copy failed: ${(error as Error).message}`, true);
    });
  }
  private top(context: NativeViewport) { return context.scroll.max_offset_from_bottom - context.scroll.offset_from_bottom; }
  private update(state: Selection, immediate = false, extend = state.pressed || state.finishing) {
    if (!state.context || !this.current(state)) return;
    const point = this.point(state.position); if (!point) return;
    if (extend && !state.word) state.cursor = { row: this.top(state.context) + Math.max(0, Math.min(state.rows - 1, point.row)), col: Math.max(0, Math.min(state.cols - 1, point.col)) };
    this.draw(state);
    const edge = point.row <= 0 ? 1 : point.row >= state.rows - 1 ? -1 : 0;
    if (!state.pressed || state.word || !state.visible || !edge) { clearInterval(this.edgeTimer); this.edgeTimer = undefined; return; }
    const distance = point.row < 0 ? -point.row : point.row >= state.rows ? point.row - state.rows + 1 : 0;
    if (immediate && distance) this.scroll(state, edge * Math.min(15, Math.max(3, distance * 3)));
    if (!this.edgeTimer) this.edgeTimer = setInterval(() => {
      const point = this.point(state.position);
      if (!point || !state.pressed || !this.current(state)) return;
      this.scroll(state, point.row <= 0 ? 1 : point.row >= state.rows - 1 ? -1 : 0);
    }, 30);
  }
  private wheel = (event: WheelEvent) => {
    const state = this.state; if (!state || !event.deltaY || !this.available()) return;
    this.stop(event); state.position = { x: event.clientX, y: event.clientY }; if (state.pressed) state.visible = true; this.lastClick = undefined;
    void state.ready.then(() => { if (this.current(state)) this.scroll(state, -Math.sign(event.deltaY) * this.scrollLines()); });
  };
  private scroll(state: Selection, lines: number) {
    if (!lines || !state.context || !this.current(state)) return;
    state.nextOffset = Math.max(0, Math.min(state.context.scroll.max_offset_from_bottom, (state.nextOffset ?? state.targetOffset ?? state.context.scroll.offset_from_bottom) + lines));
    if (state.scrolling) return;
    state.scrolling = this.drainScroll(state).catch(error => this.fail(state, error)).finally(() => { state.scrolling = undefined; state.finishing = false; });
  }
  private async drainScroll(state: Selection) {
    while (this.current(state) && state.nextOffset !== undefined) {
      const offset = state.nextOffset; state.nextOffset = undefined;
      if (!state.context || offset === state.context.scroll.offset_from_bottom) return;
      state.targetOffset = offset;
      await this.request('pane.scroll', { offset_from_bottom: offset });
      if (!this.current(state)) return;
      const context: NativeViewport = await this.request('pane.copy_context');
      if (!this.current(state)) return;
      if (context.content_revision !== state.context.content_revision || context.scroll.max_offset_from_bottom !== state.context.scroll.max_offset_from_bottom || context.scroll.offset_from_bottom !== offset) throw new Error('Terminal content changed while selecting. Select the text again.');
      const deadline = performance.now() + 1500;
      while (this.current(state) && !matchesNativeViewport(this.terminal(), context) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      if (!this.current(state)) return;
      if (!matchesNativeViewport(this.terminal(), context)) throw new Error('Waiting for the terminal display. Select the text again after it updates.');
      state.context = context; state.targetOffset = undefined; this.update(state);
    }
  }
  private draw(state: Selection) {
    const term = this.terminal();
    if (!this.current(state) || !state.visible || !state.context || !state.anchor || !state.cursor || !term) return;
    const forward = state.anchor.row < state.cursor.row || state.anchor.row === state.cursor.row && state.anchor.col <= state.cursor.col;
    const start = forward ? state.anchor : state.cursor, end = forward ? state.cursor : state.anchor;
    if (paintTerminalSelection(term, this.top(state.context), { start, end })) this.content.dataset.nativeSelection = 'true';
    else delete this.content.dataset.nativeSelection;
  }
}
