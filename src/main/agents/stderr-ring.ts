export class StderrRingBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #windowStarted = Date.now();
  #windowBytes = 0;
  #droppedBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly rateBytesPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  push(input: Buffer | string): { accepted: string; droppedBytes: number } {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const now = this.now();
    if (now - this.#windowStarted >= 1000) {
      this.#windowStarted = now;
      this.#windowBytes = 0;
    }
    const allowance = Math.max(0, this.rateBytesPerSecond - this.#windowBytes);
    const accepted = chunk.subarray(0, allowance);
    const dropped = chunk.length - accepted.length;
    this.#windowBytes += accepted.length;
    this.#droppedBytes += dropped;
    if (accepted.length) {
      this.#chunks.push(Buffer.from(accepted));
      this.#bytes += accepted.length;
      while (this.#bytes > this.maxBytes && this.#chunks.length) {
        const overflow = this.#bytes - this.maxBytes;
        const first = this.#chunks[0]!;
        if (first.length <= overflow) {
          this.#chunks.shift();
          this.#bytes -= first.length;
        } else {
          this.#chunks[0] = first.subarray(overflow);
          this.#bytes -= overflow;
        }
      }
    }
    return { accepted: accepted.toString('utf8'), droppedBytes: dropped };
  }

  snapshot(): { text: string; droppedBytes: number } {
    return {
      text: Buffer.concat(this.#chunks, this.#bytes).toString('utf8'),
      droppedBytes: this.#droppedBytes,
    };
  }
}
