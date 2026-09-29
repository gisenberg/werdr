import type { Writable } from 'node:stream';
import { clipboardImageExtension, MAX_CLIPBOARD_IMAGE_BYTES } from '../shared/clipboard-image.ts';

/** Keep keystrokes ordered behind an image without allowing unbounded pipe queues. */
export class TerminalInputWriter {
  private static images = 0;
  private imagePending = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private stopped = false;
  constructor(private input: Writable) {}
  write(line: string) {
    if (this.stopped) throw new Error('Terminal detached');
    if (this.imagePending) {
      const bytes = Buffer.byteLength(line);
      if (this.pendingBytes + bytes > 65536) throw new Error('Input queue full');
      this.pending.push(line); this.pendingBytes += bytes;
    } else {
      if (this.input.writableLength + Buffer.byteLength(line) > 65536) throw new Error('Input queue full');
      this.input.write(line);
    }
  }
  image(bytes: Buffer, limit: number): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Terminal detached'));
    if (!limit) return Promise.reject(new Error('Image paste requires an updated terminal client on this host.'));
    if (!bytes.length || bytes.length > Math.min(limit, MAX_CLIPBOARD_IMAGE_BYTES)) return Promise.reject(new Error('Image must be between 1 byte and 16 MiB.'));
    const extension = clipboardImageExtension(bytes);
    if (!extension) return Promise.reject(new Error('Paste a PNG, JPEG, GIF, WebP, or BMP image.'));
    if (this.imagePending || TerminalInputWriter.images >= 2) return Promise.reject(new Error('An image transfer is still running. Try again shortly.'));
    this.imagePending = true; TerminalInputWriter.images++;
    return new Promise<void>((resolve, reject) => {
      let completed = false;
      const complete = (error?: Error | null) => {
        if (completed) return; completed = true;
        this.imagePending = false; TerminalInputWriter.images--;
        const pending = this.pending; this.pending = []; this.pendingBytes = 0;
        if (error || this.stopped) { reject(new Error('Terminal detached during image transfer.')); return; }
        for (const line of pending) this.input.write(line);
        resolve();
      };
      try { this.input.write(JSON.stringify({ type: 'terminal.image', extension, bytes: bytes.toString('base64') }) + '\n', complete); }
      catch { complete(new Error('Cannot write to terminal')); }
    });
  }
  dispose() { this.stopped = true; this.pending = []; this.pendingBytes = 0; }
}
