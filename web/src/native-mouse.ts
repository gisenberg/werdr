import type { Terminal } from 'ghostty-web';

/** The native attach client accepts SGR cell reports and applies the application's modes. */
export class NativeMouse {
  private enabled = false;
  private buttons = new Set<number>();
  private last?: { column: number; row: number; modifiers: number };
  private motion = '';
  constructor(private content: HTMLElement, private terminal: () => Terminal | undefined, private available: () => boolean, private send: (text: string) => void) {
    content.addEventListener('mousedown', this.down, true);
    content.addEventListener('contextmenu', this.context, true);
    document.addEventListener('mousemove', this.move, true);
    document.addEventListener('mouseup', this.up, true);
    window.addEventListener('blur', this.blur);
  }
  setEnabled(enabled: boolean) { if (this.enabled !== enabled) { this.release(); this.enabled = enabled; } }
  release() {
    if (this.last) for (const button of this.buttons) this.report(button, this.last, false);
    this.buttons.clear(); this.last = undefined; this.motion = '';
  }
  dispose() {
    this.release();
    this.content.removeEventListener('mousedown', this.down, true);
    this.content.removeEventListener('contextmenu', this.context, true);
    document.removeEventListener('mousemove', this.move, true);
    document.removeEventListener('mouseup', this.up, true);
    window.removeEventListener('blur', this.blur);
  }
  point(event: { clientX: number; clientY: number; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean }) {
    const term = this.terminal(), canvas = this.content.querySelector('canvas'), metrics = term?.renderer?.getMetrics();
    if (!term || !canvas || !metrics || metrics.width <= 0 || metrics.height <= 0) return;
    const rect = canvas.getBoundingClientRect();
    return { column: Math.max(0, Math.min(term.cols - 1, Math.floor((event.clientX - rect.left) / metrics.width))), row: Math.max(0, Math.min(term.rows - 1, Math.floor((event.clientY - rect.top) / metrics.height))), modifiers: (event.shiftKey ? 4 : 0) | (event.altKey ? 8 : 0) | (event.ctrlKey ? 16 : 0) };
  }
  private stop(event: MouseEvent) { event.preventDefault(); event.stopImmediatePropagation(); }
  private report(button: number, point: { column: number; row: number; modifiers: number }, press = true) { this.send(`\x1b[<${button | point.modifiers};${point.column + 1};${point.row + 1}${press ? 'M' : 'm'}`); }
  private blur = () => this.release();
  private context = (event: MouseEvent) => { if (this.enabled && this.available()) this.stop(event); };
  private down = (event: MouseEvent) => {
    if (!this.enabled || !this.available() || event.button > 2) return;
    const point = this.point(event); if (!point) return;
    this.stop(event); this.terminal()?.textarea?.focus({ preventScroll: true });
    this.buttons.add(event.button); this.last = point; this.motion = ''; this.report(event.button, point);
  };
  private move = (event: MouseEvent) => {
    if (!this.enabled || !this.available()) { this.release(); return; }
    if (!this.buttons.size && !this.content.contains(event.target as Node)) return;
    const point = this.point(event); if (!point) return;
    this.stop(event);
    const button = this.buttons.values().next().value ?? 3;
    const key = `${button}:${point.column}:${point.row}:${point.modifiers}`;
    this.last = point;
    if (this.motion !== key) { this.motion = key; this.report(32 + button, point); }
  };
  private up = (event: MouseEvent) => {
    if (!this.buttons.has(event.button)) return;
    this.stop(event); const point = this.point(event) ?? this.last;
    if (point) this.report(event.button, point, false);
    this.buttons.delete(event.button); this.last = point; this.motion = '';
  };
}
