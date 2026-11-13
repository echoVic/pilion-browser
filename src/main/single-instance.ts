/**
 * 同一份 profile 只跑一个 Pilion。第二个实例要是也起来，会多跑一个调度器（每条定时任务触发两次），
 * 两边轮流覆盖 workspace.json，后起的那个还会删掉先起那个的控制 socket。
 *
 * 锁按申请那一刻生效的 userData 目录区分（Electron 用 Chromium 的 ProcessSingleton，键是
 * DIR_USER_DATA）。main.ts 从不改 userData，它就是 `--user-data-dir` 或系统默认的 profile 目录：
 * 各用各临时 profile 的 E2E 实例互不影响，同一份 profile 关掉再开也拿得到锁。
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): unknown;
}

/**
 * 申请单实例锁。拿到了就返回 true，并在后来者启动时把它带来的 http(s) 链接交给 openUrl、
 * 没带链接就 show 出主窗口；没拿到返回 false，调用方要立即退出，不碰任何文件。
 */
export function claimSingleInstance(
  app: SingleInstanceApp,
  handlers: { show(): void; openUrl(url: string): void },
): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', (_event, argv) => {
    // argv 里还混着 Chromium 自己追加的开关和应用路径：只认 http(s) 链接，和 open-url 走同一条队列。
    const urls = argv.filter((arg) => /^https?:\/\//i.test(arg));
    if (urls.length === 0) handlers.show();
    for (const url of urls) handlers.openUrl(url);
  });
  return true;
}
