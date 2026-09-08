import { paneChrome, paneBorderLabel } from '../shared/pane-chrome';
import type { Pane, Snapshot } from '../shared/fleet';
import { geometry, type Layout, type LayoutNode, type Rect, type Divider } from '../shared/layout';
import { palette, type Preferences } from '../shared/settings';
import { ClipboardFeedback } from './clipboard-feedback';
import { TerminalController } from './terminal-controller';
type Api = (path: string, data?: object) => Promise<any>;
export class DesktopSurface {
  private clipboardFeedback: ClipboardFeedback;
  private overflow = new Map<string, HTMLButtonElement>();
  private controllers = new Map<string, TerminalController>();
  private machine = '';
  private tab = '';
  private pane = '';
  private panes: Pane[] = [];
  private layout?: Layout;
  private fingerprint = '';
  private epoch = 0;
  private loading = false;
  private pendingSelection = false;
  private focusTarget?: string;
  private dirty = false;
  private preferences: Preferences;
  private colors: ReturnType<typeof palette>;
  private separators = document.createElement('div');
  private retry?: ReturnType<typeof setTimeout>;
  private drag?: { path: boolean[]; original: number; node: Extract<LayoutNode, { type: 'split' }> };
  constructor(private container: HTMLElement, private shield: HTMLElement, private toolbarHost: HTMLElement, private api: Api, preferences: Preferences, colors: ReturnType<typeof palette>, private select: (id: string) => void, private error: (message: string) => void, private notice: (message: string) => void) {
    this.preferences = preferences; this.colors = colors; this.clipboardFeedback = new ClipboardFeedback(container, () => this.preferences); this.separators.className = 'pane-separators'; container.append(this.separators);
    document.addEventListener('focusin', event => {
      if (event.target instanceof Node && !container.contains(event.target)) this.focusTarget = undefined;
    });
    new ResizeObserver(() => this.render()).observe(container);
    matchMedia('(max-width: 700px)').addEventListener('change', () => this.render());
  }
  get active() { return this.controllers.get(this.pane); }
  requestFocus(pane: string) { this.focusTarget = pane || undefined; this.readiness(); }
  waitForSelection() { this.pendingSelection = true; this.container.inert = true; this.shield.hidden = false; this.shield.textContent = 'Waiting for native workspace update...'; }
  clear() {
    this.clipboardFeedback.clear();
    this.pendingSelection = false; this.focusTarget = undefined; this.container.inert = false;
    ++this.epoch; this.loading = false; this.dirty = false; clearTimeout(this.retry); this.drag = undefined;
    for (const controller of this.controllers.values()) controller.dispose(); this.controllers.clear();
    for (const node of this.overflow.values()) node.remove(); this.overflow.clear();
    this.layout = undefined; this.fingerprint = ''; this.machine = ''; this.tab = ''; this.pane = ''; this.panes = []; this.separators.replaceChildren(); this.shield.hidden = false; this.shield.textContent = 'Attaching to Herdr...';
  }
  updatePreferences(preferences: Preferences, colors: ReturnType<typeof palette>) { this.preferences = preferences; this.colors = colors; this.clipboardFeedback.update(); for (const controller of this.controllers.values()) controller.update(preferences, colors); this.render(); }
  sync(machine: string, tab: string, pane: string, snapshot: Snapshot, online: boolean) {
    const selectionChanged = machine !== this.machine || tab !== this.tab || pane !== this.pane;
    this.pendingSelection = false; this.container.inert = false;
    if (machine !== this.machine || tab !== this.tab) { const focusTarget = this.focusTarget; this.clear(); if (focusTarget === pane) this.focusTarget = focusTarget; this.machine = machine; this.tab = tab; }
    const editingChrome = document.activeElement instanceof Element && !this.container.contains(document.activeElement) && !!document.activeElement.closest('input, textarea, select, [contenteditable=true]');
    if (selectionChanged && (!editingChrome || this.focusTarget === pane)) this.focusTarget = pane || undefined;
    else if (this.focusTarget !== pane) this.focusTarget = undefined;
    this.pane = pane; this.panes = snapshot.panes.filter(item => item.tab_id === tab);
    for (const [id, controller] of this.controllers) if (!this.panes.some(item => item.pane_id === id && item.terminal_id === controller.terminalId)) { controller.dispose(); this.controllers.delete(id); }
    this.render();
    const fingerprint = JSON.stringify([this.panes.map(item => [item.pane_id, item.terminal_id]), snapshot.layouts]);
    if (online && tab && (fingerprint !== this.fingerprint || !this.layout)) { this.fingerprint = fingerprint; void this.load(); }
  }
  recover() { for (const controller of this.controllers.values()) controller.recover(); this.refresh(); }
  refresh() { this.fingerprint = ''; if (this.tab) void this.load(); }
  private async load() {
    if (this.loading || this.drag) { this.dirty = true; return; }
    this.loading = true; const epoch = this.epoch; clearTimeout(this.retry);
    try {
      const layout: Layout = await this.api('/api/layout?' + new URLSearchParams({ machine: this.machine, tab: this.tab }));
      if (epoch !== this.epoch) return;
      if (layout.tab_id !== this.tab) throw new Error('Native layout does not match the selected tab.');
      if (this.drag) { this.dirty = true; return; }
      this.layout = layout; this.render();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error(`Layout: ${(error as Error).message}`);
      if (!this.layout) { this.shield.hidden = false; this.shield.textContent = `Layout unavailable: ${(error as Error).message}`; }
      this.retry = setTimeout(() => { if (epoch === this.epoch) void this.load(); }, 5000);
    } finally {
      if (epoch === this.epoch) { this.loading = false; if (this.dirty && !this.drag) { this.dirty = false; void this.load(); } }
    }
  }
  private readiness = () => {
    if (!this.pendingSelection && this.active && !this.active.ready) this.shield.textContent = this.active.status;
    this.shield.hidden = !this.pendingSelection && (!!this.active?.ready || this.overflow.has(this.pane)) && !document.querySelector<HTMLDialogElement>('#boot')?.open;
    if (!this.pendingSelection && this.active?.ready && this.focusTarget === this.pane) {
      if (document.querySelector<HTMLDialogElement>('#boot')?.open) return;
      this.focusTarget = undefined;
      if (!document.querySelector('dialog[open], .context-menu:not([hidden])')) this.active.focus();
    }
  };
  private render() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!this.layout || !width || !height) return;
    const mobile = matchMedia('(max-width: 700px)').matches;
    const selected = this.panes.find(item => item.pane_id === this.pane);
    const root: LayoutNode = (mobile || this.layout.zoomed) && selected ? { type: 'pane', pane_id: selected.pane_id } : this.layout.root;
    const { panes, dividers } = geometry(root, width, height, this.preferences.paneGaps ? 5 : 0);
    // Controller capacity matches the surface attachment limit. Hidden panes keep
    // their live geometry; a phone never resizes a background pane to zero.
    const visible = [...panes.keys()];
    for (const [id, controller] of this.controllers) { controller.activate(id === this.pane); controller.show(visible.includes(id)); }
    for (const [id, node] of this.overflow) { if (!visible.includes(id)) { node.remove(); this.overflow.delete(id); } }
    for (const [id, rect] of panes) {
      const pane = this.panes.find(item => item.pane_id === id); if (!pane) continue;
      let controller = this.controllers.get(id);
      if (!controller && this.controllers.size >= 16) {
        const hidden = [...this.controllers].find(([id]) => !visible.includes(id));
        if (hidden) { hidden[1].dispose(); this.controllers.delete(hidden[0]); }
      }
      if (!controller && this.controllers.size < 16) {
        controller = new TerminalController(this.machine, id, pane.terminal_id, this.toolbarHost, this.preferences, this.colors, () => this.select(id), this.readiness, this.api, (message, failed) => failed ? this.error(message) : this.notice(message), () => this.clipboardFeedback.show());
        this.controllers.set(id, controller); this.container.append(controller.element);
      }
      if (!controller) {
        let node = this.overflow.get(id);
        if (!node) { node = document.createElement('button'); node.className = 'pane-capacity'; node.textContent = `${pane.label || id}: terminal capacity reached. Select this pane and use Zoom to attach it.`; node.onclick = () => this.select(id); this.overflow.set(id, node); this.container.append(node); }
        position(node, rect); continue;
      }
      this.overflow.get(id)?.remove(); this.overflow.delete(id);
      position(controller.element, rect);
      controller.chrome(paneChrome(rect, width, height, this.panes.length > 1 && !mobile, this.preferences), paneBorderLabel(pane, this.preferences), `${pane.label || pane.title || id} [${pane.agent_status.toUpperCase()}]`, id === this.pane);
      controller.show(true);
    }
    if (!this.drag) this.renderSeparators(dividers);
    this.readiness();
  }
  private renderSeparators(dividers: Divider[]) {
    const existing = new Map([...this.separators.children].map(node => [(node as HTMLElement).dataset.path, node as HTMLElement]));
    for (const divider of dividers) {
      const key = JSON.stringify(divider.path); const node = existing.get(key) || document.createElement('div'); existing.delete(key);
      node.className = `pane-divider ${divider.direction}`; node.dataset.path = key; node.tabIndex = 0;
      node.setAttribute('role', 'separator'); node.setAttribute('aria-label', 'Resize split'); node.setAttribute('aria-orientation', divider.direction === 'right' ? 'vertical' : 'horizontal');
      node.setAttribute('aria-valuemin', '5'); node.setAttribute('aria-valuemax', '95'); node.setAttribute('aria-valuenow', String(Math.round(divider.ratio * 100))); position(node, dividerHitRect(divider));
      node.onkeydown = event => {
        const negative = divider.direction === 'right' ? 'ArrowLeft' : 'ArrowUp', positive = divider.direction === 'right' ? 'ArrowRight' : 'ArrowDown';
        if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const ratio = event.key === 'Home' ? .05 : event.key === 'End' ? .95 : divider.ratio + (event.key === negative ? -.05 : .05);
        void this.commit(divider.path, Math.max(.05, Math.min(.95, ratio)));
      };
      node.onpointerdown = event => this.startDrag(event, node, divider);
      if (!node.parentNode) this.separators.append(node);
    }
    for (const node of existing.values()) node.remove();
  }
  private startDrag(event: PointerEvent, element: HTMLElement, divider: Divider) {
    if (event.button !== 0 || !this.layout) return;
    let node = this.layout.root;
    for (const second of divider.path) { if (node.type !== 'split') return; node = second ? node.second : node.first; }
    if (node.type !== 'split') return;
    event.preventDefault(); element.setPointerCapture(event.pointerId);
    this.drag = { path: divider.path, original: node.ratio, node }; const drag = this.drag;
    const bounds = this.container.getBoundingClientRect();
    const gap = this.preferences.paneGaps ? 5 : 0;
    const offset = divider.direction === 'right' ? event.clientX - bounds.left - divider.rect.x : event.clientY - bounds.top - divider.rect.y;
    const move = (event: PointerEvent) => {
      if (this.drag !== drag) return;
      const horizontal = divider.direction === 'right'; const point = horizontal ? event.clientX - bounds.left - divider.area.x : event.clientY - bounds.top - divider.area.y;
      const size = horizontal ? divider.area.width : divider.area.height;
      drag.node.ratio = Math.max(.05, Math.min(.95, (point - offset) / Math.max(1, size - gap))); this.render();
      const current = geometry(this.layout!.root, this.container.clientWidth, this.container.clientHeight, gap).dividers.find(item => JSON.stringify(item.path) === JSON.stringify(divider.path));
      if (current) position(element, dividerHitRect(current));
    };
    const end = (event: PointerEvent) => {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end); element.removeEventListener('lostpointercapture', end);
      if (this.drag !== drag) return;
      this.drag = undefined;
      if (event.type === 'pointerup') void this.commit(drag.path, drag.node.ratio);
      else { drag.node.ratio = drag.original; this.render(); }
    };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end); element.addEventListener('lostpointercapture', end);
  }
  private async commit(path: boolean[], ratio: number) {
    const epoch = this.epoch;
    try { await this.api('/api/action', { machine: this.machine, action: 'layout.set_split_ratio', id: this.tab, path, ratio }); }
    catch (error) { this.error((error as Error).message); }
    finally { if (epoch === this.epoch) this.refresh(); }
  }
}
function position(element: HTMLElement, rect: Rect) { Object.assign(element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }); }

function dividerHitRect(divider: Divider): Rect {
  // Shared borders still need a usable pointer target without consuming pane space.
  const rect = { ...divider.rect };
  if (divider.direction === 'right' && rect.width < 5) { rect.x -= (5 - rect.width) / 2; rect.width = 5; }
  if (divider.direction === 'down' && rect.height < 5) { rect.y -= (5 - rect.height) / 2; rect.height = 5; }
  return rect;
}
