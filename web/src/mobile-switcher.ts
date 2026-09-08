export interface SwitcherItem {
  id: string;
  label: string;
  detail?: string;
  active?: boolean;
  preview?: boolean;
  unavailable?: boolean;
  run(): void;
}
export interface SwitcherSection { id: string; label: string; empty?: string; items: SwitcherItem[] }

/** A DOM surface for touch navigation, separate from the mounted terminal. */
export class MobileSwitcher {
  readonly element = document.createElement('section');
  private content = document.createElement('div');
  private notice = document.createElement('p');
  private preview?: string;
  constructor(private background: HTMLElement, close: () => void, private restoreFocus: () => void) {
    this.element.id = 'navigate-switcher'; this.element.hidden = true; this.element.tabIndex = -1;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true'); this.element.setAttribute('aria-label', 'Switch workspace, tab or host');
    const header = document.createElement('div'); header.className = 'switcher-header';
    const title = document.createElement('h1'); title.textContent = 'SWITCH';
    const done = document.createElement('button'); done.textContent = '[X] CLOSE'; done.onclick = close;
    header.append(title, done); this.content.className = 'switcher-content';
    this.notice.className = 'switcher-notice'; this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    this.element.append(header, this.notice, this.content); document.body.append(this.element);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'wheel']) {
      this.element.addEventListener(type, event => event.stopPropagation(), { passive: true });
    }
  }
  hide() {
    if (this.element.hidden) return;
    const focused = this.element.contains(document.activeElement);
    this.element.hidden = true; this.background.inert = false; this.preview = undefined;
    if (focused) this.restoreFocus();
  }
  report(text: string) { this.notice.textContent = text; this.notice.hidden = !text; }
  render(sections: SwitcherSection[]) {
    const opening = this.element.hidden;
    this.element.hidden = false; this.background.inert = true;
    if (opening) { this.report(''); this.content.scrollTop = 0; this.element.focus({ preventScroll: true }); }
    const existing = new Map([...this.content.children].map(node => [(node as HTMLElement).dataset.section, node as HTMLElement]));
    sections.forEach((section, index) => {
      const group = existing.get(section.id) || document.createElement('section'); existing.delete(section.id);
      group.dataset.section = section.id;
      let heading = group.querySelector('h2');
      if (!heading) { heading = document.createElement('h2'); group.append(heading); }
      if (heading.textContent !== section.label) heading.textContent = section.label;
      const buttons = new Map([...group.querySelectorAll<HTMLButtonElement>('button')].map(node => [node.dataset.id, node]));
      section.items.forEach((item, position) => {
        const button = buttons.get(item.id) || document.createElement('button'); buttons.delete(item.id);
        button.dataset.id = item.id; button.classList.toggle('active', !!item.active); button.classList.toggle('navigate-preview', !!item.preview);
        button.setAttribute('aria-disabled', String(!!item.unavailable)); button.setAttribute('aria-label', item.label + (item.preview ? ' (preview)' : '')); button.setAttribute('aria-current', String(!!item.active));
        button.title = [item.label, item.detail].filter(Boolean).join('\n'); button.onclick = item.run;
        let label = button.querySelector('strong'), detail = button.querySelector('span');
        if (!label || !detail) { label = document.createElement('strong'); detail = document.createElement('span'); button.replaceChildren(label, detail); }
        if (label.textContent !== item.label) label.textContent = item.label;
        if (detail.textContent !== (item.detail || '')) detail.textContent = item.detail || '';
        detail.hidden = !item.detail;
        if (group.children[position + 1] !== button) group.insertBefore(button, group.children[position + 1] || null);
      });
      for (const button of buttons.values()) button.remove();
      let empty = group.querySelector<HTMLParagraphElement>('.switcher-empty');
      if (!section.items.length && section.empty) {
        if (!empty) { empty = document.createElement('p'); empty.className = 'switcher-empty'; group.append(empty); }
        empty.textContent = section.empty;
      } else empty?.remove();
      if (this.content.children[index] !== group) this.content.insertBefore(group, this.content.children[index] || null);
    });
    for (const group of existing.values()) group.remove();
    const selected = this.content.querySelector<HTMLButtonElement>('.navigate-preview');
    if (selected && !opening && this.preview !== selected.dataset.id) selected.scrollIntoView({ block: 'nearest' });
    this.preview = selected?.dataset.id;
    if (!this.element.contains(document.activeElement)) this.element.focus({ preventScroll: true });
  }
}
