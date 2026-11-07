import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserError } from './errors.js';

/** 一次上传最多 10 个文件；单文件 200MB 上限；只有小文件算内容指纹。 */
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_HASH_BYTES = 8 * 1024 * 1024;

/**
 * 上传路径在发起任何 CDP 之前校验：绝对路径、存在、普通文件、非符号链接、未超上限。
 *
 * 这里刻意不做目录白名单：外部 Agent 本来就是同权限的本地进程，目录限制挡不住它，
 * 只会挡住合法流程；真正的边界是「路径只能来自调用参数」以及审计里留下的记录。
 */
export function requireUploadPath(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new BrowserError('INVALID_ARGUMENT', '上传路径必须是非空字符串');
  if (!isAbsolute(value))
    throw new BrowserError('INVALID_ARGUMENT', `上传路径必须是绝对路径：${value}`);
  let stat;
  try {
    stat = lstatSync(value);
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', `上传文件不存在：${value}`);
  }
  if (stat.isSymbolicLink())
    throw new BrowserError('INVALID_ARGUMENT', `上传文件不能是符号链接：${value}`);
  if (!stat.isFile())
    throw new BrowserError('INVALID_ARGUMENT', `上传路径不是普通文件：${value}`);
  if (stat.size > MAX_UPLOAD_BYTES)
    throw new BrowserError(
      'INVALID_ARGUMENT',
      `上传文件超过 ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB 上限：${value}`,
    );
  return value;
}

/** 审计用的文件元数据：谁传的、多大、小文件附内容指纹。 */
export function uploadFileAuditEntry(path: string): {
  path: string;
  bytes: number | null;
  sha256: string | null;
} {
  try {
    const stat = statSync(path);
    const sha256 =
      stat.size <= MAX_UPLOAD_HASH_BYTES
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : null;
    return { path, bytes: stat.size, sha256 };
  } catch {
    return { path, bytes: null, sha256: null };
  }
}

/** 审批卡上的文件清单：人要看的是"哪些文件、多大"，内容不进摘要。 */
export function describeUploadFiles(files: ReadonlyArray<string>): string {
  return files
    .map((path) => {
      try {
        const stat = statSync(path);
        const size =
          stat.size >= 1024 * 1024
            ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${Math.max(1, Math.round(stat.size / 1024))}KB`;
        return `${path}（${size}）`;
      } catch {
        return `${path}（无法读取）`;
      }
    })
    .join('\n');
}
