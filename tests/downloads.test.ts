import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  assertDownloadDirectory,
  downloadLocation,
  isDownloadPathAllowed,
} from '../src/main/downloads';

it('allows only the system or current custom download directory and the recorded filename', () => {
  const allowed = (savePath: string, filename = 'file.txt', custom = '/custom') =>
    isDownloadPathAllowed({ savePath, filename }, '/Downloads/', custom);
  expect(allowed('/Downloads/file.txt')).toBe(true);
  expect(allowed('/custom/file.txt', 'file.txt', '/custom/')).toBe(true);
  expect(allowed('/custom/file.txt', 'different.txt')).toBe(false);
  expect(allowed('/custom/file.txt', '../file.txt')).toBe(false);
  expect(allowed('/old/file.txt')).toBe(false);
  expect(allowed('/Downloads-sibling/file.txt')).toBe(false);
  expect(allowed('/Downloads/../outside/file.txt')).toBe(false);
  expect(allowed('/Downloads/nested/../file.txt')).toBe(false);
  expect(allowed('/custom/../custom/file.txt')).toBe(false);
  expect(allowed('/Downloads/file.txt/')).toBe(false);
  expect(allowed('/custom/nested/file.txt')).toBe(false);
  expect(allowed('Downloads/file.txt')).toBe(false);
  expect(
    isDownloadPathAllowed({ savePath: '/custom/file.txt', filename: 'file.txt' }, '/Downloads'),
  ).toBe(false);
});

it('shortens only the home directory boundary in the displayed download location', () => {
  expect(downloadLocation('/home/q/Downloads', '/home/q')).toBe('~/Downloads');
  expect(downloadLocation('/home/q', '/home/q')).toBe('~');
  expect(downloadLocation('/home/q-other/Downloads', '/home/q')).toBe('/home/q-other/Downloads');
});

it('rejects missing folders and files while accepting a writable directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilion-downloads-'));
  try {
    expect(() => assertDownloadDirectory(dir)).not.toThrow();
    expect(() => assertDownloadDirectory(join(dir, 'missing'))).toThrow(
      '下载位置必须是可写的文件夹',
    );
    const file = join(dir, 'file');
    await writeFile(file, 'test');
    expect(() => assertDownloadDirectory(file)).toThrow('下载位置必须是可写的文件夹');
    expect(() => assertDownloadDirectory('relative')).toThrow('下载位置必须是可写的文件夹');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
