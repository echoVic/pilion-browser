import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RecordingLibrary,
  project,
  serializeEvents,
  serializeTrajectory,
  slugify,
  type LoggedEvent,
  type Skill,
  type Trajectory,
} from '../src/main/recording/index';

const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    {
      kind: 'step',
      at: '2026-09-20T14:03:20+08:00',
      step: { kind: 'navigate', url: 'https://report.example.com/' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:31+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/', reason: '填写密码' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:40+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/', reason: '拖拽 "滑块"' },
      unsupported: 'gesture',
    },
  ],
};

const pageEvent: LoggedEvent = {
  seq: 1,
  at: '2026-09-20T14:03:12+08:00',
  kind: 'page',
  url: 'https://report.example.com/',
  title: '报表首页',
  text: '选择月份后导出',
};
const clickEvent: LoggedEvent = {
  seq: 2,
  at: '2026-09-20T14:03:20+08:00',
  kind: 'click',
  url: 'https://report.example.com/',
  index: 1,
  el: { tagName: 'button', role: 'button', name: '导出 CSV' },
  pageAt: 1000,
  target: { role: 'button', name: '导出 CSV', tagName: 'button' },
  ambiguous: false,
};
/** 与 clickEvent 序号不同，重算后必然落成独立的第二个步骤，不会被双击折叠掉。 */
const extraClickEvent: LoggedEvent = {
  seq: 3,
  at: '2026-09-20T14:03:25+08:00',
  kind: 'click',
  url: 'https://report.example.com/',
  index: 2,
  el: { tagName: 'button', role: 'button', name: '确认' },
  pageAt: 2000,
  target: { role: 'button', name: '确认', tagName: 'button' },
  ambiguous: false,
};
const events: LoggedEvent[] = [pageEvent, clickEvent];

/** create() 会按 events 重算 meta.source，这里只需要 entries 与 project() 的结果一致。 */
function trajectoryOf(list: readonly LoggedEvent[]): Trajectory {
  return {
    meta: { app: 'pilion', version: 2, name: '临时', recordedAt: '2026-09-20T14:03:11+08:00' },
    entries: project(list).entries,
  };
}

const v1Trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '老录制', recordedAt: '2026-09-18T09:00:00+08:00' },
  entries: [
    {
      kind: 'step',
      at: '2026-09-18T09:00:05+08:00',
      step: { kind: 'navigate', url: 'https://old.example.com/' },
    },
  ],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilion-recordings-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('slugify', () => {
  it('保留中文，空白变连字符，去掉路径字符', () => {
    expect(slugify('月度 导出 / 2026')).toBe('月度-导出-2026');
    expect(slugify('  Export   CSV  ')).toBe('export-csv');
    expect(slugify('../../etc')).toBe('etc');
    expect(slugify('!!!')).toBe('recording');
  });
});

describe('RecordingLibrary', () => {
  it('create 后能 list、read，文件是 0600 且在自己的目录里', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    expect(id).toBe('月度导出');
    expect(await library.list()).toEqual([
      {
        id: '月度导出',
        name: '月度导出',
        steps: 3,
        unsupported: 1,
        needsHuman: 2,
        recordedAt: '2026-09-20T14:03:11+08:00',
        distilled: false,
        hasEvents: false,
      },
    ]);
    const loaded = await library.read(id);
    expect(loaded.trajectory).toEqual(trajectory);
    expect(loaded.markdown).toContain('```json pilion-trajectory');
    const mode = (await stat(join(root, id, 'trajectory.md'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('同名再建时 id 加序号', async () => {
    const library = new RecordingLibrary(root);
    await library.create('月度导出', trajectory);
    expect(await library.create('月度导出', trajectory)).toBe('月度导出-2');
    expect(await library.create('月度导出', trajectory)).toBe('月度导出-3');
  });

  it('rename 只改名字不改 id，remove 删掉整个目录', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('旧名', trajectory);
    await library.rename(id, '新名');
    expect((await library.read(id)).trajectory.meta.name).toBe('新名');
    expect((await library.list())[0]).toMatchObject({ id: '旧名', name: '新名' });
    await library.remove(id);
    expect(await library.list()).toEqual([]);
  });

  it('坏文件在 list 里带 error 而不是让整个列表失败', async () => {
    const library = new RecordingLibrary(root);
    await library.create('好的', trajectory);
    await library.write('好的', trajectory);
    await writeFile(join(root, '好的', 'trajectory.md'), '# 手改坏了\n没有代码块\n');
    const rows = await library.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '好的',
      error: expect.stringContaining('pilion-trajectory'),
    });
    await expect(library.read('好的')).rejects.toThrow(/pilion-trajectory/);
  });

  it('拒绝带路径分隔或点点的 id', async () => {
    const library = new RecordingLibrary(root);
    await expect(library.read('../x')).rejects.toThrow(/id/);
    await expect(library.remove('a/b')).rejects.toThrow(/id/);
    await expect(library.rename('..', 'x')).rejects.toThrow(/id/);
  });

  it('write 走临时文件再 rename，目录里不留 tmp', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('x', trajectory);
    await library.write(id, trajectory);
    const md = await readFile(join(root, id, 'trajectory.md'), 'utf8');
    expect(md).toContain('"name": "月度导出"');
    await expect(stat(join(root, id, 'trajectory.md.tmp'))).rejects.toThrow();
  });

  it('并发 create 同名时仍得到不同的 id，互不覆盖', async () => {
    const library = new RecordingLibrary(root);
    const ids = await Promise.all([
      library.create('同名', trajectory),
      library.create('同名', trajectory),
      library.create('同名', trajectory),
    ]);
    expect([...ids].sort()).toEqual(['同名', '同名-2', '同名-3']);
    expect((await library.list()).map((row) => row.id).sort()).toEqual([
      '同名',
      '同名-2',
      '同名-3',
    ]);
  });
});

describe('RecordingLibrary 事件日志', () => {
  it('create 同时落下轨迹与日志，摘要标出有过程记录', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    expect(await readFile(library.eventsPath(id), 'utf8')).toContain('"kind":"click"');
    expect((await library.list())[0].hasEvents).toBe(true);
    const mode = (await stat(library.eventsPath(id))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('日志被改过时按日志重算轨迹并改写文件', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    const first = await library.read(id);
    expect(first.recomputed).toBe(true);
    expect(first.trajectory.entries.filter((e) => e.kind === 'step')).toHaveLength(2);
    // 改写已经落盘：第二次读不再重算
    expect((await library.read(id)).recomputed).toBe(false);
  });

  it('手工改过的轨迹步骤在重算时被覆盖', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    const tampered = { ...trajectoryOf(events), entries: [] };
    await writeFile(library.path(id), serializeTrajectory(tampered));
    const { trajectory, recomputed } = await library.read(id);
    expect(recomputed).toBe(true);
    expect(trajectory.entries.length).toBeGreaterThan(0);
  });

  it('第一期的老录制没有日志，照常读出，不重算', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('老录制', v1Trajectory); // 不传 events
    const { trajectory, recomputed } = await library.read(id);
    expect(recomputed).toBe(false);
    expect(trajectory.meta.version).toBe(1);
    expect((await library.list())[0].hasEvents).toBe(false);
  });

  it('rename 时若轨迹落后于日志，会先自愈重算再改名，且不卡住写队列', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    // 只改日志，不改轨迹：trajectory.md 里的 source.hash 就会跟日志对不上。
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    // rename 内部会调用 read()，如果 read() 的自愈改写又去抢同一条写队列会死锁；
    // 这个测试就是为了钉住「不会死锁」。
    await library.rename(id, '新名');
    const { trajectory } = await library.read(id);
    expect(trajectory.meta.name).toBe('新名');
    expect(trajectory.entries.filter((e) => e.kind === 'step')).toHaveLength(2);
  });

  it('自愈改写不占队列，跟排队的 write 撞在同一个 id 上时谁都不该因为撞车而失败', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    // 循环几轮，每轮都往日志里追加一个内容不同的 scroll 事件（scroll 不产出步骤，
    // 只用来保证这一轮日志的哈希是全新的），确保每轮的 read() 都真的会走到
    // 不排队的自愈改写分支，而不是偶然命中上一轮已经写好的状态。
    // read() 的自愈改写与这里并发的 write() 因此会抢着给同一个 id 的
    // trajectory.md 做「写临时文件、rename」；旧实现用的是固定的 .tmp 名字，
    // 输的一方 rename 时会因为文件已经被对方 rename 走而报 ENOENT。
    for (let round = 0; round < 10; round += 1) {
      const dirtiedLog: LoggedEvent[] = [
        ...events,
        {
          seq: 100 + round,
          at: '2026-09-20T14:03:30+08:00',
          kind: 'scroll',
          url: 'https://report.example.com/',
          x: 0,
          y: round,
        },
      ];
      await writeFile(library.eventsPath(id), serializeEvents(dirtiedLog));
      await expect(
        Promise.all([library.read(id), library.write(id, trajectoryOf(events))]),
      ).resolves.toBeDefined();
    }
  });
});

const skill: Skill = {
  meta: {
    app: 'pilion',
    version: 1,
    kind: 'skill',
    name: '月度导出',
    about: '登录后选月份并导出 CSV',
    recordedAt: '2026-09-20T14:03:11+08:00',
    distilledBy: 'claude-code',
    trajectory: 'trajectory.md',
  },
  steps: [
    { kind: 'navigate', url: 'https://report.example.com/' },
    { kind: 'human', onUrl: 'https://report.example.com/', reason: '填写密码' },
  ],
};

describe('RecordingLibrary skills', () => {
  it('没有 skill.md 时 hasSkill 为 false，summary 标 distilled=false', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    expect(await library.hasSkill(id)).toBe(false);
    expect((await library.list())[0]).toMatchObject({ id, distilled: false, steps: 3 });
  });

  it('writeSkill 后 hasSkill 为 true，readSkill 往返，summary 的计数与 about 取自技能', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await library.writeSkill(id, '# 月度导出\n\n## 什么时候用\n\n月初。', skill);
    expect(await library.hasSkill(id)).toBe(true);
    const loaded = await library.readSkill(id);
    expect(loaded.skill).toEqual(skill);
    expect(loaded.prose).toBe('# 月度导出\n\n## 什么时候用\n\n月初。');
    expect(loaded.markdown).toContain('```json pilion-skill');
    expect((await library.list())[0]).toMatchObject({
      id,
      distilled: true,
      about: '登录后选月份并导出 CSV',
      steps: 2,
      needsHuman: 1,
    });
    const mode = (await stat(join(root, id, 'skill.md'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('坏的 skill.md 让 summary 带 error 且 distilled=false，轨迹仍可读', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await writeFile(join(root, id, 'skill.md'), '# 手改坏了\n没有代码块\n');
    const [row] = await library.list();
    expect(row).toMatchObject({
      id,
      name: '月度导出',
      steps: 3,
      needsHuman: 2,
      recordedAt: '2026-09-20T14:03:11+08:00',
      distilled: false,
      error: expect.stringContaining('pilion-skill'),
    });
    expect((await library.read(id)).trajectory).toEqual(trajectory);
  });

  it('rename 同时改掉技能里的名字', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('旧名', trajectory);
    await library.writeSkill(id, '', skill);
    await library.rename(id, '新名');
    expect((await library.readSkill(id)).skill.meta.name).toBe('新名');
    expect((await library.read(id)).trajectory.meta.name).toBe('新名');
    expect((await library.list())[0]).toMatchObject({ id, name: '新名', distilled: true });
  });

  it('remove 连 skill.md 一起删', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await library.writeSkill(id, '', skill);
    await library.remove(id);
    expect(await library.list()).toEqual([]);
  });
});
