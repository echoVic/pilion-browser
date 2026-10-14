import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulesStore } from '../src/main/schedule/store.js';
import { SchedulerEngine } from '../src/main/schedule/engine.js';
import type { ScheduledPromptRunner } from '../src/main/schedule/runner.js';
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
