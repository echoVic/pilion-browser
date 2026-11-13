import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SchedulesStore } from '../src/main/schedule/store.js';
import { SchedulerEngine } from '../src/main/schedule/engine.js';
import type { ScheduledPromptOutcome, ScheduledPromptRunner } from '../src/main/schedule/runner.js';
import type { ScheduleInput } from '../src/shared/schedule.js';

const PREV_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  process.env.TZ = PREV_TZ;
});

interface FakeRunner extends ScheduledPromptRunner {
  calls: { conversationTitle: string; scheduleId: string }[];
  runningIds: Set<string>;
}

function fakeRunner(result: 'ok' | 'busy' = 'ok'): FakeRunner {
  return {
    calls: [],
    runningIds: new Set(),
    async run(input) {
      this.calls.push({ conversationTitle: input.conversationTitle, scheduleId: input.scheduleId });
      if (result === 'busy') return { status: 'skipped', reason: 'busy' };
      return { status: 'ok', conversationId: 'conv-' + input.scheduleId };
    },
    isRunning(id) {
      return this.runningIds.has(id);
    },
  };
}

async function setup(now?: () => Date) {
  const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-engine-'));
  const store = new SchedulesStore(join(dir, 'schedules.json'));
  await store.load();
  const events: { type: string; id: string }[] = [];
  const notifications: { title: string; body: string }[] = [];
  const runner = fakeRunner();
  const engine = new SchedulerEngine({
    store,
    runner,
    recordEvent: (type, id) => events.push({ type, id }),
    notify: (title, body) => notifications.push({ title, body }),
    tickMs: 60_000,
    ...(now ? { now } : {}),
  });
  return { engine, store, runner, events, notifications, dir };
}

const daily = (time: string): ScheduleInput => ({
  name: '任务',
  agentId: 'agent-1',
  prompt: '跑一下',
  rule: { kind: 'daily', time },
  enabled: true,
});

describe('SchedulerEngine', () => {
  it('到点就触发一次，写审计并发通知', async () => {
    const { engine, store, runner, events, notifications, dir } = await setup();
    const now = new Date('2026-10-13T09:30:00+08:00');
    const item = store.create(daily('09:00'), { kind: 'user' }, now);
    item.nextRunAt = new Date('2026-10-13T09:00:00+08:00').toISOString();
    await engine.tick('tick');
    expect(runner.calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain('schedule.completed');
    expect(notifications).toHaveLength(1);
    expect(new Date(store.get(item.id)!.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('同一任务还在跑就跳过本次', async () => {
    const { engine, store, runner, events, dir } = await setup();
    const item = store.create(daily('09:00'), { kind: 'user' }, new Date());
    runner.runningIds.add(item.id);
    item.nextRunAt = new Date('2026-10-13T09:00:00+08:00').toISOString();
    await engine.tick('tick');
    expect(runner.calls).toHaveLength(0);
    expect(events.some((event) => event.type === 'schedule.skipped' && event.id === item.id)).toBe(
      true,
    );
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('错过多个周期只补跑一次，然后跳到下一个未来时刻', async () => {
    // 引擎时钟也钉在这个时刻，否则 nextRunAt 按真实墙上时钟推算，跨天后这个日期断言就会漂移。
    const now = new Date('2026-10-13T10:00:00+08:00');
    const { engine, store, runner, dir } = await setup(() => now);
    const item = store.create(
      daily('08:00'),
      { kind: 'user' },
      new Date('2026-10-01T08:00:00+08:00'),
    );
    item.nextRunAt = new Date('2026-10-02T08:00:00+08:00').toISOString();
    await engine.tick('startup');
    expect(runner.calls).toHaveLength(1);
    const next = new Date(store.get(item.id)!.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getHours()).toBe(8);
    expect(next.getDate()).toBe(14);
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('resume 也会补跑', async () => {
    const { engine, store, runner, dir } = await setup();
    const item = store.create(daily('08:00'), { kind: 'user' }, new Date());
    item.nextRunAt = new Date('2026-10-13T08:00:00+08:00').toISOString();
    engine.onResume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner.calls).toHaveLength(1);
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('runner 返回 busy 记 skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-busy-'));
    const store = new SchedulesStore(join(dir, 's.json'));
    await store.load();
    const runner = fakeRunner('busy');
    const engine = new SchedulerEngine({
      store,
      runner,
      recordEvent: () => undefined,
      notify: () => undefined,
    });
    const item = store.create(daily('08:00'), { kind: 'user' }, new Date());
    item.nextRunAt = new Date('2026-10-13T08:00:00+08:00').toISOString();
    await engine.tick('tick');
    expect(store.get(item.id)!.lastOutcome!.status).toBe('skipped');
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('两个不同任务到点都并行触发，重叠跳过只作用于还在跑的那个任务', async () => {
    const { engine, store, runner, events, dir } = await setup();
    const a = store.create(daily('09:00'), { kind: 'user' }, new Date());
    const b = store.create(daily('09:00'), { kind: 'user' }, new Date());
    const at = new Date('2026-10-13T09:00:00+08:00').toISOString();
    a.nextRunAt = at;
    b.nextRunAt = at;
    // 任务 A 还在跑：第二次 tick 只有 A 被 overlap 跳过，B 照常触发。
    runner.runningIds.add(a.id);
    await engine.tick('tick');
    expect(runner.calls.map((call) => call.scheduleId)).toEqual([b.id]);
    expect(events.some((event) => event.type === 'schedule.skipped' && event.id === a.id)).toBe(
      true,
    );
    expect(events.some((event) => event.id === b.id && event.type === 'schedule.completed')).toBe(
      true,
    );
    engine.stop();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SchedulerEngine 在开跑时推进 nextRunAt', () => {
  /** 时钟可拨、runner 跑到测试放行为止，审计事件按类型记下来。 */
  async function longRun(rule: ScheduleInput['rule'], createdAt: string) {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-long-'));
    const path = join(dir, 'schedules.json');
    const store = new SchedulesStore(path);
    await store.load();
    let clock = new Date(createdAt);
    let finish: (outcome: ScheduledPromptOutcome) => void = () => undefined;
    const calls: string[] = [];
    const events: { type: string; payload: unknown }[] = [];
    const engine = new SchedulerEngine({
      store,
      now: () => clock,
      runner: {
        run: (input) => {
          calls.push(input.scheduleId);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        isRunning: () => false,
      },
      recordEvent: (type, _id, payload) => events.push({ type, payload }),
      notify: () => undefined,
    });
    const item = store.create(
      { name: '长任务', agentId: 'agent-1', prompt: '跑很久', rule, enabled: true },
      { kind: 'user' },
      clock,
    );
    return {
      store,
      engine,
      item,
      calls,
      events,
      path,
      dir,
      setClock: (at: string) => (clock = new Date(at)),
      finish: (outcome: ScheduledPromptOutcome) => finish(outcome),
    };
  }

  it('开跑之前就把 nextRunAt 推过并落盘：跑的途中 tick 既不重跑也不记跳过', async () => {
    const run = await longRun({ kind: 'daily', time: '09:00' }, '2026-10-13T08:00:00+08:00');
    run.setClock('2026-10-13T09:00:00+08:00');
    const first = run.engine.tick('tick');
    await vi.waitFor(() => expect(run.calls).toHaveLength(1));
    const tomorrow = new Date('2026-10-14T09:00:00+08:00').toISOString();
    expect(run.store.get(run.item.id)?.nextRunAt).toBe(tomorrow);
    // 跑到一半崩溃：磁盘上已经是明天，下次启动不会把 09:00 再跑一遍。
    await run.store.idle();
    const saved = JSON.parse(await readFile(run.path, 'utf8')) as { nextRunAt: string }[];
    expect(saved[0]?.nextRunAt).toBe(tomorrow);
    // 跑十分钟，每 30 秒一个 tick。
    for (let second = 30; second <= 600; second += 30) {
      run.setClock(new Date(Date.parse('2026-10-13T09:00:00+08:00') + second * 1000).toISOString());
      await run.engine.tick('tick');
    }
    expect(run.calls).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'schedule.skipped')).toEqual([]);
    run.finish({ status: 'ok', conversationId: 'conv-long' });
    await first;
    expect(run.store.get(run.item.id)?.nextRunAt).toBe(tomorrow);
    expect(run.store.get(run.item.id)?.lastOutcome?.status).toBe('ok');
    await run.store.idle();
    await rm(run.dir, { recursive: true, force: true });
  });

  it('跑的途中下一个时刻又到了：这个时刻只记一次跳过，然后推到再下一次', async () => {
    const run = await longRun(
      { kind: 'interval', every: 10, unit: 'minute' },
      '2026-10-13T08:00:00+08:00',
    );
    run.setClock('2026-10-13T08:10:00+08:00');
    const first = run.engine.tick('tick');
    await vi.waitFor(() => expect(run.calls).toHaveLength(1));
    for (const at of ['08:20:00', '08:20:30', '08:21:00', '08:25:00']) {
      run.setClock(`2026-10-13T${at}+08:00`);
      await run.engine.tick('tick');
    }
    const skipped = run.events.filter((event) => event.type === 'schedule.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({ reason: 'overlap' });
    expect(run.store.get(run.item.id)?.nextRunAt).toBe(
      new Date('2026-10-13T08:30:00+08:00').toISOString(),
    );
    run.finish({ status: 'ok', conversationId: 'conv-long' });
    await first;
    expect(run.calls).toHaveLength(1);
    await run.store.idle();
    await rm(run.dir, { recursive: true, force: true });
  });

  it('runner 抛错时 nextRunAt 已经推过：下一个 tick 不会重跑同一个 prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-throw-'));
    const store = new SchedulesStore(join(dir, 's.json'));
    await store.load();
    const clock = new Date('2026-10-13T09:00:00+08:00');
    let runs = 0;
    const events: string[] = [];
    const engine = new SchedulerEngine({
      store,
      now: () => clock,
      runner: {
        run: async () => {
          runs += 1;
          throw new Error('连接断了');
        },
        isRunning: () => false,
      },
      recordEvent: (type) => events.push(type),
      notify: () => undefined,
    });
    const item = store.create(
      daily('08:00'),
      { kind: 'user' },
      new Date('2026-10-13T07:00:00+08:00'),
    );
    await engine.tick('tick');
    await engine.tick('tick');
    await engine.tick('tick');
    expect(runs).toBe(1);
    expect(events.filter((type) => type === 'schedule.failed')).toHaveLength(1);
    expect(store.get(item.id)?.lastOutcome).toMatchObject({ status: 'failed', reason: '连接断了' });
    expect(Date.parse(store.get(item.id)!.nextRunAt)).toBeGreaterThan(clock.getTime());
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('算不出下一次运行时间：不跑、停用这条任务、只记一次失败', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-broken-'));
    const store = new SchedulesStore(join(dir, 's.json'));
    await store.load();
    const clock = new Date('2026-10-13T09:00:00+08:00');
    const runner = fakeRunner();
    const events: string[] = [];
    const notifications: string[] = [];
    const engine = new SchedulerEngine({
      store,
      now: () => clock,
      runner,
      recordEvent: (type) => events.push(type),
      notify: (title) => notifications.push(title),
    });
    const item = store.create(
      daily('08:00'),
      { kind: 'user' },
      new Date('2026-10-13T07:00:00+08:00'),
    );
    // 规则在内存里坏掉（比如未来某个版本写下了这一版算不了的规则）：nextRunAfter 会抛错。
    (item as { rule: unknown }).rule = { kind: 'cron', expr: 'not a cron' };
    await engine.tick('tick');
    await engine.tick('tick');
    await engine.tick('tick');
    expect(runner.calls).toHaveLength(0);
    expect(store.get(item.id)?.enabled).toBe(false);
    expect(store.get(item.id)?.lastOutcome?.status).toBe('failed');
    expect(events).toEqual(['schedule.failed']);
    expect(notifications).toEqual(['定时任务已停用']);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('runner 返回 skipped：记结果但不改最后运行时间', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-sched-skip-'));
    const store = new SchedulesStore(join(dir, 's.json'));
    await store.load();
    const engine = new SchedulerEngine({
      store,
      now: () => new Date('2026-10-13T09:00:00+08:00'),
      runner: {
        run: async () => ({ status: 'skipped', reason: 'capacity' }),
        isRunning: () => false,
      },
      recordEvent: () => undefined,
      notify: () => undefined,
    });
    const item = store.create(
      daily('08:00'),
      { kind: 'user' },
      new Date('2026-10-13T07:00:00+08:00'),
    );
    await engine.tick('tick');
    expect(store.get(item.id)?.lastOutcome).toMatchObject({
      status: 'skipped',
      reason: 'capacity',
    });
    expect(store.get(item.id)?.lastRunAt).toBeUndefined();
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });
});
