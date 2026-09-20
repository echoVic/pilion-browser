import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingLibrary, slugify, type Trajectory } from '../src/main/recording/index';

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
});
