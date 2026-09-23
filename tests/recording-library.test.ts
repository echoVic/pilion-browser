import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('只手改 entries、不碰日志也不碰 meta 时，重算仍能发现并覆盖', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    // 只换 entries，meta（含 source 的两个哈希）原样留着：这才是手改这个文件最常见的
    // 样子——在编辑器里删掉步骤块的内容，谁也不会顺手去改旁边看不出规律的哈希。
    // 日志哈希单独查不出这种改动，因为改 entries 从不触碰 events.jsonl。
    const { trajectory: written } = await library.read(id);
    const tampered = { ...written, entries: [] };
    await writeFile(library.path(id), serializeTrajectory(tampered));
    const { trajectory, recomputed } = await library.read(id);
    expect(recomputed).toBe(true);
    expect(trajectory.entries.length).toBeGreaterThan(0);
  });

  it('列表把这一次重算报出来，此后没人看过之前，list() 一直报', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    // 手改触发的重算，第一次 list() 就报出来。
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBe(true);
    // 新建另一份、给另一份改名：两个动作都不碰这份录制，只是让 list() 再跑一遍，
    // 跑的过程里这份录制自己也会被 read() 一次，但那一次早就没有什么可重算的了。
    const other = await library.create('另一份', trajectoryOf(events));
    await library.rename(other, '另一份改名');
    // 再列两次，提示原地不动，跟这两次列表有没有真的发生重算无关。
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBe(true);
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBe(true);
  });

  it('acknowledgeRecompute 确认之后 list() 不再报；确认一个不存在的 id 什么也不做', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    const other = await library.create('另一份', trajectoryOf(events));
    await library.list(); // 触发一次重算，把 id 放进待告知集合。
    expect(library.acknowledgeRecompute(id)).toBe(true);
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBeUndefined();
    // 确认过的只有这一份，没被动过的那一份不受影响（原本就没有提示可报）。
    expect((await library.list()).find((row) => row.id === other)?.recomputed).toBeUndefined();
    // 不存在的 id：不抛错，也不会误伤其它行。
    expect(library.acknowledgeRecompute('没有这个-id')).toBe(false);
  });

  it('确认过之后如果又被重算一次，list() 会重新报，不是确认过就永远不报了', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    await library.list(); // 第一次重算，放进待告知集合。
    expect(library.acknowledgeRecompute(id)).toBe(true);
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBeUndefined();
    // 再手改一次日志：scroll 不产出步骤，只用来让这一次的日志哈希跟刚刚重算落盘的不一样，
    // 逼出第二次真的重算，而不是偶然命中上一次已经写好的状态。
    await writeFile(
      library.eventsPath(id),
      serializeEvents([
        ...events,
        extraClickEvent,
        {
          seq: 100,
          at: '2026-09-20T14:03:30+08:00',
          kind: 'scroll',
          url: 'https://report.example.com/',
          x: 0,
          y: 1,
        },
      ]),
    );
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBe(true);
  });

  it('删掉一份还没看过重算提示的录制，再用同一个名字录一份：新的那份不带提示', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBe(true);
    await library.remove(id);
    // 删掉之后目录名空了出来，同名再建拿到的是同一个 id。
    expect(await library.create('月度导出', trajectoryOf(events), events)).toBe(id);
    expect((await library.list()).find((row) => row.id === id)?.recomputed).toBeUndefined();
  });

  it('没人碰过的录制，哪怕读两遍也不会被当成需要重算', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    // create() 落盘时就该把两个哈希算对；不需要经过一轮「重算再自愈」才达到一致。
    const first = await library.read(id);
    expect(first.recomputed).toBe(false);
    const second = await library.read(id);
    expect(second.recomputed).toBe(false);
    expect(second.trajectory).toEqual(first.trajectory);
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

  it('events.jsonl 变成目录时，read() 用中文说明拒绝，list() 显示带原因的错误行', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('坏日志', trajectory); // 先当老录制建，本来没有日志文件
    await mkdir(library.eventsPath(id)); // 把本该是文件的路径换成目录
    await expect(library.read(id)).rejects.toThrow(/读不出过程记录/);
    const rows = await library.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, error: expect.stringContaining('读不出过程记录') });
  });

  it('日志文件确实不存在时不受影响，仍按老录制读出、不报错（跟上一条对照）', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('没有日志', v1Trajectory);
    const { recomputed } = await library.read(id);
    expect(recomputed).toBe(false);
    const [row] = await library.list();
    expect(row.error).toBeUndefined();
  });

  it('requireEvents 在日志缺失时抛出中文错误，日志存在时照常返回', async () => {
    const library = new RecordingLibrary(root);
    const missing = await library.create('老录制', v1Trajectory);
    await expect(library.requireEvents(missing)).rejects.toThrow(
      /找不到这份录制的过程记录，文件可能已被删除或移走/,
    );
    const withLog = await library.create('新录制', trajectoryOf(events), events);
    expect(await library.requireEvents(withLog)).toEqual(events);
  });

  it('requireEvents 遇到读不出的日志时，报的是具体原因而不是「找不到」', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('坏日志', trajectory);
    await mkdir(library.eventsPath(id));
    await expect(library.requireEvents(id)).rejects.toThrow(/读不出过程记录/);
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

describe('RecordingLibrary 清扫临时文件', () => {
  it('清掉早于阈值的 .tmp，保留新鲜的 .tmp，正式文件（含 skill.md）一个不碰', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    await library.writeSkill(id, '', skill);
    const staleTemp = join(root, id, 'trajectory.md.111.aaa.tmp');
    await writeFile(staleTemp, '崩溃前写了一半');
    // 拿「未来」的十一分钟后当清扫时刻，不用真的等：这份 .tmp 此刻的 mtime 就是刚才写下的
    // 那一秒，十一分钟后再看就早于十分钟的阈值了。
    const future = Date.now() + 11 * 60_000;
    await library.sweepStaleTempFiles(future);
    await expect(stat(staleTemp)).rejects.toThrow();
    // trajectory.md、events.jsonl、skill.md 此刻按 future 算也「早于阈值」，
    // 但后缀不是 .tmp——清扫只认后缀，不该把非 .tmp 文件也按年龄算进去，一个字节都不能少。
    expect(await readFile(library.path(id), 'utf8')).toContain('pilion-trajectory');
    expect(await readFile(library.eventsPath(id), 'utf8')).toContain('"kind":"click"');
    expect(await readFile(library.skillPath(id), 'utf8')).toContain('pilion-skill');

    const freshTemp = join(root, id, 'trajectory.md.222.bbb.tmp');
    await writeFile(freshTemp, '正在写');
    await library.sweepStaleTempFiles(); // 不传 now：用真实的「现在」，freshTemp 才刚写下
    await expect(stat(freshTemp)).resolves.toBeDefined();
  });

  it('目录或符号链接哪怕叫 .tmp 也不当文件删，不会被顺着链接追下去删掉目标', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectoryOf(events), events);
    const dirLikeTemp = join(root, id, 'weird-dir.tmp');
    await mkdir(dirLikeTemp);
    await writeFile(join(dirLikeTemp, 'inside.txt'), '不该被碰');
    const linkTemp = join(root, id, 'weird-link.tmp');
    await symlink(library.path(id), linkTemp); // 指向真正的 trajectory.md
    const future = Date.now() + 11 * 60_000;
    await library.sweepStaleTempFiles(future);
    expect(await readFile(join(dirLikeTemp, 'inside.txt'), 'utf8')).toBe('不该被碰');
    expect((await lstat(linkTemp)).isSymbolicLink()).toBe(true);
    expect(await readFile(library.path(id), 'utf8')).toContain('pilion-trajectory'); // 链接目标毫发无损
  });

  it('根目录不存在时什么也不做，不抛错', async () => {
    const missingRoot = join(root, '还没建过');
    await expect(new RecordingLibrary(missingRoot).sweepStaleTempFiles()).resolves.toBeUndefined();
  });
});
