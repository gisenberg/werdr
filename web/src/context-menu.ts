export interface ContextAction { label: string; run(): void }
export class ContextMenu {
  private readonly element = document.createElement('div');
  private origin?: HTMLElement;
  private valid?: () => boolean;
  constructor() {
    this.element.className = 'context-menu'; this.element.setAttribute('role', 'menu'); this.element.hidden = true;
    document.body.append(this.element);
    document.addEventListener('pointerdown', event => { if (!this.element.contains(event.target as Node)) this.close(false); }, true);
    document.addEventListener('focusin', event => { if (!this.element.hidden && !this.element.contains(event.target as Node)) this.close(false); });
    window.addEventListener('resize', () => this.close()); window.addEventListener('blur', () => this.close(false));
    this.element.onkeydown = event => {
      const buttons = [...this.element.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
      if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    };
  }
  open(origin: HTMLElement, title: string, items: ContextAction[], valid: () => boolean, position?: { x: number; y: number }) {
    this.close(false); if (!items.length || !valid()) return;
    this.origin = origin; this.valid = valid; this.element.replaceChildren(); this.element.setAttribute('aria-label', title);
    const heading = document.createElement('div'); heading.className = 'context-menu-title'; heading.textContent = title; this.element.append(heading);
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = item.label;
      button.onclick = () => { const current = this.valid?.(); this.close(); if (current) item.run(); }; this.element.append(button);
    }
    const bounds = origin.getBoundingClientRect();
    this.element.hidden = false; this.element.style.left = '0px'; this.element.style.top = '0px';
    const x = position?.x ?? bounds.left, y = position?.y ?? bounds.bottom;
    this.element.style.left = Math.max(8, Math.min(x, window.innerWidth - this.element.offsetWidth - 8)) + 'px';
    this.element.style.top = Math.max(8, Math.min(y, window.innerHeight - this.element.offsetHeight - 8)) + 'px';
    this.element.querySelector<HTMLButtonElement>('button')?.focus();
  }
  refresh() { if (this.valid && (!this.valid() || !this.origin?.isConnected)) this.close(); }
  close(restore = true) {
    const origin = this.origin; this.origin = undefined; this.valid = undefined; this.element.hidden = true;
    if (restore && origin?.isConnected) origin.focus({ preventScroll: true });
  }
}
