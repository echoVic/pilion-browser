import { readFileSync } from 'node:fs';

/**
 * CLI 自己的版本：读 App 内的 package.json。编译后本文件在
 * <app>/dist/main/main/external/cli/version.js，package.json 在 <app>/package.json。
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
