/** Largest OSC 52 payload a pane may place on the browser clipboard. */
export const MAX_TERMINAL_CLIPBOARD_BYTES = 1024 * 1024;
/** Unconfirmed requests expire so a stale pane write cannot be copied much later. */
export const TERMINAL_CLIPBOARD_REQUEST_MS = 60_000;

export type ClipboardRequest = { text: string } | { error: string };

/** Decode the companion's base64 OSC 52 bytes as UTF-8 within the browser limit. */
export function decodeClipboardRequest(data: unknown, limit = MAX_TERMINAL_CLIPBOARD_BYTES): ClipboardRequest {
  if (typeof data !== 'string' || data.length > Math.ceil(limit / 3) * 4 + 4) return { error: 'Terminal clipboard request exceeds 1 MiB.' };
  let binary: string;
  try { binary = atob(data); } catch { return { error: 'Terminal clipboard request was malformed.' }; }
  if (binary.length > limit) return { error: 'Terminal clipboard request exceeds 1 MiB.' };
  return { text: new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))) };
}

/**
 * Applications write the clipboard through OSC 52. Browsers may reject writes
 * without focus or user activation, so a rejected write becomes an explicit,
 * expiring copy action anchored to its pane.
 */
export class TerminalClipboardRequests {
  private readonly notice = document.createElement('div');
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(container: HTMLElement, private report: (message: string, failed?: boolean) => void, private copied: () => void) {
    this.notice.className = 'terminal-clipboard-request'; this.notice.setAttribute('role', 'status'); this.notice.hidden = true;
    container.append(this.notice);
  }
  receive(data: unknown) {
    const request = decodeClipboardRequest(data);
    if ('error' in request) { this.report(request.error, true); return; }
    const generation = ++this.generation; this.cancel(false);
    if (!document.hasFocus() || !navigator.clipboard?.writeText) { this.offer(request.text, generation); return; }
    navigator.clipboard.writeText(request.text).then(() => { if (generation === this.generation) this.copied(); }, () => { if (generation === this.generation) this.offer(request.text, generation); });
  }
  cancel(invalidate = true) { if (invalidate) ++this.generation; clearTimeout(this.timer); this.timer = undefined; this.notice.hidden = true; this.notice.replaceChildren(); }
  dispose() { this.cancel(); this.notice.remove(); }
  private offer(text: string, generation: number) {
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '[COPY]';
    copy.setAttribute('aria-label', 'Copy text requested by the terminal');
    copy.onclick = () => {
      if (generation !== this.generation) return;
      this.cancel();
      // Called inside the click so browsers grant the write its user activation.
      (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard requires a secure browser connection.')))
        .then(() => this.copied(), error => this.report((error as Error).message || 'Clipboard write failed.', true));
    };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '[X]'; close.setAttribute('aria-label', 'Dismiss terminal clipboard request'); close.onclick = () => this.cancel();
    const label = document.createElement('span'); label.className = 'terminal-clipboard-label';
    const characters = [...text].length;
    label.textContent = `CLIPBOARD REQUEST ${characters} ${characters === 1 ? 'CHARACTER' : 'CHARACTERS'}`;
    this.notice.replaceChildren(label, copy, close); this.notice.hidden = false;
    this.timer = setTimeout(() => { if (generation === this.generation) this.cancel(); }, TERMINAL_CLIPBOARD_REQUEST_MS);
  }
}
