// Do not decode subprocess chunks independently: UTF-8 and JSON records can
// both span arbitrary pipe read boundaries.
export class NdjsonDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}
  push(chunk: Buffer, consume: (value: any) => void) {
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) >= 0) {
      if (newline > this.maxBytes) throw new Error('Frame too large');
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      consume(JSON.parse(line.toString('utf8')));
    }
    if (this.pending.length > this.maxBytes) throw new Error('Frame too large');
  }
}
