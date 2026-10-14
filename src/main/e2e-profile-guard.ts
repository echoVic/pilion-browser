/**
 * E2E / 测试模式下的 userData 隔离判定（纯函数，可单测）。
 *
 * 曾经发生过直接 `electron .` / `pnpm start` 启动测试 build，把 agents.json、host.sqlite
 * 写进用户真实 profile（~/Library/Application Support/<app>）。这里在任何写入之前判定：
 * 测试模式下 userData 必须落在临时目录（os.tmpdir()）下，否则拒绝启动。
 *
 * 路径由调用方做 realpath 解析（处理 macOS /var 与 /private 的符号链接），本模块只做比较。
 */
export function e2eProfileIsUnsafe(opts: {
  e2eMode: boolean;
  /** app.getPath('userData') 的真实路径（已 realpath）。 */
  userData: string;
  /** os.tmpdir() 的真实路径（已 realpath）。 */
  tmpRoot: string;
}): boolean {
  if (!opts.e2eMode) return false;
  const root = opts.tmpRoot.replace(/[\\/]+$/, '');
  if (!root) return false;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return !opts.userData.replace(/[\\/]+$/, '').startsWith(root + sep);
}
