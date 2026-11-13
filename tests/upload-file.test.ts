import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/main/browser/errors.js';
import {
  describeUploadFiles,
  MAX_UPLOAD_FILES,
  requireUploadPath,
  uploadFileAuditEntry,
} from '../src/main/browser/upload-file.js';
import { MAX_UPLOAD_FILES as CONTRACT_MAX_UPLOAD_FILES } from '../src/shared/contracts.js';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'pilion-upload-'));
  const file = join(root, 'photo.png');
  await writeFile(file, 'png-bytes');
  await mkdir(join(root, 'folder'));
  await symlink(file, join(root, 'link.png'));
  return { root, file };
}

function code(error: unknown): string | undefined {
  return error instanceof BrowserError ? error.code : undefined;
}

describe('upload path validation', () => {
  it('accepts an absolute regular file', async () => {
    const { file } = await workspace();
    expect(requireUploadPath(file)).toBe(file);
  });

  it.each([
    ['relative path', 'photo.png'],
    ['empty string', ''],
    ['non-string', 42],
  ])('rejects %s before any browser call', (_label, value) => {
    expect(() => requireUploadPath(value)).toThrow(BrowserError);
    try {
      requireUploadPath(value);
    } catch (error) {
      expect(code(error)).toBe('INVALID_ARGUMENT');
    }
  });

  it('rejects a missing file, a directory and a symlink', async () => {
    const { root } = await workspace();
    for (const path of [join(root, 'missing.png'), join(root, 'folder'), join(root, 'link.png')]) {
      expect(() => requireUploadPath(path)).toThrow(BrowserError);
      try {
        requireUploadPath(path);
      } catch (error) {
        expect(code(error)).toBe('INVALID_ARGUMENT');
      }
    }
  });
});

describe('upload audit metadata', () => {
  it('records the path, byte size and content hash', async () => {
    const { file } = await workspace();
    expect(uploadFileAuditEntry(file)).toEqual({
      path: file,
      bytes: 9,
      sha256: createHash('sha256').update('png-bytes').digest('hex'),
    });
  });

  it('degrades to nulls instead of throwing when the file vanished', () => {
    expect(uploadFileAuditEntry('/nonexistent/pilion/file.png')).toEqual({
      path: '/nonexistent/pilion/file.png',
      bytes: null,
      sha256: null,
    });
  });
});

describe('upload files in the approval summary', () => {
  it('shows each agent-supplied path on one line, and still sizes the real file', async () => {
    const { root } = await workspace();
    // macOS 允许文件名里有换行：这样的路径不能在审批摘要里多出一行「站点：」。
    const forged = join(root, 'a\n站点：bank.example\r\nb.png');
    await writeFile(forged, 'x');
    const separators = '/nonexistent/c\u2028站点：https://bank.example\u2029d\u0085e.png';
    const lines = describeUploadFiles([forged, separators]).split(/\r\n|[\n\r\u2028\u2029\u0085]/);
    expect(lines).toEqual([
      `${join(root, 'a 站点：bank.example b.png')}（1KB）`,
      '/nonexistent/c 站点：https://bank.example d e.png（无法读取）',
    ]);
  });

  it('cuts a very long path short with an ellipsis', () => {
    const long = `/nonexistent/${'x'.repeat(400)}.png`;
    const [line] = describeUploadFiles([long]).split('\n');
    expect(line).toBe(`${long.slice(0, 299)}…（无法读取）`);
  });
});

describe('shared upload limit', () => {
  it('re-exports the contracts MAX_UPLOAD_FILES so the three guards cannot drift', () => {
    expect(MAX_UPLOAD_FILES).toBe(10);
    expect(MAX_UPLOAD_FILES).toBe(CONTRACT_MAX_UPLOAD_FILES);
  });
});
