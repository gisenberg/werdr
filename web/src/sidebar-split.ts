/** Presentation-only sidebar geometry. Never resize or recreate terminal panes. */
export class SidebarSplit {
  private value = 50;
  private pointer?: number;
  private initial = 50;
  private saving = false;
  constructor(private readonly sections: HTMLElement, private readonly divider: HTMLElement, private readonly save: (value: number) => Promise<void>) {
    divider.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.saving || this.pointer !== undefined) return;
      event.preventDefault(); this.initial = this.value; this.pointer = event.pointerId;
      divider.setPointerCapture(event.pointerId); divider.dataset.dragging = '';
    });
    divider.addEventListener('pointermove', event => {
      if (event.pointerId !== this.pointer) return;
      const box = sections.getBoundingClientRect();
      this.render((event.clientY - box.top - divider.offsetHeight / 2) / (box.height - divider.offsetHeight) * 100);
    });
    divider.addEventListener('pointerup', event => {
      if (event.pointerId !== this.pointer) return;
      this.pointer = undefined; delete divider.dataset.dragging;
      divider.releasePointerCapture(event.pointerId); void this.commit();
    });
    const cancel = () => {
      if (this.pointer === undefined) return;
      const pointer = this.pointer; this.pointer = undefined; delete divider.dataset.dragging;
      this.render(this.initial);
      if (divider.hasPointerCapture(pointer)) divider.releasePointerCapture(pointer);
    };
    window.addEventListener('blur', cancel);
    matchMedia('(max-width: 700px)').addEventListener('change', cancel);
    divider.addEventListener('pointercancel', cancel);
    divider.addEventListener('lostpointercapture', cancel);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
    divider.addEventListener('keydown', event => {
      const value = event.key === 'Home' ? 10 : event.key === 'End' ? 90 : event.key === 'ArrowUp' ? this.value - 5 : event.key === 'ArrowDown' ? this.value + 5 : undefined;
      if (value === undefined) return;
      event.preventDefault(); if (this.saving || this.pointer !== undefined) return;
      this.initial = this.value; this.render(value); void this.commit();
    });
    this.render(this.value);
  }
  update(value: number) { if (this.pointer === undefined) this.render(value); }
  private render(value: number) {
    if (!Number.isFinite(value)) return;
    this.value = Math.max(10, Math.min(90, Math.round(value)));
    this.sections.style.setProperty('--workspace-section', `${this.value}fr`);
    this.sections.style.setProperty('--agent-section', `${100 - this.value}fr`);
    this.divider.setAttribute('aria-valuenow', String(this.value));
    this.divider.setAttribute('aria-valuetext', `${this.value}% workspaces, ${100 - this.value}% agents`);
  }
  private async commit() {
    if (this.value === this.initial) return;
    this.saving = true; this.divider.setAttribute('aria-disabled', 'true');
    try { await this.save(this.value); }
    catch (error) { document.getElementById('status')!.textContent = `[ERROR] ${(error as Error).message}`; }
    finally { this.saving = false; this.divider.removeAttribute('aria-disabled'); }
  }
}
