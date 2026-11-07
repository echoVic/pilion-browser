import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 聊天里指向本地文件的链接：把消息里的 href 解析成磁盘路径，并决定"打开"还是"只定位"。
 *
 * 安全边界：只允许打开文档/图片/纯文本这类"看了不会执行"的文件；其余一律在访达里定位，
 * 绝不把 .app / .command / 脚本交给系统去执行——这些路径来自 Agent 生成的消息，不可信。
 */

/** 允许交给系统默认程序打开的扩展名（不含任何可执行/脚本类型）。 */
const OPENABLE_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'log',
  'json',
  'csv',
  'tsv',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'toml',
  'docx',
  'xlsx',
  'pptx',
]);

export type LocalFileAction = 'open' | 'reveal';

export function localFileAction(path: string): LocalFileAction {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'reveal';
  return OPENABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? 'open' : 'reveal';
}

/** `file://` 转路径（自动解码 %20 之类）；其余原样返回。 */
export function decodeLocalHref(href: string): string {
  const trimmed = href.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * 相对路径按候选目录依次试探（先命中的那个），都找不到时落在第一个候选目录下，
 * 让后续的"文件不存在"报错指向一个具体路径。
 */
export function resolveLocalFilePath(href: string, bases: readonly string[]): string {
  const decoded = decodeLocalHref(href);
  if (!decoded) return '';
  if (decoded === '~' || decoded.startsWith('~/')) return join(homedir(), decoded.slice(1));
  if (isAbsolute(decoded)) return decoded;
  const relative = decoded.replace(/^\.\//, '');
  const roots = bases.filter((base) => base.trim() !== '');
  for (const base of roots) {
    const candidate = resolve(base, relative);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(roots[0] ?? process.cwd(), relative);
}

/** 目标必须是已存在的普通文件；目录一律拒绝，错误文案要能直接给人看。 */
export function assertLocalFile(path: string): { bytes: number } {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`文件不存在：${path}`);
  }
  if (!stat.isFile()) throw new Error(`这不是一个文件：${path}`);
  return { bytes: stat.size };
}
