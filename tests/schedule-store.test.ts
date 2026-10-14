import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('最多 SCHEDULE_LIMIT 条，超出抛 ScheduleLimitError', async () => {
    const { store, dir } = await makeStore();
    for (let index = 0; index < SCHEDULE_LIMIT; index += 1)
      store.create(input(), { kind: 'user' }, new Date());
    expect(() => store.create(input(), { kind: 'user' }, new Date())).toThrow(ScheduleLimitError);
    await store.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it('recordRun 把 nextRunAt 推到下一次', async () => {
    const { store, dir } = await makeStore();
    const created = store.create(input(), { kind: 'user' }, new Date('2026-10-13T08:00:00+08:00'));
    const afterRun = store.recordRun(
      created.id,
      { status: 'ok', at: new Date('2026-10-13T09:00:00+08:00').toISOString() },
      new Date('2026-10-13T09:00:00+08:00'),
    );
    // 09:00 之后的下一次 daily 09:00 是明天。
    expect(new Date(afterRun!.nextRunAt).getDate()).toBe(14);
    await store.idle();
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
