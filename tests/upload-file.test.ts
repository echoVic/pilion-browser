import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/main/browser/errors.js';
import { requireUploadPath, uploadFileAuditEntry } from '../src/main/browser/upload-file.js';

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
