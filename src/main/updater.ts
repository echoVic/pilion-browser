import type { AgentStatus, UpdateState, UpdateStatus } from '../shared/contracts.js';

/** 第一次检查放在开启后 30 秒，不和启动抢网络与 CPU。 */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** 下载进度最多这么久广播一次：每次广播都会把整份状态发给主窗口和设置窗口。 */
export const PROGRESS_INTERVAL_MS = 500;
/**
 * 下载（含 macOS 的暂存）这么久没有任何进展就报错：断网时 electron-updater 不一定会报错，
 * 状态停在「正在下载」，检查按钮一直是灰的，人连重试的办法都没有。
 */
export const DOWNLOAD_STALL_MS = 10 * 60_000;

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
  /** Agent、审批、录制、回放、下载这类会被打断的工作是否在进行。 */
  interrupts(): boolean;
  /** 弹确认框；true 表示确认重启。 */
  confirm(): Promise<boolean>;
  /** 正常退出时的收尾：停止录制、保存工作区、断开 Agent、停掉子进程。 */
  drain(): Promise<void>;
}

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  /** macOS 下载完还要等 Squirrel 暂存；其余平台不传。 */
  nativeUpdater?: NativeUpdaterLike;
  currentVersion: string;
  /** Linux deb：安装要管理员密码，后台装不了，只提示并指向 Release 页面。 */
  manualOnly: boolean;
  releaseUrl(version: string): string;
  /** 任意检查或下载错误都能打开的最新 Release 页面。 */
  latestReleaseUrl: string;
  openExternal(url: string): void;
  onChange(state: UpdateState): void;
  logger?: UpdaterLogger;
}

export interface NativeUpdaterLike {
  on(event: 'update-downloaded', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * 「立即重启」与交给安装程序的阶段，带着人确认要装的那个版本：
 *
 *   idle ──restart──▶ restarting ──收尾完──▶ installing
 *    ▲  └──installNow───────────────────────────▲  │
 *    ├──────── 人取消、或收尾完版本已经不对 ──┘     │
 *    └──────── 安装程序报错（error 事件或同步抛错），状态换成 error ┘
 *
 * restarting 与 installing 期间不检查、不理会新发现的版本：确认框和收尾可能要好一会儿，
 * 这期间例行检查要是发现了更新的版本，会把「已下载」换成「正在下载」，收尾完就装不上了。
 */
type InstallPhase =
  | { kind: 'idle' }
  | { kind: 'restarting'; version: string; done: Promise<void> }
  | { kind: 'installing'; version: string };

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
  /** 已经交给安装程序（installing）时再点也不再装第二次；见 InstallPhase。 */
  #phase: InstallPhase = { kind: 'idle' };
  /** 下载停滞的计时：每有一点进展就重新计，离开「正在下载」就停。 */
  #stall: ReturnType<typeof setTimeout> | undefined;
  #stagingVersion: string | undefined;
  /** 当前下载或 macOS 暂存中的版本；失败时用于给出对应 Release 页面。 */
  #pendingVersion: string | undefined;

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
    updater.on('update-downloaded', (info) => {
      if (options.nativeUpdater) {
        this.#stagingVersion = info.version;
        this.#set({ kind: 'downloading', version: info.version, percent: 100 });
        // 暂存是另一段等待，从这里重新计时。
        this.#watchDownload();
      } else {
        this.#pendingVersion = undefined;
        this.#set({ kind: 'downloaded', version: info.version });
      }
    });
    updater.on('error', (error) => this.#failed(error));
    options.nativeUpdater?.on('update-downloaded', () => {
      const version = this.#stagingVersion;
      if (!version) return;
      this.#stagingVersion = undefined;
      this.#pendingVersion = undefined;
      this.#set({ kind: 'downloaded', version });
    });
    options.nativeUpdater?.on('error', (error) => {
      if (this.#stagingVersion) this.#failed(error);
    });
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

  /** 同一时间只有一次检查；下载进行中、重启安装途中不再检查。失败经 error 事件报告，这里不抛。 */
  checkNow(): Promise<void> {
    if (this.#phase.kind !== 'idle') return Promise.resolve();
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
   * downloaded：退出并安装，只交一次；available 或带恢复 URL 的 error：打开 Release 页面；其他状态不做事。
   * 静默安装并重新打开：Windows 的安装包不是一键式的，不带 isSilent 会弹出安装向导，装完也不重新打开。
   */
  installNow(): void {
    const status = this.#status;
    if (status.kind === 'downloaded') {
      if (this.#phase.kind === 'installing') return;
      this.#install(status.version);
    } else if (status.kind === 'available') {
      this.#options.openExternal(status.url);
    } else if (status.kind === 'error' && status.url) {
      this.#options.openExternal(status.url);
    }
  }

  /**
   * 「立即重启」：有会被打断的工作先确认；确认后先收尾，再交给安装程序。收尾必须在交出去之前做完：
   * Windows 的安装程序启动一秒多后会直接结束 Pilion，AppImage 会马上打开新版本。重复的请求合成一次。
   */
  restart(steps: RestartSteps): Promise<void> {
    const status = this.#status;
    if (status.kind === 'available') {
      this.installNow();
      return Promise.resolve();
    }
    if (this.#phase.kind === 'restarting') return this.#phase.done;
    if (status.kind !== 'downloaded' || this.#phase.kind === 'installing') return Promise.resolve();
    const version = status.version;
    const done: Promise<void> = this.#runRestart(steps, version).finally(() => {
      if (this.#phase.kind === 'restarting' && this.#phase.done === done)
        this.#phase = { kind: 'idle' };
    });
    this.#phase = { kind: 'restarting', version, done };
    return done;
  }

  async #runRestart(steps: RestartSteps, version: string): Promise<void> {
    if (steps.interrupts() && !(await steps.confirm())) return;
    await steps.drain();
    // 只装人确认的那个版本。重启途中不检查，正常情况下这里一定还是它；万一不是，不装别的。
    const status = this.#status;
    if (status.kind !== 'downloaded' || status.version !== version) return;
    this.#install(version);
  }

  /** 交给安装程序。没交出去（同步抛错）和交出去之后报错一样处理：回到 idle，报出来，人可以再试。 */
  #install(version: string): void {
    this.#phase = { kind: 'installing', version };
    try {
      this.#options.updater.quitAndInstall(true, true);
    } catch (error) {
      this.#installFailed(error);
    }
  }

  #installFailed(error: unknown): void {
    if (this.#phase.kind !== 'installing') return;
    const { version } = this.#phase;
    this.#phase = { kind: 'idle' };
    this.#set({
      kind: 'error',
      message: `安装失败：${describeUpdateError(error)}`,
      at: Date.now(),
      url: this.#options.releaseUrl(version),
    });
  }

  /** 有一个版本在等人处理（已下载，或 deb 的已发布）时，例行检查——包括失败的——不把它盖掉。 */
  #holding(): boolean {
    return this.#status.kind === 'downloaded' || this.#status.kind === 'available';
  }

  #available(version: string): void {
    // 重启安装途中检查已经停了，这里是停之前就发出去的那次检查回来了：不让它把要装的版本换掉。
    if (this.#phase.kind !== 'idle') return;
    const { manualOnly, releaseUrl, updater } = this.#options;
    if (manualOnly) {
      this.#set({ kind: 'available', version, url: releaseUrl(version) });
      return;
    }
    // 4 小时一次的例行检查会再次发现已经下好的同一个版本：不重下，提示条也不闪。
    if (this.#status.kind === 'downloaded' && this.#status.version === version) return;
    this.#pendingVersion = version;
    this.#progressAt = 0;
    this.#set({ kind: 'downloading', version, percent: 0 });
    this.#watchDownload();
    // 失败经 error 事件报告。
    updater.downloadUpdate().catch(() => undefined);
  }

  #progress(percent: number): void {
    const status = this.#status;
    if (status.kind !== 'downloading') return;
    // 每一点进展都算，不受广播节流的限制。
    this.#watchDownload();
    const now = Date.now();
    if (now - this.#progressAt < PROGRESS_INTERVAL_MS) return;
    this.#progressAt = now;
    this.#set({ ...status, percent: Math.floor(percent) });
  }

  #watchDownload(): void {
    clearTimeout(this.#stall);
    this.#stall = setTimeout(() => this.#stalled(), DOWNLOAD_STALL_MS);
  }

  /**
   * 十分钟没有进展：报错，检查按钮重新可用，「前往下载」指向这个版本的 Release 页面。下载与暂存的状态
   * 不清：它们要是迟一点自己完成了，照样会变成「已下载」。
   */
  #stalled(): void {
    this.#stall = undefined;
    const status = this.#status;
    if (status.kind !== 'downloading') return;
    this.#set({
      kind: 'error',
      message: `下载 ${status.version} 已经 ${DOWNLOAD_STALL_MS / 60_000} 分钟没有进展`,
      at: Date.now(),
      url: this.#options.releaseUrl(status.version),
    });
  }

  #failed(error: Error): void {
    // 交给安装程序之后报的错就是安装失败（macOS 上 Squirrel 的错也经这里转过来）。
    if (this.#phase.kind === 'installing') {
      this.#installFailed(error);
      return;
    }
    if (this.#holding() && this.#inCheck) return;
    const url = this.#pendingVersion
      ? this.#options.releaseUrl(this.#pendingVersion)
      : this.#options.latestReleaseUrl;
    this.#pendingVersion = undefined;
    this.#stagingVersion = undefined;
    this.#set({ kind: 'error', message: describeUpdateError(error), at: Date.now(), url });
  }

  #set(status: UpdateStatus): void {
    if (status.kind !== 'downloading') {
      clearTimeout(this.#stall);
      this.#stall = undefined;
    }
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
  activeDownloads: number;
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
    work.distilling ||
    work.activeDownloads > 0
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
