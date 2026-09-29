// A detached page keeps its login but cannot accept work from an older attachment.
export class ClientCancelled extends Error {
  constructor() { super('Client request cancelled.'); this.name = 'AbortError'; }
}
export class ClientLifecycle {
  active = true;
  private epoch = 0;
  private requests = new Set<AbortController>();
  get generation() { return this.epoch; }
  current(generation: number) { return this.active && generation === this.epoch; }
  detach() { this.active = false; this.invalidate(); }
  resume() { this.invalidate(); this.active = true; }
  private invalidate() {
    ++this.epoch;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
  async request<T>(operation: (signal: AbortSignal) => Promise<T>, allowDetached = false): Promise<T> {
    if (!this.active && !allowDetached) throw new ClientCancelled();
    const epoch = this.epoch, controller = new AbortController(); this.requests.add(controller);
    try {
      const result = await operation(controller.signal);
      if (epoch !== this.epoch) throw new ClientCancelled();
      return result;
    } catch (error) {
      if (epoch !== this.epoch) throw new ClientCancelled();
      throw error;
    } finally { this.requests.delete(controller); }
  }
}
