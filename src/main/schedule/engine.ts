import { describeRule, type ScheduledPrompt } from '../../shared/schedule.js';
import type { SchedulesStore } from './store.js';
import type { ScheduledPromptRunner } from './runner.js';

export const DEFAULT_TICK_MS = 30_000;

interface SchedulerEngineDeps {
  store: SchedulesStore;
  runner: ScheduledPromptRunner;
  /** 进 Host 审计，域固定为 'schedule'。 */
  recordEvent: (eventType: string, scheduleId: string, payload: unknown) => void;
  /** 完成或失败后发系统通知；不支持时由调用方降级为 no-op。 */
  notify: (title: string, body: string) => void;
  now?: () => Date;
  tickMs?: number;
}

/**
 * 每 tick 扫一次到点的任务：到点就在后台跑，同一任务上一次还没结束就跳过并记 skipped；
 * 应用关闭/睡眠错过的周期在启动或 resume 后由一次 catch-up 补跑——只补一次，跑完重算 nextRunAt
 * 直接跳到下一个未来时刻。所有触发、跳过、补跑、失败都进 Host 审计（域 'schedule'）。
 */
export class SchedulerEngine {
  readonly tickMs: number;
  readonly #deps: SchedulerEngineDeps;
  readonly #now: () => Date;
  readonly #running = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: SchedulerEngineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.#timer) return;
    // 启动即补跑一次：关机期间错过的任务在这里兜底。
    void this.tick('startup');
    this.#timer = setInterval(() => void this.tick('tick'), this.tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 睡眠唤醒 / 解锁屏幕后补跑一次。 */
  onResume(): void {
    void this.tick('resume');
  }

  isRunning(scheduleId: string): boolean {
    return this.#running.has(scheduleId) || this.#deps.runner.isRunning(scheduleId);
  }

  async tick(source: 'startup' | 'tick' | 'resume'): Promise<void> {
    const now = this.#now();
    const due = this.#deps.store.due(now);
    for (const item of due) await this.#fire(item, now, source);
  }

  async #fire(
    item: ScheduledPrompt,
    now: Date,
    source: 'startup' | 'tick' | 'resume',
  ): Promise<void> {
    if (this.#running.has(item.id) || this.#deps.runner.isRunning(item.id)) {
      this.#deps.recordEvent('schedule.skipped', item.id, {
        reason: 'overlap',
        at: now.toISOString(),
        source,
      });
      return;
    }
    this.#running.add(item.id);
    this.#deps.recordEvent('schedule.fired', item.id, { at: now.toISOString(), source });
    const title = `${item.name} · ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    try {
      const result = await this.#deps.runner.run({
        conversationTitle: title,
        agentId: item.agentId,
        prompt: item.prompt,
        origin: 'scheduled',
        scheduleId: item.id,
      });
      if (result.status === 'skipped') {
        this.#deps.store.recordRun(
          item.id,
          { status: 'skipped', at: now.toISOString(), reason: result.reason },
          now,
        );
        this.#deps.recordEvent('schedule.skipped', item.id, {
          reason: result.reason,
          at: now.toISOString(),
        });
        return;
      }
      const ok = result.status === 'ok';
      this.#deps.store.recordRun(
        item.id,
        {
          status: ok ? 'ok' : 'failed',
          at: now.toISOString(),
          ...(ok ? {} : { reason: result.reason }),
        },
        now,
      );
      this.#deps.recordEvent(ok ? 'schedule.completed' : 'schedule.failed', item.id, {
        conversationId: 'conversationId' in result ? result.conversationId : undefined,
        at: now.toISOString(),
        ...(ok ? {} : { reason: result.reason }),
      });
      this.#deps.notify(
        ok ? '定时任务已完成' : '定时任务失败',
        `${item.name}（${describeRule(item.rule)}）${ok ? '' : `：${result.reason}`}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#deps.store.recordRun(item.id, { status: 'failed', at: now.toISOString(), reason }, now);
      this.#deps.recordEvent('schedule.failed', item.id, { reason, at: now.toISOString() });
      this.#deps.notify('定时任务失败', `${item.name}：${reason}`);
    } finally {
      this.#running.delete(item.id);
    }
  }
}
