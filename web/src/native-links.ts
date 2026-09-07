import type { Terminal } from 'ghostty-web';
import { matchesNativeViewport, type NativeViewport } from './terminal-viewport';

type Gesture = { down: MouseEvent; move?: MouseEvent; up?: MouseEvent; target: Element; row: number; col: number; cols: number; rows: number; timer: ReturnType<typeof setTimeout> };

/** Native plugins own link dispatch. Ghostty's automatic URL opener is bypassed. */
export class NativeLinks {
  private gesture?: Gesture;
  private replaying = false;
  private readonly notice = document.createElement('div');
  constructor(private content: HTMLElement, private terminal: () => Terminal | undefined, private available: () => boolean, private request: (action: string, params?: object) => Promise<any>, private report: (message: string, failed?: boolean) => void) {
    this.notice.className = 'terminal-link-notice'; this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    content.parentElement!.append(this.notice);
    content.addEventListener('mousedown', this.down, true);
    content.addEventListener('click', this.click, true);
    document.addEventListener('mousemove', this.move, true);
    document.addEventListener('mouseup', this.up, true);
    document.addEventListener('pointerdown', this.outside, true); document.addEventListener('keydown', this.key, true); window.addEventListener('blur', this.blur);
  }
  invalidate() { if (this.gesture) clearTimeout(this.gesture.timer); this.gesture = undefined; }
  cancel() { this.invalidate(); this.notice.hidden = true; this.notice.replaceChildren(); }
  dispose() {
    this.cancel(); this.notice.remove();
    this.content.removeEventListener('mousedown', this.down, true); this.content.removeEventListener('click', this.click, true);
    document.removeEventListener('mousemove', this.move, true); document.removeEventListener('mouseup', this.up, true);
    document.removeEventListener('pointerdown', this.outside, true); document.removeEventListener('keydown', this.key, true); window.removeEventListener('blur', this.blur);
  }
  private outside = (event: PointerEvent) => { if (!this.content.contains(event.target as Node)) this.invalidate(); };
  private key = (event: KeyboardEvent) => { if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) this.invalidate(); };
  private blur = () => this.invalidate();
  private stop(event: MouseEvent) { event.preventDefault(); event.stopImmediatePropagation(); }
  private click = (event: MouseEvent) => { if (event.ctrlKey || event.metaKey) this.stop(event); };
  private down = (event: MouseEvent) => {
    if (this.replaying) return;
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) { this.cancel(); return; }
    this.stop(event); this.cancel();
    const term = this.terminal(), canvas = this.content.querySelector('canvas'), metrics = term?.renderer?.getMetrics();
    if (!this.available() || !term || !canvas || !metrics || !(event.target instanceof Element)) return;
    const rect = canvas.getBoundingClientRect(), row = Math.floor((event.clientY - rect.top) / metrics.height), col = Math.floor((event.clientX - rect.left) / metrics.width);
    if (row < 0 || col < 0 || row >= term.rows || col >= term.cols) return;
    const gesture: Gesture = { down: event, target: event.target, row, col, rows: term.rows, cols: term.cols, timer: setTimeout(() => {
      if (this.gesture === gesture) { this.cancel(); this.report('Link response timed out.', true); }
    }, 5000) };
    this.gesture = gesture; term.textarea?.focus({ preventScroll: true }); void this.activate(gesture);
  };
  private move = (event: MouseEvent) => { if (!this.replaying && this.gesture) { this.stop(event); this.gesture.move = event; } };
  private up = (event: MouseEvent) => { if (!this.replaying && this.gesture && event.button === 0) { this.stop(event); this.gesture.up = event; } };
  private current(gesture: Gesture) { return this.gesture === gesture && this.available() && this.terminal()?.cols === gesture.cols && this.terminal()?.rows === gesture.rows; }
  private replay(gesture: Gesture) {
    clearTimeout(gesture.timer); this.gesture = undefined; this.replaying = true;
    try {
      for (const event of [gesture.down, gesture.move, gesture.up]) {
        if (!event) continue;
        gesture.target.dispatchEvent(new MouseEvent(event.type, { bubbles: true, cancelable: true, view: window, button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, detail: event.detail }));
      }
    } finally { this.replaying = false; }
  }
  private async activate(gesture: Gesture) {
    try {
      const context: NativeViewport = await this.request('pane.copy_context');
      if (!this.current(gesture)) return;
      if (!matchesNativeViewport(this.terminal(), context)) throw new Error('Terminal content changed. Click the link again after the display updates.');
      const result = await this.request('pane.link.activate', { viewport_row: gesture.row, col: gesture.col, content_revision: context.content_revision, offset_from_bottom: context.scroll.offset_from_bottom });
      if (!this.current(gesture)) return;
      if (result.handled === true) { this.cancel(); return; }
      if (typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url) || /[\u0000-\u0020\u007f]/.test(result.url)) { this.replay(gesture); return; }
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol)) { this.replay(gesture); return; }
      this.cancel();
      // Some browsers retain user activation during the native request; others
      // require another click. Keep an explicit, safe link when a popup is blocked.
      const popup = window.open('about:blank', '_blank');
      if (popup) {
        try {
          popup.opener = null;
          const referrer = popup.document.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; popup.document.head.append(referrer);
          popup.location.replace(url.href);
        } catch { popup.close(); this.offer(url.href); }
      } else this.offer(url.href);
    } catch (error) {
      if (this.gesture !== gesture) return;
      this.cancel(); this.report((error as Error).message || 'Link activation failed.', true);
    }
  }
  private offer(url: string) {
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `[OPEN] ${url}`; link.title = url;
    const close = document.createElement('button'); close.textContent = '[X]'; close.setAttribute('aria-label', 'Dismiss terminal link'); close.onclick = () => this.cancel();
    this.notice.replaceChildren(document.createTextNode('NEW TAB BLOCKED '), link, close); this.notice.hidden = false;
  }
}
