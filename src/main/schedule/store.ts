import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
 * 最多 SCHEDULE_LIMIT 条；读不懂的条目逐条跳过，不让一条坏数据挡住启动，也不让它连累别的任务。
 */
export class SchedulesStore {
  #items: ScheduledPrompt[] = [];
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  get items(): readonly ScheduledPrompt[] {
    return this.#items;
  }

  async load(now: Date = new Date()): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('定时任务文件读取失败，使用空列表', error);
      return;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(text);
    } catch {
      entries = undefined;
    }
    // 逐条校验：一条读不懂（旧版本写下的非法规则、新版本才有的字段）只跳过它自己。
    const items: ScheduledPrompt[] = [];
    let unreadable = Array.isArray(entries) ? 0 : 1;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const parsed = ScheduledPromptSchema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
      else unreadable += 1;
    }
    // 旧版本算 cron 时不看月份字段：存下的 nextRunAt 可能落在规则根本不包含的日子上。
    // 存的时刻不是这条规则的触发点，就从现在重新算，不按错的时刻补跑一次。
    let corrected = false;
    for (const item of items) {
      const stored = Date.parse(item.nextRunAt);
      // 时间戳读不出来的条目永远不会到点：同样重新算。
      const isSlot =
        !Number.isNaN(stored) &&
        (item.rule.kind !== 'cron' ||
          nextRunAfter(item.rule, new Date(stored - 60_000)).getTime() === stored);
      if (isSlot) continue;
      item.nextRunAt = nextRunAfter(item.rule, now).toISOString();
      corrected = true;
    }
    this.#items = items;
    if (corrected) this.#save();
    if (unreadable) {
      // 下一次保存会把跳过的条目从文件里抹掉，所以先把原件留一份。
      const backup = `${this.path}.unreadable`;
      await copyFile(this.path, backup).catch(() => undefined);
      console.error(`定时任务文件有 ${unreadable} 处无法读取，已跳过；原文件另存为 ${backup}`);
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
    this.#save();
    return created;
  }

  /**
   * 从停用到启用时，停用期间错过的那个时刻（或者创建时就停用、早已过去的那个时刻）不补跑：
   * 从 now 重新算下一次，否则启用后 30 秒内就会在一个随便的时刻跑一次。
   */
  setEnabled(id: string, enabled: boolean, now: Date = new Date()): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    if (enabled && !item.enabled && !(Date.parse(item.nextRunAt) > now.getTime()))
      item.nextRunAt = nextRunAfter(item.rule, now).toISOString();
    item.enabled = enabled;
    this.#save();
    return item;
  }

  remove(id: string): boolean {
    const existed = this.#items.some((item) => item.id === id);
    if (!existed) return false;
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#save();
    return true;
  }

  /**
   * 触发的那一刻（或者因为上一次还没跑完而跳过这个时刻时）：把 nextRunAt 推到 now 之后的下一次并落盘，
   * 错过的周期整体跳过。在开跑之前推：跑的途中每个 tick 都不会再把它当成到点，跑到一半应用崩溃，
   * 下次启动也不会把同一个时刻再跑一遍。算不出下一次时抛错，nextRunAt 原样不动。
   */
  advance(id: string, now: Date): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    item.nextRunAt = nextRunAfter(item.rule, now).toISOString();
    this.#save();
    return item;
  }

  /**
   * 一次触发结束后记下结果；nextRunAt 在触发时已经推过，这里不动。skipped 没有真的跑，
   * 只记结果，不改最后运行时间。
   */
  recordRun(id: string, outcome: ScheduleOutcome, now: Date): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    if (outcome.status !== 'skipped') item.lastRunAt = now.toISOString();
    item.lastOutcome = outcome;
    this.#save();
    return item;
  }

  /** 到点的任务：已启用且 nextRunAt 不晚于 now。按 nextRunAt 升序，先到的先跑。 */
  due(now: Date): ScheduledPrompt[] {
    return this.#items
      .filter((item) => item.enabled && Date.parse(item.nextRunAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  }

  /** 「立即运行一次」：只记结果，不挪动原定的 nextRunAt；skipped 同样不改最后运行时间。 */
  recordManualRun(id: string, outcome: ScheduleOutcome): ScheduledPrompt | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    if (outcome.status !== 'skipped') item.lastRunAt = outcome.at;
    item.lastOutcome = outcome;
    this.#save();
    return item;
  }

  /** 等所有进行中的写落盘（测试与关闭时用）。写失败已经记过日志，这里不抛。 */
  async idle(): Promise<void> {
    await this.#pending.catch(() => undefined);
  }

  /** 内部的每一次保存都走这里：写失败只记日志，不留下没人接的 rejected promise。 */
  #save(): void {
    this.#flush().catch((error: unknown) => console.error('定时任务保存失败', error));
  }

  async #flush(): Promise<void> {
    const body = JSON.stringify(this.#items, null, 2);
    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, body, { mode: 0o600 });
          await rename(tmp, this.path);
        } catch (error) {
          // 写到一半或 rename 失败：临时文件不能留在 userData 里，里面是 prompt 全文。
          await rm(tmp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    await this.#pending;
  }
}
