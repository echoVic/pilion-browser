import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
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

function setup(manualOnly = false) {
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const opened: string[] = [];
  const controller = new UpdateController({
    updater,
    currentVersion: '0.1.8',
    manualOnly,
    releaseUrl: (version) => `https://example.test/releases/tag/v${version}`,
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
    expect(controller.state.status).toEqual({ kind: 'error', message: '更新包校验失败', at: NOW });
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

  it('does nothing while no update is ready', async () => {
    const { updater, controller } = setup();
    const plan = steps();
    await controller.restart(plan);
    expect(plan.drain).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
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
  ])('asks first when %j', (busy) => {
    expect(restartInterrupts({ ...idle, ...busy })).toBe(true);
  });
});
