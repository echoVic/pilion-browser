import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLocalFile,
  decodeLocalHref,
  localFileAction,
  resolveLocalFilePath,
} from '../src/main/local-file.js';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'pilion-file-'));
  await writeFile(join(root, 'report.md'), '# hi');
  await mkdir(join(root, 'folder'));
  return root;
}

describe('local file links', () => {
  it('decodes file:// hrefs, including percent escapes', () => {
    expect(decodeLocalHref('file:///Users/me/my%20report.md')).toBe('/Users/me/my report.md');
    expect(decodeLocalHref('/tmp/plain.md')).toBe('/tmp/plain.md');
  });

  it('resolves relative paths against the agent cwd first, then falls back', async () => {
    const root = await workspace();
    expect(resolveLocalFilePath('report.md', [root, '/nowhere'])).toBe(join(root, 'report.md'));
    expect(resolveLocalFilePath('./report.md', [root])).toBe(join(root, 'report.md'));
    // 都找不到时落在第一个候选目录下，报错路径才具体。
    expect(resolveLocalFilePath('missing.md', [root, '/nowhere'])).toBe(join(root, 'missing.md'));
    expect(resolveLocalFilePath('/tmp/absolute.md', [root])).toBe('/tmp/absolute.md');
  });

  it('opens documents but only reveals everything else', () => {
    for (const path of ['a.md', '/x/report.pdf', 'shot.PNG', 'data.json', 'sheet.xlsx'])
      expect(localFileAction(path)).toBe('open');
    for (const path of ['installer.app', 'run.command', 'x.sh', 'noextension', 'bomb.exe'])
      expect(localFileAction(path)).toBe('reveal');
  });

  it('rejects directories and missing paths', async () => {
    const root = await workspace();
    expect(assertLocalFile(join(root, 'report.md'))).toEqual({ bytes: 4 });
    expect(() => assertLocalFile(join(root, 'folder'))).toThrow(/不是一个文件/);
    expect(() => assertLocalFile(join(root, 'missing.md'))).toThrow(/文件不存在/);
  });
});
