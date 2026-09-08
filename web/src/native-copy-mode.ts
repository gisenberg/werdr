import type { Terminal } from 'ghostty-web';
import { matchesNativeViewport, type NativeViewport } from './terminal-viewport';
import { writeTerminalClipboard } from './terminal-clipboard';
import { paintTerminalSelection } from './terminal-selection';

type Point = { row: number; col: number };
type Range = { start: Point; end: Point };
type Context = NativeViewport;
type Direction = 'forward' | 'backward';
type Request = (action: string, params?: object) => Promise<any>;
const ordered = (a: Point, b: Point): Range => a.row < b.row || (a.row === b.row && a.col <= b.col) ? { start: a, end: b } : { start: b, end: a };
const motions: Record<string, string> = { End: 'line_end', '$': 'line_end', '^': 'first_non_blank', w: 'next_word_start', b: 'previous_word_start', e: 'next_word_end', W: 'next_big_word_start', B: 'previous_big_word_start', E: 'next_big_word_end', '{': 'previous_paragraph', '}': 'next_paragraph' };

/** Client-owned selection over native, revision-checked scrollback. */
export class NativeCopyMode {
  readonly layer = document.createElement('div');
  readonly toolbar = document.createElement('div');
  private toolbarScroll = 0;
  private initialSearch?: { query: string; direction: Direction; repeat: boolean; generation: number };
  private readonly marks = document.createElement('div');
  private readonly status: HTMLElement;
  private readonly query: HTMLInputElement;
  private readonly form: HTMLFormElement;
  private readonly notice = document.createElement('div');
  private readonly help = document.createElement('dialog');
  private context?: Context;
  private cursor: Point = { row: 0, col: 0 };
  private anchor?: Point;
  private selectionVisible = false;
  private linewise = false;
  private matches: Range[] = [];
  private current?: number;
  private total = 0;
  private currentGlobal?: number;
  private direction: Direction = 'forward';
  private searchQuery = '';
  private searchGeneration = 0;
  private searchRequested = false;
  private entryOffset?: number;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private restore: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private checking = false;
  private awaitingFrame = false;
  private startSearch = false;
  private drag?: { pointer: number; x: number; y: number };
  private dragTimer?: ReturnType<typeof setInterval>;
  active = false;

  constructor(private host: HTMLElement, private content: HTMLElement, private toolbarHost: HTMLElement, private terminal: () => Terminal | undefined, private request: Request, private focusTerminal: () => void, private report: (message: string, failed?: boolean) => void, private beforeStart: () => void = () => {}) {
    this.layer.className = 'copy-layer'; this.layer.tabIndex = 0; this.layer.setAttribute('role', 'region'); this.layer.setAttribute('aria-label', 'Terminal copy mode');
    this.marks.className = 'copy-marks'; this.layer.append(this.marks);
    this.toolbar.className = 'copy-toolbar'; this.toolbar.setAttribute('role', 'toolbar'); this.toolbar.setAttribute('aria-label', 'Terminal copy controls');
    this.toolbar.innerHTML = '<span class="copy-status" role="status"></span><button type="button" data-copy="find" title="Search native scrollback (/ or ?)">FIND</button><button type="button" data-copy="previous" title="Previous search match (N)">PREV</button><button type="button" data-copy="next" title="Next search match (n)">NEXT</button><button type="button" data-copy="select" title="Select characters (v), or whole lines (Shift+V)">SELECT</button><button type="button" data-copy="copy" title="Copy selection or current match (y or Enter)">COPY</button><button type="button" data-copy="exit" title="Restore the original scroll position (q)">EXIT</button><form class="copy-search" hidden><label>FIND <input type="search" aria-label="Search native scrollback" autocomplete="off" spellcheck="false"></label><button type="submit">FIND</button><button type="button" data-copy="cancel-search">CANCEL</button></form>';
    this.status = this.toolbar.querySelector('.copy-status')!; this.query = this.toolbar.querySelector('input')!; this.form = this.toolbar.querySelector('form')!;
    this.notice.className = 'copy-notice'; this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    const helpButton = document.createElement('button'); helpButton.type = 'button'; helpButton.textContent = 'HELP'; helpButton.onclick = () => this.help.showModal(); this.toolbar.append(helpButton);
    this.help.className = 'copy-help'; this.help.setAttribute('aria-label', 'Copy mode keyboard help');
    this.help.innerHTML = '<h1>COPY MODE</h1><dl><dt>Arrows / h j k l</dt><dd>Move the selection cursor</dd><dt>PageUp / PageDown</dt><dd>Move one page; Ctrl+U / Ctrl+D move half a page</dd><dt>g / G</dt><dd>First / last row of native history</dd><dt>Home / 0 / End / $ / ^</dt><dd>Start / end / first nonblank cell of a line</dd><dt>w / b / e</dt><dd>Next word / previous word / word end; uppercase treats punctuation as part of a word</dd><dt>{ / }</dt><dd>Previous / next paragraph</dd><dt>v / Space / V</dt><dd>Select characters / whole lines; dragging also selects text</dd><dt>/ / ? / n / N</dt><dd>Search forward / backward; next / previous match</dd><dt>y / Enter</dt><dd>Copy the selection or current match, then exit</dd><dt>Escape / q</dt><dd>Clear selection and search / exit and restore the original scroll position</dd></dl><button type="button">DONE</button>';
    this.help.querySelector('button')!.onclick = () => this.help.close(); this.help.addEventListener('close', () => this.focus());
    this.layer.title = 'Arrows / hjkl: move; g/G: history; w/b/e: words; v/V: select; / or ?: search; n/N: repeat; y: copy; q: exit';
    this.toolbar.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-copy]')?.dataset.copy;
      if (action === 'exit') this.exit();
      else if (action === 'copy') this.copy();
      else if (action === 'find') this.openSearch('forward');
      else if (action === 'cancel-search') this.closeSearch();
      else if (action === 'next' || action === 'previous') this.repeat(action === 'previous');
      else if (action === 'select') this.enqueue(async () => { this.anchor = { ...this.cursor }; this.linewise = (event as MouseEvent).shiftKey; this.selectionVisible = this.linewise; this.draw(); this.focus(); });
    });
    this.form.onsubmit = event => { event.preventDefault(); const query = this.query.value; this.closeSearch(); if (query) this.search(query, this.direction, false); };
    this.layer.addEventListener('keydown', event => this.key(event));
    this.query.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); this.closeSearch(); } });
    this.layer.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.context || this.dirty) return;
      event.preventDefault(); this.focus(); this.layer.setPointerCapture(event.pointerId);
      this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      this.enqueue(async () => { this.cursor = this.pointAt(event.clientX, event.clientY); this.anchor = { ...this.cursor }; this.linewise = event.shiftKey; this.selectionVisible = this.linewise; this.draw(); });
      this.dragTimer = setInterval(() => {
        if (!this.drag || !this.context || this.dirty) return;
        const rect = this.layer.getBoundingClientRect();
        if (this.drag.y < rect.top || this.drag.y > rect.bottom) this.move(this.drag.y < rect.top ? -2 : 2, 0);
      }, 100);
    });
    this.layer.addEventListener('pointermove', event => {
      if (this.drag?.pointer !== event.pointerId) return;
      this.drag.x = event.clientX; this.drag.y = event.clientY;
      if (this.dirty) return;
      this.enqueue(async () => { this.cursor = this.pointAt(event.clientX, event.clientY); this.selectionVisible = true; this.draw(); });
    });
    const stopDrag = () => { this.drag = undefined; clearInterval(this.dragTimer); this.dragTimer = undefined; };
    this.layer.addEventListener('pointerup', stopDrag); this.layer.addEventListener('pointercancel', stopDrag); this.layer.addEventListener('lostpointercapture', stopDrag);
    this.layer.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); this.move(Math.sign(event.deltaY) * Math.min(50, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 30))), 0); }, { passive: false });
    this.hide();
  }
  focus() { if (this.active) (this.form.hidden ? this.layer : this.query).focus({ preventScroll: true }); }
  private hide() {
    this.terminal()?.clearSelection(); delete this.layer.dataset.selection;
    const ownsToolbar = this.toolbar.parentElement === this.toolbarHost;
    this.help.close(); this.help.remove(); this.toolbar.remove();
    if (ownsToolbar && !this.toolbarHost.querySelector('.copy-toolbar')) {
      this.toolbarHost.classList.remove('copy-controls-open'); this.toolbarHost.scrollLeft = this.toolbarScroll;
    }
    this.layer.remove(); this.notice.remove(); this.host.classList.remove('copy-active');
  }
  async start(search = false) {
    if (this.active) { if (search) { if (this.context) this.openSearch('forward'); else this.startSearch = true; } else this.focus(); return; }
    await this.restore;
    if (this.active) { this.focus(); return; }
    if (!this.terminal() || !this.host.isConnected) return;
    this.beforeStart();
    this.active = true; const generation = ++this.generation;
    this.context = undefined; this.entryOffset = undefined; this.dirty = false; this.awaitingFrame = false; this.startSearch = search; this.clearSelection(); this.form.hidden = true; this.notice.hidden = true;
    this.host.classList.add('copy-active'); this.content.append(this.layer); this.host.append(this.notice, this.help); this.toolbarScroll = this.toolbarHost.scrollLeft; this.toolbarHost.scrollLeft = 0; this.toolbarHost.append(this.toolbar); this.toolbarHost.classList.add('copy-controls-open'); this.status.textContent = 'COPY...'; this.focus();
    this.enqueue(async () => {
      const context: Context = await this.request('pane.copy_context');
      if (generation !== this.generation) return;
      if (!matchesNativeViewport(this.terminal(), context)) { this.waitForFrame(); return; }
      this.context = context; this.entryOffset = context.scroll.offset_from_bottom;
      const term = this.terminal()!;
      this.cursor = { row: this.top + Math.min(context.scroll.viewport_rows - 1, term.buffer.active.cursorY), col: Math.min(term.cols - 1, term.buffer.active.cursorX) };
      this.draw(); this.resumeInitialSearch();
    });
  }
  exit(restore = true, focus = true) {
    if (!this.active) return;
    const offset = this.entryOffset;
    this.active = false; ++this.generation; clearTimeout(this.timer); this.timer = undefined; clearInterval(this.dragTimer); this.drag = undefined;
    this.hide(); this.context = undefined; this.clearSelection();
    // Drain an already-dispatched scroll before restoring, and skip queued input.
    this.restore = this.tail.then(async () => { if (restore && offset !== undefined) await this.request('pane.scroll', { offset_from_bottom: offset }); }).catch(error => { if (focus) this.report(`Could not restore terminal scroll position: ${(error as Error).message}`, true); });
    if (focus) this.focusTerminal();
  }
  private enqueue(operation: () => Promise<void>) {
    if (this.pending >= 128) { this.message('Waiting for native copy operations. Try again after they finish.'); return Promise.resolve(); }
    const generation = this.generation;
    this.pending++;
    const result = this.tail.then(async () => { if (this.active && generation === this.generation) await operation(); }).finally(() => { this.pending--; });
    this.tail = result.catch(error => { if (this.active && generation === this.generation) {
      if (this.context) this.clearSelection();
      this.message((error as Error).message); this.draw();
      if (/content changed|stale_content|content is changing|viewport changed/i.test((error as Error).message)) this.afterFrame();
    } });
    return result;
  }
  private message(text: string) { this.notice.textContent = text; this.notice.hidden = !text; }
  private get top() { return this.context ? this.context.scroll.max_offset_from_bottom - this.context.scroll.offset_from_bottom : 0; }
  private clearSelection() {
    this.initialSearch = undefined; ++this.searchGeneration; this.searchRequested = false; this.anchor = undefined; this.selectionVisible = false; this.matches = []; this.current = undefined; this.total = 0; this.currentGlobal = undefined; this.searchQuery = ''; this.clearPaint(); }
  afterFrame() {
    if (!this.active) return;
    this.awaitingFrame = false;
    this.dirty = true; this.clearPaint();
    if (this.timer || this.checking) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.checkFrame(); }, 150);
  }
  private checkFrame() {
    if (!this.active || !this.dirty || this.checking) return;
    this.dirty = false; this.checking = true; const generation = this.generation;
    void this.enqueue(async () => {
      const context: Context = await this.request('pane.copy_context');
      if (generation !== this.generation) return;
      if (!matchesNativeViewport(this.terminal(), context)) { this.waitForFrame(); return; }
      if (this.notice.textContent === 'Waiting for a matching native terminal frame.') this.message('');
      if (!this.context) {
        this.message('');
        this.entryOffset = context.scroll.offset_from_bottom;
        this.cursor = { row: context.scroll.max_offset_from_bottom - context.scroll.offset_from_bottom + Math.min(context.scroll.viewport_rows - 1, this.terminal()?.buffer.active.cursorY || 0), col: this.terminal()?.buffer.active.cursorX || 0 };
      }
      if (this.context && (context.content_revision !== this.context.content_revision || context.scroll.viewport_rows !== this.context.scroll.viewport_rows)) { this.clearSelection(); this.message('Content changed. Selection and search cleared.'); }
      this.context = context; this.clamp(); if (!this.dirty) this.draw();
      this.resumeInitialSearch();
    }).catch(() => {}).finally(() => { this.checking = false; if (this.active && this.dirty && !this.awaitingFrame) this.afterFrame(); });
  }
  private waitForFrame() { this.dirty = true; this.awaitingFrame = true; this.clearPaint(); this.status.textContent = 'COPY WAIT'; this.message('Waiting for a matching native terminal frame.'); }
  private clamp() {
    if (!this.context) return;
    this.cursor.row = Math.max(0, Math.min(this.cursor.row, this.context.scroll.max_offset_from_bottom + this.context.scroll.viewport_rows - 1));
    this.cursor.col = Math.max(0, Math.min(this.cursor.col, (this.terminal()?.cols || 1) - 1));
  }
  private async reveal() {
    if (!this.context) return;
    if (this.anchor) this.selectionVisible = true;
    this.clamp();
    const { viewport_rows, max_offset_from_bottom } = this.context.scroll;
    const top = this.cursor.row < this.top ? this.cursor.row : this.cursor.row >= this.top + viewport_rows ? this.cursor.row - viewport_rows + 1 : this.top;
    const offset = Math.max(0, Math.min(max_offset_from_bottom, max_offset_from_bottom - top));
    await this.setOffset(offset);
    this.draw();
  }
  private async setOffset(offset: number) {
    if (!this.context) return;
    if (offset !== this.context.scroll.offset_from_bottom) {
      const generation = this.generation;
      this.dirty = true; this.clearPaint();
      try { await this.request('pane.scroll', { offset_from_bottom: offset }); }
      finally { if (generation === this.generation) this.afterFrame(); }
      if (generation !== this.generation || !this.context) return;
      this.context.scroll.offset_from_bottom = offset;
    }
  }
  private page(direction: number, half: boolean) { void this.enqueue(async () => {
    if (!this.context) return;
    const height = this.context.scroll.viewport_rows;
    const lines = height <= 2 ? 1 : half ? Math.floor(height / 2) : height - 2;
    this.cursor.row += direction * lines; this.clamp(); if (this.anchor) this.selectionVisible = true;
    await this.setOffset(Math.max(0, Math.min(this.context.scroll.max_offset_from_bottom, this.context.scroll.offset_from_bottom - direction * lines))); this.draw();
  }).catch(() => {}); }
  private move(rows: number, cols: number) { void this.enqueue(async () => { this.cursor = { row: this.cursor.row + rows, col: this.cursor.col + cols }; await this.reveal(); }).catch(() => {}); }
  private openSearch(direction: Direction) { this.direction = direction; this.form.hidden = false; this.query.value = this.searchQuery; this.query.focus({ preventScroll: true }); this.query.select(); }
  private closeSearch() { this.form.hidden = true; this.focus(); }
  private repeat(reverse: boolean) { if (this.searchQuery) this.search(this.searchQuery, reverse ? (this.direction === 'forward' ? 'backward' : 'forward') : this.direction, true); }
  private resumeInitialSearch() {
    const pending = this.initialSearch; this.initialSearch = undefined;
    if (pending && pending.generation === this.searchGeneration) {
      this.startSearch = false; this.search(pending.query, pending.direction, pending.repeat);
    } else if (this.startSearch) { this.startSearch = false; this.openSearch('forward'); }
  }
  private search(query: string, direction: Direction, repeat: boolean) {
    const searchGeneration = this.searchGeneration; this.searchRequested = true;
    void this.enqueue(async () => {
      if (searchGeneration !== this.searchGeneration) return;
      if (!this.context) { this.initialSearch = { query, direction, repeat, generation: searchGeneration }; this.afterFrame(); return; }
      const generation = this.generation;
      const current = this.current === undefined ? undefined : this.matches[this.current];
      const previous = repeat && current?.start.row === this.cursor.row && current.start.col === this.cursor.col ? current : undefined;
      const result = await this.request('pane.copy_search', { query, direction, cursor: this.cursor, content_revision: this.context.content_revision, ...(previous ? { previous } : {}) });
      if (generation !== this.generation || searchGeneration !== this.searchGeneration) return;
      this.searchRequested = false;
      this.searchQuery = query; this.matches = result.matches; this.current = result.current; this.total = result.total; this.currentGlobal = result.current_global;
      if (!repeat) this.direction = direction;
      const match = this.current === undefined ? undefined : this.matches[this.current];
      if (match) this.cursor = { ...match.start };
      this.message(match ? '' : 'No matches in native scrollback.'); await this.reveal(); this.focus();
    }).catch(() => {});
  }
  private selection(): Range | undefined {
    if (!this.anchor || !this.selectionVisible) return this.current === undefined ? undefined : this.matches[this.current];
    const range = ordered(this.anchor, this.cursor);
    return this.linewise ? { start: { row: range.start.row, col: 0 }, end: { row: range.end.row, col: (this.terminal()?.cols || 1) - 1 } } : range;
  }
  readText(): Promise<string> {
    const generation = this.generation;
    return this.tail.then(async () => {
      const range = this.selection();
      if (!this.active || generation !== this.generation) throw new Error('Copy mode closed before the selection was read.');
      if (!this.context || !range) return '';
      const result = await this.request('pane.selection.read', { anchor: range.start, cursor: range.end, content_revision: this.context.content_revision });
      if (!this.active || generation !== this.generation) throw new Error('Copy mode closed before the selection was read.');
      if (this.dirty || !this.context || !matchesNativeViewport(this.terminal(), this.context) || JSON.stringify(this.selection()) !== JSON.stringify(range)) throw new Error('Terminal selection changed before it could be read.');
      if (typeof result.text !== 'string') throw new Error('Native selection text is unavailable.');
      return result.text;
    });
  }
  private copy() {
    if (!this.pending && !this.selection()) { this.exit(); return; }
    const generation = this.generation;
    const write = writeTerminalClipboard(this.readText());
    void write.then(() => { if (generation === this.generation) { this.exit(); this.report('Copied native terminal selection.'); } }).catch(error => { if (generation === this.generation) this.message(`Copy failed: ${(error as Error).message}`); });
  }
  private key(event: KeyboardEvent) {
    if (!this.active) return;
    if (event.key.toLowerCase() === 'c' && (event.ctrlKey !== event.metaKey) && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopImmediatePropagation(); this.copy(); return; }
    if (event.key === 'Tab' || event.metaKey || (event.ctrlKey && !['b', 'f', 'u', 'd'].includes(event.key.toLowerCase()))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'q') return this.exit();
    if (event.key === 'y' || event.key === 'Enter') return this.copy();
    if (event.key === '/' || event.key === '?') return this.openSearch(event.key === '/' ? 'forward' : 'backward');
    if (event.key === 'n' || event.key === 'N') return this.repeat(event.key === 'N');
    if (event.key === 'Escape') { if (this.anchor || this.searchQuery || this.searchRequested) { this.clearSelection(); this.message(''); this.draw(); } else this.exit(); return; }
    if (event.key === 'v' || event.key === 'V' || event.key === ' ') { void this.enqueue(async () => { this.anchor = { ...this.cursor }; this.linewise = event.key === 'V'; this.selectionVisible = this.linewise; this.draw(); }).catch(() => {}); return; }
    const page = event.ctrlKey ? ({ b: -1, f: 1, u: -.5, d: .5 } as Record<string, number>)[event.key.toLowerCase()] : event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : undefined;
    if (page !== undefined) return this.page(Math.sign(page), Math.abs(page) < 1);
    const step = ({ ArrowLeft: [0, -1], h: [0, -1], ArrowRight: [0, 1], l: [0, 1], ArrowUp: [-1, 0], k: [-1, 0], ArrowDown: [1, 0], j: [1, 0] } as Record<string, number[]>)[event.key];
    if (step) return this.move(step[0], step[1]);
    void this.enqueue(async () => {
      if (!this.context) return;
      const generation = this.generation;
      if (event.key === 'g') this.cursor.row = 0;
      else if (event.key === 'G') this.cursor.row = this.context.scroll.max_offset_from_bottom + this.context.scroll.viewport_rows - 1;
      else if (event.key === 'Home' || event.key === '0') this.cursor.col = 0;
      else if (motions[event.key]) {
        const result = await this.request('pane.copy_motion', { cursor: this.cursor, motion: motions[event.key], content_revision: this.context.content_revision });
        if (generation !== this.generation) return;
        this.cursor = result.cursor;
      } else return;
      await this.reveal();
    }).catch(() => {});
  }
  private pointAt(x: number, y: number): Point {
    const rect = this.content.querySelector('canvas')?.getBoundingClientRect() || this.layer.getBoundingClientRect();
    const metrics = this.terminal()?.renderer?.getMetrics() || { width: 8, height: 16 };
    return { row: this.top + Math.max(0, Math.min((this.context?.scroll.viewport_rows || 1) - 1, Math.floor((y - rect.top) / metrics.height))), col: Math.max(0, Math.min((this.terminal()?.cols || 1) - 1, Math.floor((x - rect.left) / metrics.width))) };
  }
  private clearPaint() { this.marks.replaceChildren(); this.terminal()?.clearSelection(); delete this.layer.dataset.selection; this.layer.removeAttribute('aria-description'); }
  private draw() {
    if (!this.active || !this.context) return;
    const term = this.terminal(), metrics = term?.renderer?.getMetrics();
    this.status.textContent = `COPY ${this.cursor.row + 1}:${this.cursor.col + 1}${this.searchQuery ? ` ${this.currentGlobal === undefined ? 0 : this.currentGlobal + 1}/${this.total}` : ''}`;
    this.status.title = this.status.textContent; this.layer.dataset.row = String(this.cursor.row); this.layer.dataset.col = String(this.cursor.col);
    this.clearPaint(); if (!term || !metrics || this.dirty) return;
    const canvas = this.content.querySelector('canvas')?.getBoundingClientRect(), bounds = this.layer.getBoundingClientRect();
    const left = (canvas?.left || bounds.left) - bounds.left, top = (canvas?.top || bounds.top) - bounds.top;
    const mark = (row: number, col: number, width: number, className: string) => {
      if (row < this.top || row >= this.top + this.context!.scroll.viewport_rows || width <= 0) return;
      const node = document.createElement('span'); node.className = className;
      Object.assign(node.style, { left: `${left + col * metrics.width}px`, top: `${top + (row - this.top) * metrics.height}px`, width: `${width * metrics.width}px`, height: `${metrics.height}px` }); this.marks.append(node);
    };
    const range = (value: Range, className: string) => {
      for (let row = Math.max(this.top, value.start.row); row <= Math.min(this.top + this.context!.scroll.viewport_rows - 1, value.end.row); row++) {
        const col = row === value.start.row ? value.start.col : 0, end = row === value.end.row ? value.end.col : term.cols - 1;
        mark(row, col, Math.min(term.cols, end + 1) - col, className);
      }
    };
    for (let index = 0; index < this.matches.length; index++) range(this.matches[index], index === this.current ? 'copy-match copy-current' : 'copy-match');
    if (this.anchor && this.selectionVisible && paintTerminalSelection(term, this.top, this.selection())) {
      const selection = this.selection()!; this.layer.dataset.selection = 'true';
      this.layer.setAttribute('aria-description', `Selected rows ${selection.start.row + 1} through ${selection.end.row + 1}`);
    }
    mark(this.cursor.row, this.cursor.col, 1, 'copy-caret');
  }
}
