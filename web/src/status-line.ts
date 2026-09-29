/** Explicit feedback survives background refreshes and returns to the latest summary. */
export class StatusLine {
  private summary = '';
  private notice?: string;
  private rendered?: string;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly render: (text: string) => void) {}
  update(summary: string) { this.summary = summary; this.paint(); }
  show(notice: string) {
    clearTimeout(this.timer); this.notice = notice; this.paint();
    this.timer = setTimeout(() => this.clear(), 8000);
  }
  clear() { clearTimeout(this.timer); this.timer = undefined; this.notice = undefined; this.paint(); }
  private paint() {
    const text = this.notice ?? this.summary;
    if (text !== this.rendered) { this.rendered = text; this.render(text); }
  }
}
