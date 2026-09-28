/** Own every audio resource so late failures cannot restart sound after cancellation. */
export class SoundPlayer {
  private active = new Map<HTMLAudioElement, () => void>();
  private generation = 0;
  constructor(private readonly report: (message: string) => void, private readonly create: (source: string) => HTMLAudioElement = source => new Audio(source)) {}
  stop() { ++this.generation; for (const close of [...this.active.values()]) close(); }
  play(source: string, fallback?: string) { this.start(source, fallback, this.generation); }
  private start(source: string, fallback: string | undefined, generation: number) {
    if (generation !== this.generation) return;
    const audio = this.create(source); let closed = false;
    const close = () => {
      if (closed) return; closed = true; this.active.delete(audio);
      audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load();
    };
    const failed = (error?: unknown) => {
      if (closed || generation !== this.generation) return;
      close();
      if ((error as { name?: string })?.name === 'NotAllowedError') { this.report('Browser blocked audio. Interact with this page and allow sound before trying again.'); return; }
      if (fallback && fallback !== source) { this.report('Custom sound is unavailable. Using the built-in sound.'); this.start(fallback, undefined, generation); }
      else this.report('Audio could not be played.');
    };
    this.active.set(audio, close); audio.onended = close; audio.onerror = () => failed();
    try { void audio.play().catch(failed); } catch (error) { failed(error); }
  }
}
