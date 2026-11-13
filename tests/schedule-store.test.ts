import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulesStore, ScheduleLimitError } from '../src/main/schedule/store.js';
import { SCHEDULE_LIMIT, ScheduleInputSchema } from '../src/shared/schedule.js';

const PREV_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  process.env.TZ = PREV_TZ;
});

async function makeStore(): Promise<{ store: SchedulesStore; path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pilion-schedule-'));
  const path = join(dir, 'schedules.json');
  const store = new SchedulesStore(path);
  await store.load();
  return { store, path, dir };
}

const input = (rule: Record<string, unknown> = { kind: 'daily', time: '09:00' }) =>
  ScheduleInputSchema.parse({
    name: '晨间汇总',
    agentId: 'agent-1',
    prompt: '汇报今天的日程',
    rule,
  });

describe('SchedulesStore 持久化', () => {
  it('原子写入且权限 0600，不留临时文件', async () => {
    const { store, path, dir } = await makeStore();
    store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    // 等原子写真正落盘，不靠固定 sleep——并行跑全套件时 20ms 不够。
    await store.idle();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].nextRunAt).toBeTruthy();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('重新加载后能还原，nextRunAt 为本地墙上时钟', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-schedule-'));
    const path = join(dir, 'schedules.json');
    const first = new SchedulesStore(path);
    await first.load();
    first.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    await first.idle();
    const second = new SchedulesStore(path);
    await second.load();
    expect(second.items).toHaveLength(1);
    // daily 09:00，after 08:00 -> 当天 09:00。
    expect(new Date(second.items[0].nextRunAt).getHours()).toBe(9);
    await second.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('坏文件退回空列表而不是崩', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-schedule-'));
    const path = join(dir, 'schedules.json');
    const store = new SchedulesStore(path);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.items).toHaveLength(0);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('一条读不懂的任务只跳过它自己，别的照常加载，原文件留底', async () => {
    const { store, path, dir } = await makeStore();
    store.create(input(), { kind: 'user' }, new Date('2026-10-13T09:30:00+08:00'));
    store.create(
      input({ kind: 'cron', expr: '0 9 * * 1' }),
      { kind: 'user' },
      new Date('2026-10-13T09:30:00+08:00'),
    );
    await store.idle();
    const saved = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
    // 旧版本接受、现在判为永远不会到来的日期（2 月 30 日），外加一条新版本才有的字段。
    const original = JSON.stringify([
      { ...saved[0], id: 'impossible', rule: { kind: 'cron', expr: '0 0 30 2 *' } },
      saved[1],
      { ...saved[1], id: 'from-newer-build', somethingNew: true },
    ]);
    await writeFile(path, original);

    const reloaded = new SchedulesStore(path);
    const errors: unknown[][] = [];
    const logged = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await reloaded.load();
    } finally {
      console.error = logged;
    }
    expect(reloaded.items.map((item) => item.id)).toEqual([saved[1]!.id]);
    expect(await readFile(`${path}.unreadable`, 'utf8')).toBe(original);
    expect(String(errors[0]?.[0])).toContain('2 处无法读取');
    await rm(dir, { recursive: true, force: true });
  });

  it('加载时纠正不属于规则的 nextRunAt（旧版本忽略 cron 月份留下的），合法的保持原样', async () => {
    const { store, path, dir } = await makeStore();
    const now = new Date('2026-10-13T09:30:00+08:00');
    store.create(input({ kind: 'cron', expr: '0 9 1 6 *' }), { kind: 'user' }, now);
    store.create(input({ kind: 'cron', expr: '0 9 * * 1' }), { kind: 'user' }, now);
    await store.idle();
    const saved = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
    const yearly = saved.find((item) => (item.rule as { expr: string }).expr === '0 9 1 6 *')!;
    const weekly = saved.find((item) => (item.rule as { expr: string }).expr === '0 9 * * 1')!;
    // 旧版本会把「每年 6 月 1 日」算成下个月 1 日，而且这个时刻已经过了（应用当时没开）。
    yearly.nextRunAt = new Date('2026-11-01T09:00:00+08:00').toISOString();
    // 再加一条时间戳写坏的每日任务：读不出时刻的条目也要重新算，而不是永远不触发。
    const broken = {
      ...weekly,
      id: 'broken-time',
      rule: { kind: 'daily', time: '09:00' },
      nextRunAt: 'not a date',
    };
    await writeFile(path, JSON.stringify([...saved, broken]));

    const reloaded = new SchedulesStore(path);
    const later = new Date('2026-11-02T10:00:00+08:00');
    await reloaded.load(later);
    expect(reloaded.get(String(yearly.id))?.nextRunAt).toBe(
      new Date('2027-06-01T09:00:00+08:00').toISOString(),
    );
    expect(reloaded.get('broken-time')?.nextRunAt).toBe(
      new Date('2026-11-03T09:00:00+08:00').toISOString(),
    );
    // 没有到点的任务：不会按错的时刻补跑。
    expect(reloaded.due(later).map((item) => item.id)).toEqual([weekly.id]);
    // 合法但已错过的时刻原样保留，照旧由启动补跑一次。
    expect(reloaded.get(String(weekly.id))?.nextRunAt).toBe(weekly.nextRunAt);
    await reloaded.idle();
    expect(
      (JSON.parse(await readFile(path, 'utf8')) as Array<{ id: string; nextRunAt: string }>).find(
        (item) => item.id === yearly.id,
      )?.nextRunAt,
    ).toBe(new Date('2027-06-01T09:00:00+08:00').toISOString());
    await rm(dir, { recursive: true, force: true });
  });

  it('最多 SCHEDULE_LIMIT 条，超出抛 ScheduleLimitError', async () => {
    const { store, dir } = await makeStore();
    for (let index = 0; index < SCHEDULE_LIMIT; index += 1)
      store.create(input(), { kind: 'user' }, new Date());
    expect(() => store.create(input(), { kind: 'user' }, new Date())).toThrow(ScheduleLimitError);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('advance 把 nextRunAt 推到下一次，recordRun 只记结果', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    const fired = new Date('2026-10-13T09:00:00+08:00');
    const advanced = store.advance(created.id, fired);
    // 09:00 之后的下一次 daily 09:00 是明天。
    expect(new Date(advanced!.nextRunAt).getDate()).toBe(14);
    const nextRunAt = advanced!.nextRunAt;
    // 跑完记结果时 nextRunAt 不再动：触发那一刻已经推过了。
    const afterRun = store.recordRun(
      created.id,
      { status: 'ok', at: fired.toISOString() },
      new Date('2026-10-13T09:20:00+08:00'),
    );
    expect(afterRun!.nextRunAt).toBe(nextRunAt);
    expect(afterRun!.lastRunAt).toBe(new Date('2026-10-13T09:20:00+08:00').toISOString());
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('跳过的那次只记结果，不改最后运行时间', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    const ran = new Date('2026-10-13T09:00:00+08:00');
    store.recordRun(created.id, { status: 'ok', at: ran.toISOString() }, ran);
    const skippedAt = new Date('2026-10-14T09:00:00+08:00');
    store.recordRun(
      created.id,
      { status: 'skipped', at: skippedAt.toISOString(), reason: 'capacity' },
      skippedAt,
    );
    expect(store.get(created.id)?.lastRunAt).toBe(ran.toISOString());
    expect(store.get(created.id)?.lastOutcome).toEqual({
      status: 'skipped',
      at: skippedAt.toISOString(),
      reason: 'capacity',
    });
    store.recordManualRun(created.id, {
      status: 'skipped',
      at: new Date('2026-10-14T10:00:00+08:00').toISOString(),
      reason: 'overlap',
    });
    expect(store.get(created.id)?.lastRunAt).toBe(ran.toISOString());
    expect(store.get(created.id)?.lastOutcome?.reason).toBe('overlap');
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('停用期间错过的时刻，重新启用时从现在重算，不立刻补跑', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    store.setEnabled(created.id, false, new Date('2026-10-13T08:30:00+08:00'));
    const later = new Date('2026-10-15T14:00:00+08:00');
    store.setEnabled(created.id, true, later);
    expect(store.get(created.id)?.nextRunAt).toBe(
      new Date('2026-10-16T09:00:00+08:00').toISOString(),
    );
    expect(store.due(later)).toEqual([]);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('创建时就停用的任务，过了原定时刻再启用，同样从现在重算', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(
      ScheduleInputSchema.parse({
        name: '停用创建',
        agentId: 'agent-1',
        prompt: 'p',
        rule: { kind: 'interval', every: 30, unit: 'minute' },
        enabled: false,
      }),
      { kind: 'user' },
      new Date('2026-10-13T08:00:00+08:00'),
    );
    const later = new Date('2026-10-13T11:07:00+08:00');
    store.setEnabled(created.id, true, later);
    expect(store.get(created.id)?.nextRunAt).toBe(
      new Date('2026-10-13T11:37:00+08:00').toISOString(),
    );
    expect(store.due(later)).toEqual([]);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('启用时原定时刻还没到，或者本来就是启用的，nextRunAt 都不动', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    const original = created.nextRunAt;
    store.setEnabled(created.id, false, new Date('2026-10-13T08:10:00+08:00'));
    store.setEnabled(created.id, true, new Date('2026-10-13T08:20:00+08:00'));
    expect(store.get(created.id)?.nextRunAt).toBe(original);
    // 已经启用的任务错过的时刻照旧由补跑处理，「再启用一次」不会把它抹掉。
    const later = new Date('2026-10-13T10:00:00+08:00');
    store.setEnabled(created.id, true, later);
    expect(store.get(created.id)?.nextRunAt).toBe(original);
    expect(store.due(later).map((item) => item.id)).toEqual([created.id]);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('保存失败只记日志，不留下未处理的 rejection，也不留下临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-schedule-'));
    const path = join(dir, 'schedules.json');
    // 目标位置是个目录：临时文件写得进去，rename 覆盖不了。
    await mkdir(path);
    const store = new SchedulesStore(path);
    const errors: unknown[][] = [];
    const logged = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
      await expect(store.idle()).resolves.toBeUndefined();
      // 失败的那一次写已经被 #save 接住并记下日志。
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = logged;
    }
    expect(String(errors[0]?.[0])).toContain('定时任务保存失败');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('定时任务权限模式', () => {
  it('创建时缺省 permissionMode 落为 ask', async () => {
    const { store } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date());
    expect(created.permissionMode).toBe('ask');
  });

  it('人在设置页显式选 full 时按 full 保存', async () => {
    const { store } = await makeStore();
    const created = store.create(
      ScheduleInputSchema.parse({
        name: 'X',
        agentId: 'agent-1',
        prompt: 'p',
        rule: { kind: 'daily', time: '09:00' },
        permissionMode: 'full',
      }),
      { kind: 'user' },
      new Date(),
    );
    expect(created.permissionMode).toBe('full');
  });

  it('旧数据（没有 permissionMode 字段）加载时迁移为 ask', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-legacy-'));
    const path = join(dir, 'schedules.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'old-1',
          name: '旧任务',
          agentId: 'agent-1',
          prompt: 'p',
          rule: { kind: 'daily', time: '09:00' },
          enabled: true,
          origin: { kind: 'user' },
          createdAt: '2026-01-01T00:00:00Z',
          nextRunAt: '2026-10-14T09:00:00+08:00',
        },
      ]),
    );
    const store = new SchedulesStore(path);
    await store.load();
    expect(store.items[0]?.permissionMode).toBe('ask');
    await rm(dir, { recursive: true, force: true });
  });
});
