import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  nextRunAfter,
  SCHEDULE_LIMIT,
  ScheduledPromptSchema,
  type ScheduleInput,
  type ScheduleOrigin,
  type ScheduleOutcome,
  type ScheduledPrompt,
} from '../../shared/schedule.js';

export class ScheduleLimitError extends Error {}

/**
 * userData/schedules.json 的原子存储。与 SettingsStore 同款写法：所有写都先落随机临时文件再
 * rename 覆盖，权限 0600——里面存着要发给 Agent 的 prompt 全文，和录制轨迹一样敏感。
 * 最多 SCHEDULE_LIMIT 条；读坏了就退回空列表，不让一条坏数据挡住启动。
 */
export class SchedulesStore {
  #items: ScheduledPrompt[] = [];
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  get items(): readonly ScheduledPrompt[] {
    return this.#items;
  }

  async load(): Promise<void> {
    try {
      const parsed = ScheduledPromptSchema.array().parse(
        JSON.parse(await readFile(this.path, 'utf8')),
      );
      this.#items = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('定时任务文件读取失败，使用空列表', error);
    }
  }

  get(id: string): ScheduledPrompt | undefined {
    return this.#items.find((item) => item.id === id);
  }

  create(input: ScheduleInput, origin: ScheduleOrigin, now: Date): ScheduledPrompt {
    if (this.#items.length >= SCHEDULE_LIMIT)
      throw new ScheduleLimitError(`最多 ${SCHEDULE_LIMIT} 条定时任务`);
    const created: ScheduledPrompt = {
      id: randomUUID(),
      name: input.name,
      agentId: input.agentId,
      prompt: input.prompt,
      rule: input.rule,
      enabled: input.enabled,
      origin,
      createdAt: now.toISOString(),
      nextRunAt: nextRunAfter(input.rule, now).toISOString(),
      permissionMode: input.permissionMode ?? 'ask',
    };
    this.#items = [created, ...this.#items];
    void this.#flush();
    return created;
  }

  setEnabled(id: string, enabled: boolean): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    item.enabled = enabled;
    void this.#flush();
    return item;
  }

  remove(id: string): boolean {
    const existed = this.#items.some((item) => item.id === id);
    if (!existed) return false;
    this.#items = this.#items.filter((item) => item.id !== id);
    void this.#flush();
    return true;
  }

  /** 一次触发结束后：记下结果与最后运行时间，并把 nextRunAt 推到下一次（错过的周期整体跳过）。 */
  recordRun(id: string, outcome: ScheduleOutcome, now: Date): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    item.lastRunAt = now.toISOString();
    item.lastOutcome = outcome;
    item.nextRunAt = nextRunAfter(item.rule, now).toISOString();
    void this.#flush();
    return item;
  }

  /** 到点的任务：已启用且 nextRunAt 不晚于 now。按 nextRunAt 升序，先到的先跑。 */
  due(now: Date): ScheduledPrompt[] {
    return this.#items
      .filter((item) => item.enabled && Date.parse(item.nextRunAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  }

  /** 「立即运行一次」：只记结果，不挪动原定的 nextRunAt。 */
  recordManualRun(id: string, outcome: ScheduleOutcome): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    item.lastRunAt = outcome.at;
    item.lastOutcome = outcome;
    void this.#flush();
    return item;
  }

  /** 等所有进行中的写落盘（测试与关闭时用）。 */
  async idle(): Promise<void> {
    await this.#pending;
  }

  async #flush(): Promise<void> {
    const body = JSON.stringify(this.#items, null, 2);
    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.path);
      });
    await this.#pending;
  }
}
