import { clipboardImageExtension, MAX_CLIPBOARD_IMAGE_BYTES } from '../shared/clipboard-image';

/** File bytes stay bound to the attachment and focus that accepted the gesture. */
export class TerminalImagePaste {
  private limit = 0;
  private generation = 0;
  private reading = false;
  private awaiting = false;
  private queued: string[] = [];
  private queuedBytes = 0;
  constructor(private content: HTMLElement, private textarea: HTMLTextAreaElement, private available: () => boolean, private wire: (data: string | ArrayBuffer) => void, private report: (message: string, failed?: boolean) => void) {
    content.addEventListener('paste', this.paste, true);
    content.addEventListener('dragover', this.dragover); content.addEventListener('drop', this.drop);
  }
  capabilities(limit: unknown) { this.limit = Number.isInteger(limit) && Number(limit) > 0 ? Math.min(Number(limit), MAX_CLIPBOARD_IMAGE_BYTES) : 0; }
  result(status: unknown, message: unknown) {
    if (!this.awaiting) return;
    this.awaiting = false;
    if (status === 'sent') this.report('Image sent to terminal.');
    else this.report(typeof message === 'string' ? message : 'Image transfer failed.', true);
  }
  send(value: object) {
    const line = JSON.stringify(value);
    if (!this.reading) { this.wire(line); return; }
    const size = new TextEncoder().encode(line).length;
    if (size + this.queuedBytes > 65536) {
      this.cancel(); this.report('Image paste cancelled because terminal input arrived too quickly.', true); this.wire(line); return;
    }
    this.queued.push(line); this.queuedBytes += size;
  }
  cancel() { ++this.generation; this.reading = false; this.flush(); }
  dispose() {
    ++this.generation; this.reading = false; this.awaiting = false; this.queued = []; this.queuedBytes = 0;
    this.content.removeEventListener('paste', this.paste, true); this.content.removeEventListener('dragover', this.dragover); this.content.removeEventListener('drop', this.drop);
  }
  private flush() { const queued = this.queued; this.queued = []; this.queuedBytes = 0; for (const line of queued) this.wire(line); }
  private paste = (event: ClipboardEvent) => {
    if (event.target !== this.textarea) return;
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.start(files);
  };
  private dragover = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = this.available() ? 'copy' : 'none'; } };
  private drop = (event: DragEvent) => {
    const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.available()) this.textarea.focus({ preventScroll: true });
    this.start(files);
  };
  private start(files: File[]) {
    if (!this.available()) { this.report('Focus a connected terminal before pasting an image.', true); return; }
    if (!this.limit) { this.report('Image paste requires an updated terminal client on this host.', true); return; }
    if (files.length !== 1) { this.report('Paste or drop one image at a time.', true); return; }
    if (this.reading || this.awaiting) { this.report('An image transfer is still running. Try again shortly.', true); return; }
    const file = files[0];
    if (!file.size || file.size > this.limit) { this.report('Image must be between 1 byte and 16 MiB.', true); return; }
    const generation = ++this.generation; this.reading = true;
    void file.arrayBuffer().then(bytes => {
      if (generation !== this.generation) return;
      if (!this.available() || document.activeElement !== this.textarea) throw new Error('Image paste cancelled because terminal focus changed.');
      if (!clipboardImageExtension(new Uint8Array(bytes))) throw new Error('Paste a PNG, JPEG, GIF, WebP, or BMP image.');
      this.awaiting = true; this.wire(bytes);
    }).catch(error => { if (generation === this.generation) { this.awaiting = false; this.report((error as Error).message || 'Cannot read the image.', true); } }).finally(() => {
      if (generation === this.generation) { this.reading = false; this.flush(); }
    });
  }
}
