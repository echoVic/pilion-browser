export class ExternalUrlQueue {
  private ready = false;
  private queued: string[] = [];
  private pending = Promise.resolve();

  constructor(
    private readonly open: (url: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  async receive(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    if (!this.ready) {
      this.queued.push(url);
      return;
    }
    return this.deliver(url);
  }

  async flush(): Promise<void> {
    if (!this.ready) {
      this.ready = true;
      for (const url of this.queued) this.deliver(url);
      this.queued = [];
    }
    return this.pending;
  }

  private deliver(url: string): Promise<void> {
    // 开标签页是异步的：启动队列和随后到达的链接共用同一条顺序。
    this.pending = this.pending.then(() => this.open(url)).catch(this.onError);
    return this.pending;
  }
}
