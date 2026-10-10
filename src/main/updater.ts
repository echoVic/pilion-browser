import type { AgentStatus, UpdateState, UpdateStatus } from '../shared/contracts.js';

/** 第一次检查放在开启后 30 秒，不和启动抢网络与 CPU。 */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** 下载进度最多这么久广播一次：每次广播都会把整份状态发给主窗口和设置窗口。 */
export const PROGRESS_INTERVAL_MS = 500;

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

/**
 * electron-updater 的 AppUpdater 里控制器用到的那部分，测试传一个假的。
 * 事件逐个写成重载：泛型事件表的写法与 AppUpdater 的签名对不上。
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: UpdaterLogger | null;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** 「立即重启」时由主进程提供的三步。 */
export interface RestartSteps {
  /** Agent、审批、录制、回放这类会被打断的工作是否在进行。 */
  interrupts(): boolean;
  /** 弹确认框；true 表示确认重启。 */
  confirm(): Promise<boolean>;
  /** 正常退出时的收尾：停止录制、保存工作区、断开 Agent、停掉子进程。 */
  drain(): Promise<void>;
}

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  currentVersion: string;
  /** Linux deb：安装要管理员密码，后台装不了，只提示并指向 Release 页面。 */
  manualOnly: boolean;
  releaseUrl(version: string): string;
  openExternal(url: string): void;
  onChange(state: UpdateState): void;
  logger?: UpdaterLogger;
}

/**
 * 什么时候检查、发现新版本后下不下载、什么时候安装。electron-updater 只负责拉元数据、
 * 下载与校验、交给系统安装。
 */
export class UpdateController {
  readonly #options: UpdateControllerOptions;
  #status: UpdateStatus = { kind: 'idle' };
  #enabled = false;
  #firstCheck: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #checking: Promise<void> | undefined;
  /** 在调用 checkForUpdates 之前置位：它可能在返回之前就同步发出 error 事件。 */
  #inCheck = false;
  #progressAt = 0;
  #restarting: Promise<void> | undefined;
  /** 已经交给安装程序：再点也不再装第二次。 */
  #installing = false;

  constructor(options: UpdateControllerOptions) {
    this.#options = options;
    const { updater } = options;
    // 下不下载由这里决定：deb 只提示，其余平台发现就下，手动检查和自动检查走同一条路。
    updater.autoDownload = false;
    // 已经下好的更新，不论「自动更新」开没开，退出时都装上。
    updater.autoInstallOnAppQuit = true;
    updater.logger = options.logger ?? console;
    updater.on('checking-for-update', () => {
      if (!this.#holding()) this.#set({ kind: 'checking' });
    });
    updater.on('update-not-available', () => {
      if (!this.#holding()) this.#set({ kind: 'up-to-date', checkedAt: Date.now() });
    });
    updater.on('update-available', (info) => this.#available(info.version));
    updater.on('download-progress', (info) => this.#progress(info.percent));
    updater.on('update-downloaded', (info) =>
      this.#set({ kind: 'downloaded', version: info.version }),
    );
    updater.on('error', (error) => this.#failed(error));
  }

  get state(): UpdateState {
    return { currentVersion: this.#options.currentVersion, status: this.#status };
  }

  /** 开：30 秒后第一次检查，之后每 4 小时一次。关：只停掉计时器，进行中的下载照常完成。 */
  setAutoUpdate(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    clearTimeout(this.#firstCheck);
    clearInterval(this.#interval);
    this.#firstCheck = undefined;
    this.#interval = undefined;
    if (!enabled) return;
    this.#firstCheck = setTimeout(() => void this.checkNow(), FIRST_CHECK_DELAY_MS);
    this.#interval = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
  }

  /** 同一时间只有一次检查；下载进行中不再检查。失败经 error 事件报告，这里不抛。 */
  checkNow(): Promise<void> {
    if (this.#checking) return this.#checking;
    if (this.#status.kind === 'downloading') return Promise.resolve();
    this.#inCheck = true;
    const checking = this.#options.updater
      .checkForUpdates()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#inCheck = false;
        this.#checking = undefined;
      });
    this.#checking = checking;
    return checking;
  }

  /**
   * downloaded：退出并安装，只交一次；available（deb）：打开该版本的 Release 页面；其他状态不做事。
   * 静默安装并重新打开：Windows 的安装包不是一键式的，不带 isSilent 会弹出安装向导，装完也不重新打开。
   */
  installNow(): void {
    const status = this.#status;
    if (status.kind === 'downloaded') {
      if (this.#installing) return;
      this.#installing = true;
      this.#options.updater.quitAndInstall(true, true);
    } else if (status.kind === 'available') this.#options.openExternal(status.url);
  }

  /**
   * 「立即重启」：有会被打断的工作先确认；确认后先收尾，再交给安装程序。收尾必须在交出去之前做完：
   * Windows 的安装程序启动一秒多后会直接结束 Pilion，AppImage 会马上打开新版本。重复的请求合成一次。
   */
  restart(steps: RestartSteps): Promise<void> {
    if (this.#status.kind === 'available') {
      this.installNow();
      return Promise.resolve();
    }
    if (this.#status.kind !== 'downloaded' || this.#installing) return Promise.resolve();
    this.#restarting ??= this.#runRestart(steps).finally(() => {
      this.#restarting = undefined;
    });
    return this.#restarting;
  }

  async #runRestart(steps: RestartSteps): Promise<void> {
    if (steps.interrupts() && !(await steps.confirm())) return;
    await steps.drain();
    this.installNow();
  }

  /** 有一个版本在等人处理（已下载，或 deb 的已发布）时，例行检查——包括失败的——不把它盖掉。 */
  #holding(): boolean {
    return this.#status.kind === 'downloaded' || this.#status.kind === 'available';
  }

  #available(version: string): void {
    const { manualOnly, releaseUrl, updater } = this.#options;
    if (manualOnly) {
      this.#set({ kind: 'available', version, url: releaseUrl(version) });
      return;
    }
    // 4 小时一次的例行检查会再次发现已经下好的同一个版本：不重下，提示条也不闪。
    if (this.#status.kind === 'downloaded' && this.#status.version === version) return;
    this.#progressAt = 0;
    this.#set({ kind: 'downloading', version, percent: 0 });
    // 失败经 error 事件报告。
    updater.downloadUpdate().catch(() => undefined);
  }

  #progress(percent: number): void {
    const status = this.#status;
    if (status.kind !== 'downloading') return;
    const now = Date.now();
    if (now - this.#progressAt < PROGRESS_INTERVAL_MS) return;
    this.#progressAt = now;
    this.#set({ ...status, percent: Math.floor(percent) });
  }

  #failed(error: Error): void {
    if (this.#holding() && this.#inCheck) return;
    this.#set({ kind: 'error', message: describeUpdateError(error), at: Date.now() });
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    this.#options.onChange(this.state);
  }
}

/** 「立即重启」会打断的事。 */
export interface WorkInProgress {
  agentStatus: AgentStatus;
  pendingApprovals: number;
  recording: boolean;
  replaying: boolean;
  distilling: boolean;
}

/** 有这些事在进行时，「立即重启」先弹确认。 */
export function restartInterrupts(work: WorkInProgress): boolean {
  return (
    work.agentStatus === 'starting' ||
    work.agentStatus === 'running' ||
    work.agentStatus === 'stopping' ||
    work.pendingApprovals > 0 ||
    work.recording ||
    work.replaying ||
    work.distilling
  );
}

/** 把 electron-updater 与 Squirrel.Mac 常见的报错换成人能照着做的话；其余的只留第一行。 */
export function describeUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(text))
    return '无法连接到 GitHub';
  if (/checksum mismatch/i.test(text)) return '更新包校验失败';
  if (/did not pass validation|code signature/i.test(text)) return '更新包签名校验失败';
  if (/read-only volume/i.test(text)) return '请把 Pilion 拖到「应用程序」文件夹后再更新';
  return text.split('\n')[0].slice(0, 200);
}
