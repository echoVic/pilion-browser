import { accessSync, constants, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function isDownloadPathAllowed(
  record: { savePath: string; filename: string },
  systemDirectory: string,
  customDirectory?: string,
): boolean {
  if (
    !isAbsolute(record.savePath) ||
    record.savePath !== resolve(record.savePath) ||
    basename(record.savePath) !== record.filename
  )
    return false;
  const directory = dirname(record.savePath);
  return [systemDirectory, customDirectory].some(
    (allowed) => allowed !== undefined && directory === resolve(allowed),
  );
}

export function assertDownloadDirectory(directory: string): void {
  try {
    if (!isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error();
    accessSync(directory, constants.W_OK);
  } catch {
    throw new Error('下载位置必须是可写的文件夹');
  }
}

export function downloadLocation(directory: string, homeDirectory: string): string {
  const suffix = relative(homeDirectory, directory);
  if (!suffix) return '~';
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
    ? `~${sep}${suffix}`
    : directory;
}
