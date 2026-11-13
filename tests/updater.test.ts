import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  DOWNLOAD_STALL_MS,
  FIRST_CHECK_DELAY_MS,
  PROGRESS_INTERVAL_MS,
  UpdateController,
  describeUpdateError,
  restartInterrupts,
  type UpdaterLogger,
  type WorkInProgress,
} from '../src/main/updater';
import type { UpdateState } from '../src/shared/contracts';

const NOW = Date.parse('2026-10-11T08:00:00Z');
const quiet: UpdaterLogger = { info() {}, warn() {}, error() {} };

/** 只模拟 electron-updater 对外的那几个事件和方法；事件由测试按真实顺序发。 */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  logger: UpdaterLogger | null = null;
  checkForUpdates = vi.fn(async (): Promise<unknown> => {
    this.emit('checking-for-update');
    return null;
  });
  downloadUpdate = vi.fn(async (): Promise<unknown> => []);
  quitAndInstall = vi.fn();
}

function setup(manualOnly = false, nativeUpdater?: EventEmitter) {
  const updater = new FakeUpdater();
  // MacUpdater 自己也监听 native error，避免 EventEmitter 把它当成未处理异常。
  nativeUpdater?.on('error', () => {});
  const states: UpdateState[] = [];
  const opened: string[] = [];
  const controller = new UpdateController({
    updater,
    nativeUpdater,
    currentVersion: '0.1.8',
    manualOnly,
    releaseUrl: (version) => `https://example.test/releases/tag/v${version}`,
    latestReleaseUrl: 'https://example.test/releases/latest',
    openExternal: (url) => opened.push(url),
    onChange: (state) => states.push(state),
    logger: quiet,
  });
  return { updater, controller, states, opened };
}

/** 像真的那样失败：先发 error 事件，再让 checkForUpdates 的 promise 拒绝。 */
function failNextCheck(updater: FakeUpdater, message: string) {
  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.emit('checking-for-update');
    const error = new Error(message);
    updater.emit('error', error);
    throw error;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateController', () => {
  it('decides on downloads itself and installs a downloaded update on quit', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.logger).toBe(quiet);
  });

  it('starts idle and reports the running version', () => {
    const { controller } = setup();
    expect(controller.state).toEqual({ currentVersion: '0.1.8', status: { kind: 'idle' } });
  });

  it('checks 30 seconds after auto-update is turned on, then every 4 hours, and stops when it is turned off', async () => {
    const { updater, controller } = setup();
    controller.setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    controller.setAutoUpdate(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not double the schedule when auto-update is turned on twice', async () => {
    const { updater, controller } = setup();
    controller.setAutoUpdate(true);
    controller.setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('runs one check at a time', async () => {
    const { updater, controller } = setup();
    let finish = () => {};
    updater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const first = controller.checkNow();
    const second = controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('reports when the running version is the newest', async () => {
    const { updater, controller } = setup();
    await controller.checkNow();
    expect(controller.state.status).toEqual({ kind: 'checking' });
    updater.emit('update-not-available', { version: '0.1.8' });
    expect(controller.state.status).toEqual({ kind: 'up-to-date', checkedAt: NOW });
  });

  it('downloads a new version, throttles progress, and reports it downloaded', async () => {
    const { updater, controller, states } = setup();
    await controller.checkNow();
    updater.emit('update-available', { version: '0.1.9' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toEqual({ kind: 'downloading', version: '0.1.9', percent: 0 });
    updater.emit('download-progress', { percent: 10.6 });
    updater.emit('download-progress', { percent: 20.7 });
    expect(controller.state.status).toEqual({ kind: 'downloading', version: '0.1.9', percent: 10 });
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    updater.emit('download-progress', { percent: 35.2 });
    expect(controller.state.status).toEqual({ kind: 'downloading', version: '0.1.9', percent: 35 });
    updater.emit('update-downloaded', { version: '0.1.9' });
    expect(controller.state).toEqual({
      currentVersion: '0.1.8',
      status: { kind: 'downloaded', version: '0.1.9' },
    });
    expect(states.at(-1)).toEqual(controller.state);
  });

  it('waits at 100% on macOS until Squirrel stages the update', async () => {
    const nativeUpdater = new EventEmitter();
    const { updater, controller, states } = setup(false, nativeUpdater);
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    expect(controller.state.status).toEqual({
      kind: 'downloading',
      version: '0.1.9',
      percent: 100,
    });
    controller.installNow();
    await controller.checkNow();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    nativeUpdater.emit('update-downloaded');
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
    expect(states.at(-1)).toEqual(controller.state);
    controller.installNow();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('reports a native staging error and ignores a late staging completion', () => {
    const nativeUpdater = new EventEmitter();
    const { updater, controller, opened } = setup(false, nativeUpdater);
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    nativeUpdater.emit('error', new Error('code signature did not pass validation'));
    expect(controller.state.status).toEqual({
      kind: 'error',
      message: '更新包签名校验失败',
      at: NOW,
      url: 'https://example.test/releases/tag/v0.1.9',
    });
    nativeUpdater.emit('update-downloaded');
    expect(controller.state.status.kind).toBe('error');
    controller.installNow();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(opened).toEqual(['https://example.test/releases/tag/v0.1.9']);
  });

  it('ignores native updater events when no update is being staged', () => {
    const nativeUpdater = new EventEmitter();
    const { controller } = setup(false, nativeUpdater);
    nativeUpdater.emit('update-downloaded');
    nativeUpdater.emit('error', new Error('unrelated native error'));
    expect(controller.state.status).toEqual({ kind: 'idle' });
  });

  it('does not download the same version again once it is downloaded', async () => {
    const { updater, controller, states } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    const seen = states.length;
    await controller.checkNow();
    updater.emit('update-available', { version: '0.1.9' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(states.slice(seen)).toEqual([]);
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });

  it('keeps a downloaded update on screen while a background check fails', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    failNextCheck(updater, 'net::ERR_INTERNET_DISCONNECTED');
    await controller.checkNow();
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });

  it('shows why a check failed and when, then recovers on the next check', async () => {
    const { updater, controller } = setup();
    failNextCheck(updater, 'getaddrinfo ENOTFOUND github.com');
    await controller.checkNow();
    expect(controller.state.status).toEqual({
      kind: 'error',
      message: '无法连接到 GitHub',
      at: NOW,
      url: 'https://example.test/releases/latest',
    });
    await controller.checkNow();
    updater.emit('update-not-available', { version: '0.1.8' });
    expect(controller.state.status).toEqual({ kind: 'up-to-date', checkedAt: NOW });
  });

  it('reports a failed download without leaving a rejected promise behind', () => {
    const { updater, controller } = setup();
    updater.downloadUpdate.mockImplementationOnce(async () => {
      const error = new Error('sha512 checksum mismatch, expected a, got b');
      updater.emit('error', error);
      throw error;
    });
    updater.emit('update-available', { version: '0.1.9' });
    expect(controller.state.status).toEqual({
      kind: 'error',
      message: '更新包校验失败',
      at: NOW,
      url: 'https://example.test/releases/tag/v0.1.9',
    });
  });

  it('does not start a check while a download is running', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    await controller.checkNow();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('lets a running download finish after auto-update is turned off', async () => {
    const { updater, controller } = setup();
    controller.setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    updater.emit('update-available', { version: '0.1.9' });
    controller.setAutoUpdate(false);
    updater.emit('update-downloaded', { version: '0.1.9' });
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });

  it('only points deb installs at the release page', async () => {
    const { updater, controller, opened } = setup(true);
    await controller.checkNow();
    updater.emit('update-available', { version: '0.1.9' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(controller.state.status).toEqual({
      kind: 'available',
      version: '0.1.9',
      url: 'https://example.test/releases/tag/v0.1.9',
    });
    controller.installNow();
    expect(opened).toEqual(['https://example.test/releases/tag/v0.1.9']);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs only an update that has finished downloading', () => {
    const { updater, controller } = setup();
    controller.installNow();
    updater.emit('update-available', { version: '0.1.9' });
    controller.installNow();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', { version: '0.1.9' });
    controller.installNow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // 交给安装程序之后它报错（Windows 起不来安装包、macOS 的 Squirrel 出错）：不能永远卡在「已经在装」。
  it('reports a failed hand-over to the installer and installs again once the update is ready again', () => {
    const { updater, controller, opened } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('spawn EACCES'));
    });
    controller.installNow();
    expect(controller.state.status).toEqual({
      kind: 'error',
      message: '安装失败：spawn EACCES',
      at: NOW,
      url: 'https://example.test/releases/tag/v0.1.9',
    });
    controller.installNow();
    expect(opened).toEqual(['https://example.test/releases/tag/v0.1.9']);
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    controller.installNow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('turns an installer that throws into an error status instead of an exception', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    updater.emit('update-downloaded', { version: '0.1.9' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("No update available, can't quit and install");
    });
    expect(() => controller.installNow()).not.toThrow();
    expect(controller.state.status).toMatchObject({
      kind: 'error',
      message: "安装失败：No update available, can't quit and install",
    });
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('opens the latest release when a check fails before a version is known', async () => {
    const { updater, controller, opened } = setup();
    failNextCheck(updater, 'net::ERR_INTERNET_DISCONNECTED');
    await controller.checkNow();
    controller.installNow();
    expect(opened).toEqual(['https://example.test/releases/latest']);
  });
});

describe('restarting to update', () => {
  /** 记下每一步的先后，收尾故意晚一点结束。 */
  function steps(options: { busy?: boolean; confirmed?: boolean } = {}) {
    const order: string[] = [];
    let finishDrain = () => {};
    return {
      order,
      finishDrain: () => finishDrain(),
      interrupts: vi.fn(() => options.busy ?? false),
      confirm: vi.fn(async () => {
        order.push('confirm');
        return options.confirmed ?? true;
      }),
      drain: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push('drain');
            finishDrain = () => {
              order.push('drained');
              resolve();
            };
          }),
      ),
    };
  }

  function downloaded() {
    const context = setup();
    context.updater.emit('update-available', { version: '0.1.9' });
    context.updater.emit('update-downloaded', { version: '0.1.9' });
    return context;
  }

  it('installs silently and reopens Pilion afterwards', () => {
    const { updater, controller } = downloaded();
    controller.installNow();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('installs only once however many times it is asked', () => {
    const { updater, controller } = downloaded();
    controller.installNow();
    controller.installNow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('finishes the shutdown before handing over to the installer', async () => {
    const { updater, controller } = downloaded();
    const plan = steps();
    const { order } = plan;
    updater.quitAndInstall.mockImplementation(() => order.push('install'));
    const restarting = controller.restart(plan);
    await vi.waitFor(() => expect(plan.drain).toHaveBeenCalled());
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    plan.finishDrain();
    await restarting;
    expect(order).toEqual(['drain', 'drained', 'install']);
    expect(plan.confirm).not.toHaveBeenCalled();
  });

  it('asks first when work would be interrupted, and does nothing if the person declines', async () => {
    const { updater, controller } = downloaded();
    const plan = steps({ busy: true, confirmed: false });
    await controller.restart(plan);
    expect(plan.confirm).toHaveBeenCalledTimes(1);
    expect(plan.drain).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });

  it('collapses repeated restart requests into one confirmation, one shutdown and one install', async () => {
    const { updater, controller } = downloaded();
    const plan = steps({ busy: true });
    const first = controller.restart(plan);
    const second = controller.restart(plan);
    await vi.waitFor(() => expect(plan.drain).toHaveBeenCalled());
    plan.finishDrain();
    await Promise.all([first, second]);
    await controller.restart(plan);
    expect(plan.confirm).toHaveBeenCalledTimes(1);
    expect(plan.drain).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('points deb installs at the release page without shutting anything down', async () => {
    const { updater, controller, opened } = setup(true);
    updater.emit('update-available', { version: '0.1.9' });
    const plan = steps({ busy: true });
    await controller.restart(plan);
    expect(opened).toEqual(['https://example.test/releases/tag/v0.1.9']);
    expect(plan.confirm).not.toHaveBeenCalled();
    expect(plan.drain).not.toHaveBeenCalled();
  });

  // 确认框和收尾可能要好一会儿：这期间的例行检查发现更新的版本，会把「已下载」换成「正在下载」，收尾完就装不上了。
  it('does not check, or switch to a newer version, while the restart is shutting down', async () => {
    const { updater, controller } = downloaded();
    const plan = steps();
    const restarting = controller.restart(plan);
    await vi.waitFor(() => expect(plan.drain).toHaveBeenCalled());
    await controller.checkNow();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    // 收尾开始之前就发出去的那次检查，这时才回来。
    updater.emit('update-available', { version: '0.2.0' });
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    plan.finishDrain();
    await restarting;
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('reports an installer failure after the shutdown, and checks again afterwards', async () => {
    const { updater, controller } = downloaded();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('code signature did not pass validation'));
    });
    const plan = steps();
    const restarting = controller.restart(plan);
    await vi.waitFor(() => expect(plan.drain).toHaveBeenCalled());
    plan.finishDrain();
    await restarting;
    expect(controller.state.status).toMatchObject({
      kind: 'error',
      message: '安装失败：更新包签名校验失败',
      url: 'https://example.test/releases/tag/v0.1.9',
    });
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('checks again once the person declines the restart', async () => {
    const { updater, controller } = downloaded();
    await controller.restart(steps({ busy: true, confirmed: false }));
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does nothing while no update is ready', async () => {
    const { updater, controller } = setup();
    const plan = steps();
    await controller.restart(plan);
    expect(plan.drain).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('a download that stops making progress', () => {
  it('turns into an error after 10 minutes without progress, so the person can check again', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
    expect(controller.state.status.kind).toBe('downloading');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status).toEqual({
      kind: 'error',
      message: '下载 0.1.9 已经 10 分钟没有进展',
      at: NOW + DOWNLOAD_STALL_MS,
      url: 'https://example.test/releases/tag/v0.1.9',
    });
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('counts every progress event, even the ones too close together to broadcast', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(1_000);
    updater.emit('download-progress', { percent: 10 });
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS - 100);
    // 离上一次广播不到 500ms：不广播，但下载确实还在走。
    updater.emit('download-progress', { percent: 11 });
    expect(controller.state.status).toMatchObject({ percent: 10 });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
    expect(controller.state.status.kind).toBe('downloading');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status.kind).toBe('error');
  });

  it('still becomes downloaded if the stalled download finishes late', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS);
    expect(controller.state.status.kind).toBe('error');
    updater.emit('update-downloaded', { version: '0.1.9' });
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS * 3);
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });

  it('gives macOS staging its own 10 minutes, and a late staging still counts', async () => {
    const nativeUpdater = new EventEmitter();
    const { updater, controller } = setup(false, nativeUpdater);
    updater.emit('update-available', { version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1_000);
    updater.emit('update-downloaded', { version: '0.1.9' });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
    expect(controller.state.status).toMatchObject({ kind: 'downloading', percent: 100 });
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status.kind).toBe('error');
    nativeUpdater.emit('update-downloaded');
    expect(controller.state.status).toEqual({ kind: 'downloaded', version: '0.1.9' });
  });
});

describe('describeUpdateError', () => {
  it.each([
    ['net::ERR_INTERNET_DISCONNECTED', '无法连接到 GitHub'],
    ['getaddrinfo ENOTFOUND github.com', '无法连接到 GitHub'],
    ['connect ETIMEDOUT 140.82.112.3:443', '无法连接到 GitHub'],
    ['sha512 checksum mismatch, expected abc, got def', '更新包校验失败'],
    [
      'Code signature at URL file:///tmp/Pilion.app/ did not pass validation: code has no resources',
      '更新包签名校验失败',
    ],
    [
      'Cannot update while running on a read-only volume. The application is on a read-only volume.',
      '请把 Pilion 拖到「应用程序」文件夹后再更新',
    ],
  ])('turns %j into something a person can act on', (message, expected) => {
    expect(describeUpdateError(new Error(message))).toBe(expected);
  });

  it('keeps the first line of anything else, at most 200 characters', () => {
    expect(describeUpdateError(new Error('HttpError: 404 Not Found\n"method: GET url: …"'))).toBe(
      'HttpError: 404 Not Found',
    );
    expect(describeUpdateError(new Error('x'.repeat(300)))).toHaveLength(200);
    expect(describeUpdateError('plain text')).toBe('plain text');
  });
});

describe('restartInterrupts', () => {
  const idle: WorkInProgress = {
    agentStatus: 'ready',
    pendingApprovals: 0,
    recording: false,
    replaying: false,
    distilling: false,
    activeDownloads: 0,
  };

  it('lets an idle Pilion restart straight away', () => {
    for (const agentStatus of ['not_configured', 'ready', 'error', 'disconnected'] as const)
      expect(restartInterrupts({ ...idle, agentStatus })).toBe(false);
  });

  it.each<Partial<WorkInProgress>>([
    { agentStatus: 'starting' },
    { agentStatus: 'running' },
    { agentStatus: 'stopping' },
    { pendingApprovals: 1 },
    { recording: true },
    { replaying: true },
    { distilling: true },
    { activeDownloads: 1 },
  ])('asks first when %j', (busy) => {
    expect(restartInterrupts({ ...idle, ...busy })).toBe(true);
  });
});
