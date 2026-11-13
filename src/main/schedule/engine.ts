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
 * 每 tick 扫一次到点的任务：到点就在后台跑。nextRunAt 在开跑之前就推到下一个未来时刻并落盘，
 * 跑完只记结果——跑的途中每个 tick 都不会再把它当成到点，跑到一半崩溃也不会在下次启动时重跑。
 * 同一任务上一次还没结束、下一个时刻又到了，就跳过这个时刻并记一次 skipped（同样把 nextRunAt 推过去，
 * 一个错过的时刻只记一次）。应用关闭/睡眠错过的周期在启动或 resume 后由一次 catch-up 补跑——只补一次，
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
    for (const item of due) await this.#fire(item.id, now, source);
  }

  /**
   * 把 nextRunAt 推过这个时刻。算不出下一次（规则坏了）时不能照跑：nextRunAt 推不动，每个 tick 都会
   * 再跑一遍同一个 prompt。这时停用这条任务、记一次失败，等人处理。返回 false 表示不要跑。
   */
  #advance(item: ScheduledPrompt, now: Date): boolean {
    try {
      this.#deps.store.advance(item.id, now);
      return true;
    } catch (error) {
      const reason = `算不出下一次运行时间：${error instanceof Error ? error.message : String(error)}`;
      this.#deps.store.setEnabled(item.id, false, now);
      this.#deps.store.recordRun(item.id, { status: 'failed', at: now.toISOString(), reason }, now);
      this.#deps.recordEvent('schedule.failed', item.id, { reason, at: now.toISOString() });
      this.#deps.notify('定时任务已停用', `${item.name}：${reason}`);
      return false;
    }
  }

  async #fire(scheduleId: string, now: Date, source: 'startup' | 'tick' | 'resume'): Promise<void> {
    // Earlier runs can yield while this queued task is deleted, disabled, or rescheduled.
    const item = this.#deps.store.get(scheduleId);
    if (!item || !item.enabled || !(Date.parse(item.nextRunAt) <= now.getTime())) return;
    if (this.#running.has(item.id) || this.#deps.runner.isRunning(item.id)) {
      // 跳过的这个时刻也要推过去：否则跑完之前每个 tick 都会再找到它，再记一次跳过。
      if (!this.#advance(item, now)) return;
      this.#deps.recordEvent('schedule.skipped', item.id, {
        reason: 'overlap',
        at: now.toISOString(),
        source,
      });
      return;
    }
    if (!this.#advance(item, now)) return;
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
        permissionMode: item.permissionMode,
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
      // ask 模式无人在场时审批 60s 超时自动拒绝：通知里说明有操作被拒。
      const unattended = ok && 'unattendedDenied' in result && result.unattendedDenied;
      this.#deps.notify(
        unattended ? '定时任务已完成（有操作被拒）' : ok ? '定时任务已完成' : '定时任务失败',
        `${item.name}（${describeRule(item.rule)}）${ok ? '' : `：${result.reason}`}${
          unattended ? '。有操作因无人审批被拒绝' : ''
        }`,
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
