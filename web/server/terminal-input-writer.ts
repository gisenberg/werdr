import type { Writable } from 'node:stream';
import { clipboardImageExtension, MAX_CLIPBOARD_IMAGE_BYTES } from '../shared/clipboard-image.ts';

/** Queued input above which the viewer socket stops being read until the controller catches up. */
export const INPUT_HIGH_WATER_BYTES = 65536;
/**
 * Input a paused viewer may still deliver from frames its socket had already
 * received. Exceeding it means the viewer ignored backpressure.
 */
export const INPUT_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Keep keystrokes ordered behind an image without allowing unbounded pipe queues.
 * Large pastes arrive as many bounded messages; instead of rejecting them when
 * the controller is slower than the network, `pressure(true)` asks the caller
 * to stop reading the viewer socket until the queue drains.
 */
export class TerminalInputWriter {
  private static images = 0;
  private imagePending = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private stopped = false;
  private paused = false;
  /** Bytes of the image record still in the pipe; images are bounded separately. */
  private imageBytes = 0;
  constructor(private input: Writable, private pressure: (paused: boolean) => void = () => {}) {
    input.on('drain', this.relieve);
  }
  write(line: string) {
    if (this.stopped) throw new Error('Terminal detached');
    const bytes = Buffer.byteLength(line);
    if (this.queuedBytes() + bytes > INPUT_QUEUE_LIMIT_BYTES) throw new Error('Input queue full');
    if (this.imagePending) { this.pending.push(line); this.pendingBytes += bytes; }
    else this.input.write(line);
    if (!this.paused && this.queuedBytes() > INPUT_HIGH_WATER_BYTES) { this.paused = true; this.pressure(true); }
  }
  private queuedBytes() { return Math.max(0, this.input.writableLength - this.imageBytes) + this.pendingBytes; }
  private relieve = () => {
    if (this.paused && !this.stopped && this.queuedBytes() <= INPUT_HIGH_WATER_BYTES) { this.paused = false; this.pressure(false); }
  };
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
        this.imagePending = false; this.imageBytes = 0; TerminalInputWriter.images--;
        const pending = this.pending; this.pending = []; this.pendingBytes = 0;
        if (error || this.stopped) { reject(new Error('Terminal detached during image transfer.')); return; }
        for (const line of pending) this.input.write(line);
        this.relieve();
        resolve();
      };
      const record = JSON.stringify({ type: 'terminal.image', extension, bytes: bytes.toString('base64') }) + '\n';
      this.imageBytes = Buffer.byteLength(record);
      try { this.input.write(record, complete); }
      catch { complete(new Error('Cannot write to terminal')); }
    });
  }
  dispose() { this.stopped = true; this.pending = []; this.pendingBytes = 0; this.input.off('drain', this.relieve); }
}
