export const ATTACHMENT_IDLE_MS = 60 * 60_000;
const RENEW_INTERVAL_MS = 60_000;

type LeaseOptions = {
  leaseExpiresAt: number;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  isActive: () => boolean;
  renew: (deadline: number) => boolean;
  expire: () => void;
};

export class AttachmentLease {
  private deadline: number;
  private pendingDeadline: number;
  private lastRenewedAt: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: LeaseOptions) {
    this.deadline = options.leaseExpiresAt;
    this.pendingDeadline = this.deadline;
    this.lastRenewedAt = this.deadline - ATTACHMENT_IDLE_MS;
    this.schedule();
  }

  activity(): void {
    if (this.stopped) return;
    const now = this.options.now();
    if (now >= this.deadline) {
      this.expire();
      return;
    }
    this.pendingDeadline = now + ATTACHMENT_IDLE_MS;
    if (now - this.lastRenewedAt >= RENEW_INTERVAL_MS) this.renew();
    this.schedule();
  }

  beginActivity(): () => void {
    this.activity();
    return () => this.activity();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
  }

  private renew(): void {
    if (!this.options.renew(this.pendingDeadline)) {
      this.expire();
      return;
    }
    this.deadline = this.pendingDeadline;
    this.lastRenewedAt = this.options.now();
  }

  private expire(): void {
    this.stop();
    this.options.expire();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    const now = this.options.now();
    // 提前检查活跃任务，store 不允许在已经到期之后续租。
    const checkpoint = this.deadline - RENEW_INTERVAL_MS;
    const next =
      this.pendingDeadline > this.deadline
        ? this.lastRenewedAt + RENEW_INTERVAL_MS
        : checkpoint > now
          ? checkpoint
          : this.deadline;
    this.timer = this.options.setTimer(
      () => {
        this.timer = undefined;
        if (this.options.now() >= this.deadline) {
          this.expire();
        } else if (this.options.isActive()) {
          this.activity();
        } else {
          if (this.pendingDeadline > this.deadline) this.renew();
          this.schedule();
        }
      },
      Math.max(0, next - now),
    );
  }
}
