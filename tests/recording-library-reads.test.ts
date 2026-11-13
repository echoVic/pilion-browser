import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingLibrary } from '../src/main/recording/library';
import { project } from '../src/main/recording/project';
import type { LoggedEvent, Trajectory } from '../src/main/recording/types';

// 只数 readFile 读了哪些文件，读本身照常走真实磁盘。
const reads = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    reads.files.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const events: LoggedEvent[] = [
  {
    seq: 1,
    at: '2026-09-20T14:03:12+08:00',
    kind: 'page',
    url: 'https://report.example.com/',
    title: '报表首页',
    text: '选择月份后导出',
  },
  {
    seq: 2,
    at: '2026-09-20T14:03:20+08:00',
    kind: 'click',
    url: 'https://report.example.com/',
    index: 1,
    el: { tagName: 'button', role: 'button', name: '导出 CSV' },
    pageAt: 1000,
    target: { role: 'button', name: '导出 CSV', tagName: 'button' },
    ambiguous: false,
  },
];
const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 2, name: '临时', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: project(events).entries,
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilion-recordings-reads-'));
  reads.files.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// 日志上限是 8 MiB：每次刷新技能列表都把每份日志读两遍，几十份录制就是几百 MB 的白读。
describe('RecordingLibrary.list 读日志的次数', () => {
  it('每份录制的 events.jsonl 只读一次', async () => {
    const library = new RecordingLibrary(root);
    await library.create('月度导出', trajectory, events);
    await library.create('周报', trajectory, events);
    reads.files.length = 0;
    const rows = await library.list();
    expect(rows.map((row) => row.hasEvents)).toEqual([true, true]);
    const eventReads = reads.files.filter((file) => basename(file) === 'events.jsonl');
    expect(eventReads).toHaveLength(2);
    expect(new Set(eventReads).size).toBe(2);
  });

  it('没有日志的老录制照旧只试读一次，报 hasEvents: false', async () => {
    const library = new RecordingLibrary(root);
    await library.create('老录制', {
      ...trajectory,
      meta: { ...trajectory.meta, version: 1 },
    });
    reads.files.length = 0;
    const rows = await library.list();
    expect(rows.map((row) => row.hasEvents)).toEqual([false]);
    expect(reads.files.filter((file) => basename(file) === 'events.jsonl')).toHaveLength(1);
  });
});
