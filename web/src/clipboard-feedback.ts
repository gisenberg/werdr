import type { Preferences } from '../shared/settings';

interface Rect { x: number; y: number; width: number; height: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Native copy feedback is anchored to the pane surface, outside alert delivery policy. */
export function clipboardFeedbackRect(width: number, height: number, size: { width: number; height: number }, position: Preferences['clipboardToastPosition'], notice?: Rect): Rect {
  const w = Math.min(width, size.width), h = Math.min(height, size.height);
  const top = position.startsWith('top');
  const rect = { x: position.endsWith('left') ? 0 : position.endsWith('right') ? width - w : (width - w) / 2, y: top ? 0 : height - h, width: w, height: h };
  if (notice && overlaps(rect, notice)) rect.y = Math.max(0, Math.min(height - h, top ? notice.y + notice.height : notice.y - h));
  return rect;
}

export class ClipboardFeedback {
  private node = document.createElement('div');
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  constructor(private readonly container: HTMLElement, private readonly preferences: () => Preferences) {
    this.node.id = 'clipboard-feedback'; this.node.hidden = true;
    this.node.setAttribute('role', 'status'); this.node.setAttribute('aria-live', 'polite'); this.node.setAttribute('aria-atomic', 'true');
    const marker = document.createElement('span'); marker.textContent = '●'; marker.setAttribute('aria-hidden', 'true');
    this.node.append(marker, ' copied to clipboard'); container.append(this.node);
    const resize = new ResizeObserver(() => this.update()); resize.observe(container); resize.observe(this.node);
    const toast = document.getElementById('notice-toast');
    if (toast) {
      resize.observe(toast);
      new MutationObserver(() => this.update()).observe(toast, { attributes: true, attributeFilter: ['hidden', 'data-position'], childList: true, subtree: true, characterData: true });
    }
    document.addEventListener('visibilitychange', () => this.update());
  }
  show() {
    if (!this.preferences().clipboardToast) return;
    clearTimeout(this.timer); this.deadline = performance.now() + 2000;
    this.node.hidden = false; this.update();
    this.timer = setTimeout(() => this.clear(), 2000);
  }
  clear() { clearTimeout(this.timer); this.timer = undefined; this.deadline = 0; this.node.hidden = true; }
  update() {
    if (this.node.hidden) return;
    const preferences = this.preferences();
    if (!preferences.clipboardToast || performance.now() >= this.deadline) { this.clear(); return; }
    const bounds = this.container.getBoundingClientRect(), toast = document.getElementById('notice-toast');
    const notice = toast && !toast.hidden ? toast.getBoundingClientRect() : undefined;
    const position = clipboardFeedbackRect(this.container.clientWidth, this.container.clientHeight, { width: this.node.offsetWidth, height: this.node.offsetHeight }, preferences.clipboardToastPosition,
      notice && { x: notice.x - bounds.x, y: notice.y - bounds.y, width: notice.width, height: notice.height });
    this.node.dataset.position = preferences.clipboardToastPosition;
    this.node.style.left = position.x + 'px'; this.node.style.top = position.y + 'px';
  }
}
