# 自动更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已安装的 Pilion 从 GitHub Releases 自动检查、后台下载新版本，下载好后提示重启，不点重启就在退出时安装；设置里可以关掉。

**Architecture:** 新模块 `src/main/updater.ts` 包装 electron-updater，决定检查时机、下不下载、什么时候安装，依赖从构造参数传入以便单测。主进程把它的状态随 `AppState.update` 广播；设置窗口「通用」页显示「更新」分区，主窗口在已下载时显示提示条；`update:check`、`update:install` 两条 IPC 由主窗口和设置窗口调用。监听 `before-quit-for-update` 提前置位 `quitting`，保证安装时窗口真的关得掉。

**Tech Stack:** Electron 43、electron-builder 26.16.1、electron-updater 6.8.10、TypeScript（主进程 NodeNext）、React 19、zod 4、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-11-auto-update-design.md`

**分支：** `feat/auto-update`（基于 `fix/mac-signing-keychain`）。

## Global Constraints

- electron-updater 精确版本 `6.8.10`，放在 `dependencies`（`pnpm add --save-exact`）。主进程由 `tsc` 编译、不经打包工具，运行时依赖必须在 `dependencies`。
- 只在 `app.isPackaged && process.env.NODE_ENV !== 'test'` 时创建 electron-updater 实例；其余情况状态为 `{ kind: 'unsupported' }`，不联网。
- 开启后 30 秒第一次检查（`FIRST_CHECK_DELAY_MS = 30_000`），之后每 4 小时（`CHECK_INTERVAL_MS = 4 * 60 * 60_000`）；下载进度最多每 500 毫秒广播一次（`PROGRESS_INTERVAL_MS = 500`）。
- `autoDownload` 固定 `false`（下载由控制器决定），`autoInstallOnAppQuit` 固定 `true`（已下载的更新不论开关退出时都装）。
- Linux 上没有 `APPIMAGE` 环境变量即按 deb 处理：只提示、不下载，按钮打开 Release 页面。
- Release 页面地址：`https://github.com/echoVic/pilion-browser/releases/tag/v<版本>`，只由主进程生成，渲染层不传 URL。
- 文案逐字：
  - 提示条：「Pilion x.y.z 已下载，重启后生效」+「立即重启」「稍后」；deb：「Pilion x.y.z 已发布」+「前往下载」「稍后」。
  - 确认框：message「现在重启会中断正在进行的工作」，detail「Agent 的任务、等待审批的操作、录制或技能回放都会停止。」，按钮「立即重启」「取消」，默认与取消都是「取消」。
  - 设置分区：标题「更新」、「当前版本 x.y.z」、开关「自动更新」、说明「启动时和每 4 小时检查一次，下载好后提示重启。」。
  - 状态文字：（空）/「正在检查…」/「已是最新版本（HH:MM）」/「正在下载 x.y.z（35%）」/「x.y.z 已下载，退出时安装」/「x.y.z 已发布」/「上次检查失败：原因（HH:MM）」/「开发版本不检查更新」。
  - 菜单：「检查更新…」。
- `src/preload/entry.cts` 与 `src/preload/index.ts` 的 `updates` 分组逐字一致；`entry.cts` 自带的 `IPC` 表里通道字符串与 `src/shared/contracts.ts` 一致。
- 代码注释用中文，风格与周边一致；提交信息用英文 conventional commits。
- 每个任务提交前：`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 通过（格式问题用 `pnpm exec prettier --write <文件>` 修）。

## Review Focus

1. 「关闭窗口时退出」关掉、设置窗口开着时点「立即重启」：应用应正常退出、安装并重新打开，不能只把窗口藏起来卡住 → Task 6 演练场景 3。
2. 已下载更新后，后台例行检查失败（断网）：提示条和设置页仍显示「已下载」，不被错误盖掉 → Task 2 测试 `keeps a downloaded update on screen while a background check fails`。
3. 已下载 0.1.9 后，4 小时后的例行检查再次发现 0.1.9：不重新下载，提示条不闪 → Task 2 测试 `does not download the same version again once it is downloaded`。
4. electron-updater 的报错常是多行、带堆栈和整段 URL：设置页只显示第一行、最多 200 字 → Task 2 测试 `keeps the first line of anything else, at most 200 characters`。
5. 在设置里反复开关「自动更新」：计时器不叠加成多次检查 → Task 2 测试 `does not double the schedule when auto-update is turned on twice`。

---

### Task 1: 设置项与共享类型

**Files:**

- Modify: `src/shared/settings.ts`
- Modify: `src/shared/contracts.ts`（`AppState` 上方新增类型、`AppState.update`、`IPC` 两条通道）
- Test: `tests/settings.test.ts`

**Interfaces:**

- Consumes: 无
- Produces:
  - `AppSettings.autoUpdate: boolean`（缺省与读坏都回退为 `true`），`AppSettingsPatch.autoUpdate?: boolean`
  - `UpdateStatus`、`UpdateState`（定义见 Step 4）
  - `AppState.update?: UpdateState`
  - `IPC.updateCheck = 'update:check'`、`IPC.updateInstall = 'update:install'`

- [ ] **Step 1: 写失败的测试**

`tests/settings.test.ts` 里：

把 `starts from defaults ...` 的期望改为：

```ts
expect(store.data).toEqual({
  startupBehavior: 'restore',
  searchEngine: 'google',
  quitOnWindowClose: true,
  agentWindowBehavior: 'foreground',
  autoUpdate: true,
});
```

把 `falls back field by field ...` 写入的文件与期望改为：

```ts
await writeFile(
  path,
  JSON.stringify({
    theme: 'purple',
    searchEngine: 'bing',
    quitOnWindowClose: 'no',
    autoUpdate: 'yes',
    extra: 1,
  }),
);
const store = new SettingsStore(path);
await store.load();
expect(store.data).toEqual({
  startupBehavior: 'restore',
  searchEngine: 'bing',
  quitOnWindowClose: true,
  agentWindowBehavior: 'foreground',
  autoUpdate: true,
});
```

在 `uses defaults when the file is not JSON at all` 后面加：

```ts
it('keeps auto-update on by default and remembers turning it off across a restart', async () => {
  const path = await settingsPath();
  const store = new SettingsStore(path);
  await store.load();
  expect(store.data.autoUpdate).toBe(true);
  await store.update({ autoUpdate: false });
  const restarted = new SettingsStore(path);
  await restarted.load();
  expect(restarted.data.autoUpdate).toBe(false);
});
```

在 `accepts only known fields ...` 里加两行：

```ts
expect(AppSettingsPatchSchema.parse({ autoUpdate: false })).toEqual({ autoUpdate: false });
expect(() => AppSettingsPatchSchema.parse({ autoUpdate: 'no' })).toThrow();
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/settings.test.ts`
Expected: FAIL，默认值里没有 `autoUpdate`、`AppSettingsPatchSchema` 拒绝 `autoUpdate`。

- [ ] **Step 3: 实现设置项**

`src/shared/settings.ts`：`fields` 里加 `autoUpdate: z.boolean(),`；`AppSettingsSchema` 里 `agentWindowBehavior` 那行后面加：

```ts
  /** 只管自动检查和下载；已经下好的更新，退出时总会安装。 */
  autoUpdate: fields.autoUpdate.default(true).catch(true),
```

- [ ] **Step 4: 加共享类型与通道**

`src/shared/contracts.ts`，在 `export interface AppState {` 上方加：

```ts
/** 自动更新进行到哪一步。开发模式与 e2e 不检查更新，状态是 unsupported。 */
export type UpdateStatus =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  // 只提示、不下载（Linux deb）：url 是该版本的 Release 页面，由主进程给出。
  | { kind: 'available'; version: string; url: string }
  | { kind: 'error'; message: string; at: number };
export interface UpdateState {
  currentVersion: string;
  status: UpdateStatus;
}
```

`AppState` 里 `settings?: AppSettings;` 后面加：

```ts
  /** 自动更新的状态，主窗口的提示条与设置窗口的「更新」分区都从这里读。 */
  update?: UpdateState;
```

`IPC` 里 `settingsOpen: 'settings:open',` 后面加：

```ts
  updateCheck: 'update:check',
  updateInstall: 'update:install',
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm exec vitest run tests/settings.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/shared/settings.ts src/shared/contracts.ts tests/settings.test.ts
git commit -m "feat(settings): add the auto-update setting and update state types"
```

---

### Task 2: 更新控制器

**Files:**

- Modify: `package.json`、`pnpm-lock.yaml`（加 `electron-updater@6.8.10`）
- Create: `src/main/updater.ts`
- Test: `tests/updater.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `UpdateStatus`、`UpdateState`；`AgentStatus`（`src/shared/contracts.ts` 已有）
- Produces（`src/main/updater.ts`）：
  - `FIRST_CHECK_DELAY_MS`、`CHECK_INTERVAL_MS`、`PROGRESS_INTERVAL_MS`
  - `interface UpdaterLogger`、`interface UpdaterLike`（electron-updater 的 `autoUpdater` 可直接赋给它，已实测通过类型检查）
  - `interface UpdateControllerOptions { updater; currentVersion; manualOnly; releaseUrl(version); openExternal(url); onChange(state); logger? }`
  - `class UpdateController { get state(): UpdateState; setAutoUpdate(enabled: boolean): void; checkNow(): Promise<void>; installNow(): void }`
  - `interface WorkInProgress { agentStatus: AgentStatus; pendingApprovals: number; recording: boolean; replaying: boolean; distilling: boolean }`
  - `restartInterrupts(work: WorkInProgress): boolean`
  - `describeUpdateError(error: unknown): string`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add --save-exact electron-updater@6.8.10`
Expected: `package.json` 的 `dependencies` 出现 `"electron-updater": "6.8.10"`。

- [ ] **Step 2: 写失败的测试**

Create `tests/updater.test.ts`：

```ts
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
```

- [ ] **Step 3: 运行，确认失败**

Run: `pnpm exec vitest run tests/updater.test.ts`
Expected: FAIL，找不到模块 `../src/main/updater`。

- [ ] **Step 4: 实现控制器**

Create `src/main/updater.ts`：

```ts
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
  quitAndInstall(): void;
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

  /** downloaded：退出并安装；available（deb）：打开该版本的 Release 页面；其他状态不做事。 */
  installNow(): void {
    const status = this.#status;
    if (status.kind === 'downloaded') this.#options.updater.quitAndInstall();
    else if (status.kind === 'available') this.#options.openExternal(status.url);
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
```

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run tests/updater.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 6: 全量单测、类型、lint、格式**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add package.json pnpm-lock.yaml src/main/updater.ts tests/updater.test.ts
git commit -m "feat(updater): decide when to check, download and install updates"
```

---

### Task 3: 主进程、preload 与菜单接线

**Files:**

- Modify: `tests/contracts.test.ts`（preload 一致性测试推广到按分组比对）
- Modify: `src/preload/entry.cts`、`src/preload/index.ts`（`updates` 分组；`entry.cts` 的本地 `IPC` 表）
- Modify: `src/main/menu.ts`（「检查更新…」）
- Modify: `src/main/main.ts`（创建控制器、状态、IPC、确认框、`before-quit-for-update`）
- Test: `tests/electron.e2e.ts`（新增一条 e2e，Task 4 再补完）

**Interfaces:**

- Consumes: Task 1 的 `IPC.updateCheck`、`IPC.updateInstall`、`AppState.update`、`AppSettings.autoUpdate`；Task 2 的 `UpdateController`、`restartInterrupts`
- Produces:
  - `window.pilion.updates.check(): Promise<unknown>`、`window.pilion.updates.install(): Promise<unknown>`
  - 菜单项 id `checkForUpdates`；`MenuHandlers.checkForUpdates(): void`
  - 主进程状态里的 `update` 字段（开发模式为 `{ currentVersion, status: { kind: 'unsupported' } }`）

- [ ] **Step 1: 把 preload 一致性测试推广到按分组比对（会失败）**

`tests/contracts.test.ts`：把 `preloadSkillsBlock` 改成按分组名取块，`skillsMethodNames` 改名，`preload parity` 改为对 `skills`、`updates` 两组各跑一遍：

```ts
function preloadGroupBlock(source: string, group: string): string {
  const label = `${group}: Object.freeze(`;
  const start = source.indexOf(label);
  if (start < 0) throw new Error(`${group} group not found in preload source`);
  const open = source.indexOf('{', start + label.length);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open, end + 1);
}

function groupMethodNames(block: string): string[] {
  return [...block.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort();
}
```

```ts
describe('preload parity', () => {
  const index = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/preload/entry.cts', import.meta.url), 'utf8');

  describe.each(['skills', 'updates'])('%s group', (group) => {
    const indexBlock = preloadGroupBlock(index, group);
    const entryBlock = preloadGroupBlock(entry, group);

    it('exposes the same method names from both preload entry points', () => {
      expect(groupMethodNames(entryBlock)).toEqual(groupMethodNames(indexBlock));
    });

    // A same-named method can still pass a differently shaped argument object on one side;
    // that's a schema rejection at runtime, not a typecheck or a method-name mismatch. Comparing
    // the full source text of both groups catches that, plus any other one-sided edit.
    it('keeps every method byte-identical between the two entry points', () => {
      expect(entryBlock).toEqual(indexBlock);
    });

    it('resolves every IPC.* channel it references to the same string in both files', () => {
      const keys = [...new Set([...entryBlock.matchAll(/IPC\.(\w+)/g)].map((match) => match[1]))];
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(localIpcValue(entry, key)).toBe(IPC[key as keyof typeof IPC]);
      }
    });
  });
});
```

文件开头那段注释里「compares the two `skills` groups' source text」改为「compares each group's source text」。

Run: `pnpm exec vitest run tests/contracts.test.ts`
Expected: FAIL，`updates group not found in preload source`。

- [ ] **Step 2: 两个 preload 加 `updates` 分组**

`src/preload/entry.cts` 的本地 `IPC` 表里 `settingsOpen: 'settings:open',` 后面加：

```ts
  updateCheck: 'update:check',
  updateInstall: 'update:install',
```

`src/preload/entry.cts` 与 `src/preload/index.ts` 的 `api` 里，`settings: Object.freeze({ ... }),` 分组后面都加上逐字相同的一段：

```ts
  updates: Object.freeze({
    /** 立即检查更新，结果随状态广播回来。 */
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    /** 已下载：立即重启安装，有进行中的工作先确认；deb 有新版本：打开 Release 页面。 */
    install: () => ipcRenderer.invoke(IPC.updateInstall),
  }),
```

Run: `pnpm exec vitest run tests/contracts.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败的 e2e**

`tests/electron.e2e.ts`，在 `settings open in their own window, reach every window at once and survive a restart` 这条测试后面加：

```ts
test('checking for updates opens the update section; dev builds never check', async () => {
  if (!application || !mainPage) throw new Error('Not launched');
  // 开发模式与 e2e 不创建 electron-updater，不会联网。
  expect(
    await mainPage.evaluate(() =>
      window.pilion.getState().then((state) => state.update?.status.kind),
    ),
  ).toBe('unsupported');
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('checkForUpdates')!.click(),
  );
  const settingsPage = await preferencesPage(application);
  await expect(settingsPage.getByRole('heading', { name: '通用' })).toBeVisible();
});
```

Run: `pnpm run build && pnpm exec playwright test -g "checking for updates"`
Expected: FAIL（`state.update` 不存在；菜单里没有 `checkForUpdates`）。

- [ ] **Step 4: 菜单加「检查更新…」**

`src/main/menu.ts`：

`MenuHandlers` 里 `openSettings(): void;` 后面加：

```ts
  /** 打开设置窗口的通用页并立即检查更新。 */
  checkForUpdates(): void;
```

`const quit: MenuItemConstructorOptions = ...` 后面加：

```ts
const checkForUpdates: MenuItemConstructorOptions = {
  id: 'checkForUpdates',
  label: '检查更新…',
  click: () => handlers.checkForUpdates(),
};
```

macOS 的 Pilion 菜单：`{ role: 'about', label: '关于 Pilion' },` 后面插入 `checkForUpdates,`。

帮助菜单最后一行改为：

```ts
        ...(mac ? [] : [separator, checkForUpdates, { role: 'about', label: '关于 Pilion' }]),
```

- [ ] **Step 5: 主进程接线**

`src/main/main.ts`：

1. `electron` 的导入里 `app,` 后面加 `autoUpdater as nativeAutoUpdater,`；`import { buildMenu, type MenuState } from './menu.js';` 后面加：

```ts
import { restartInterrupts, UpdateController } from './updater.js';
```

2. `let settings: SettingsStore;` 后面加：

```ts
/** 打包后的应用才有；开发模式和 e2e 里一直是 undefined，状态显示为 unsupported。 */
let updates: UpdateController | undefined;
```

3. `const state = (): AppState => ({` 里 `settings: settings?.data,` 后面加：

```ts
  update: updates?.state ?? { currentVersion: app.getVersion(), status: { kind: 'unsupported' } },
```

4. `init()` 末尾 `if (restored) activateTab(restored);` 后面加：

```ts
void startUpdates().catch((error) => console.error('自动更新启动失败', error));
```

5. `init()` 之后、`async function configureSecurity` 之前加：

```ts
/** 只有打包后的应用检查更新；开发模式和 e2e（包括用 PILION_E2E_EXECUTABLE 跑打包版）都不联网。 */
async function startUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.NODE_ENV === 'test') return;
  const { autoUpdater } = (await import('electron-updater')).default;
  updates = new UpdateController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    // deb 的安装要管理员密码，后台装不了：只提示，让人去 Release 页面下载。
    manualOnly: process.platform === 'linux' && !process.env.APPIMAGE,
    releaseUrl: (version) => `https://github.com/echoVic/pilion-browser/releases/tag/v${version}`,
    openExternal: (url) => void shell.openExternal(url),
    onChange: () => emit(),
  });
  updates.setAutoUpdate(settings.data.autoUpdate);
}
/**
 * 「立即重启」：Agent 在干活、有审批在等、正在录制或回放时先确认；确认后走正常的退出流程
 * （before-quit 里的 shutdown），再由 electron-updater 安装并重新打开。
 */
async function installUpdate(parent: BrowserWindow | undefined): Promise<void> {
  if (!updates) return;
  const interrupts =
    updates.state.status.kind === 'downloaded' &&
    restartInterrupts({
      agentStatus,
      pendingApprovals: approvals.size,
      recording: recordingSession.isRecording(),
      replaying: replayRunning() || Boolean(agentReplay),
      distilling: Boolean(distillation.running),
    });
  if (interrupts) {
    const options = {
      type: 'warning' as const,
      buttons: ['立即重启', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '现在重启会中断正在进行的工作',
      detail: 'Agent 的任务、等待审批的操作、录制或技能回放都会停止。',
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return;
  }
  updates.installNow();
}
```

6. `registerIpc()` 里，`IPC.settingsSave` 的处理函数改为：

```ts
    async (patch) => {
      const saved = await settings.update(patch);
      if (patch.autoUpdate !== undefined) updates?.setAutoUpdate(saved.autoUpdate);
      emit();
      return saved;
    },
```

`handle(IPC.settingsOpen, ...)` 后面加：

```ts
// 设置页的「更新」分区也有这两个按钮；要不要先确认由主进程判断，与从哪个窗口点进来无关。
handle(IPC.updateCheck, undefined, () => void updates?.checkNow(), preferences);
handle(
  IPC.updateInstall,
  undefined,
  (_value, event) => installUpdate(BrowserWindow.fromWebContents(event.sender) ?? undefined),
  preferences,
);
```

7. `refreshMenu()` 里 `buildMenu(next, { ... })` 的处理器对象，`openSettings,` 后面加：

```ts
      checkForUpdates: () => {
        openSettings({ pane: 'general' });
        void updates?.checkNow();
      },
```

8. `app.on('before-quit', ...)` 前面加：

```ts
// quitAndInstall 先关掉所有窗口，之后才触发 before-quit。设置窗口、以及「关闭窗口时退出」关掉时的
// 主窗口，只在 quitting 置位后才真的关，否则只是藏起来，退出就卡住了。
nativeAutoUpdater.on('before-quit-for-update', () => {
  quitting = true;
});
```

- [ ] **Step 6: 运行 e2e 与全量检查**

Run: `pnpm run build && pnpm exec playwright test -g "checking for updates"`
Expected: PASS。

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/main/main.ts src/main/menu.ts src/preload/entry.cts src/preload/index.ts tests/contracts.test.ts tests/electron.e2e.ts
git commit -m "feat(updater): wire update checks into the main process, menu and preload"
```

---

### Task 4: 设置页「更新」分区与主窗口提示条

**Files:**

- Create: `src/renderer/update-view.ts`
- Test: `tests/update-view.test.ts`
- Modify: `src/renderer/Preferences.tsx`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/style.css`
- Modify: `tests/electron.e2e.ts`（补完 Task 3 的那条）

**Interfaces:**

- Consumes: Task 1 的 `UpdateStatus`、`UpdateState`、`AppSettings.autoUpdate`；Task 3 的 `window.pilion.updates.check()`、`install()`
- Produces（`src/renderer/update-view.ts`）：
  - `updateStatusText(status: UpdateStatus): string`
  - `interface UpdateButton { label: string; action: 'check' | 'install'; disabled: boolean }`、`updateButton(status: UpdateStatus): UpdateButton | undefined`
  - `interface UpdateNotice { version: string; text: string; button: string }`、`updateNotice(status: UpdateStatus | undefined, dismissedVersion: string): UpdateNotice | undefined`

- [ ] **Step 1: 写失败的单测**

Create `tests/update-view.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { updateButton, updateNotice, updateStatusText } from '../src/renderer/update-view';
import type { UpdateStatus } from '../src/shared/contracts';

/** 本地时间 09:05。 */
const at = new Date(2026, 9, 11, 9, 5).getTime();

describe('update section', () => {
  it.each<[UpdateStatus, string]>([
    [{ kind: 'unsupported' }, '开发版本不检查更新'],
    [{ kind: 'idle' }, ''],
    [{ kind: 'checking' }, '正在检查…'],
    [{ kind: 'up-to-date', checkedAt: at }, '已是最新版本（09:05）'],
    [{ kind: 'downloading', version: '0.1.9', percent: 35 }, '正在下载 0.1.9（35%）'],
    [{ kind: 'downloaded', version: '0.1.9' }, '0.1.9 已下载，退出时安装'],
    [{ kind: 'available', version: '0.1.9', url: 'https://example.test' }, '0.1.9 已发布'],
    [
      { kind: 'error', message: '无法连接到 GitHub', at },
      '上次检查失败：无法连接到 GitHub（09:05）',
    ],
  ])('describes %j', (status, text) => {
    expect(updateStatusText(status)).toBe(text);
  });

  it('offers the action that fits the state', () => {
    expect(updateButton({ kind: 'unsupported' })).toBeUndefined();
    expect(updateButton({ kind: 'idle' })).toEqual({
      label: '检查更新',
      action: 'check',
      disabled: false,
    });
    expect(updateButton({ kind: 'checking' })).toEqual({
      label: '检查更新',
      action: 'check',
      disabled: true,
    });
    expect(updateButton({ kind: 'downloading', version: '0.1.9', percent: 5 })).toMatchObject({
      disabled: true,
    });
    expect(updateButton({ kind: 'downloaded', version: '0.1.9' })).toEqual({
      label: '立即重启',
      action: 'install',
      disabled: false,
    });
    expect(
      updateButton({ kind: 'available', version: '0.1.9', url: 'https://example.test' }),
    ).toEqual({
      label: '前往下载',
      action: 'install',
      disabled: false,
    });
    expect(updateButton({ kind: 'error', message: 'x', at })).toMatchObject({
      action: 'check',
      disabled: false,
    });
  });
});

describe('update notice', () => {
  it('appears once a version is downloaded, or published for a deb install', () => {
    expect(updateNotice({ kind: 'downloaded', version: '0.1.9' }, '')).toEqual({
      version: '0.1.9',
      text: 'Pilion 0.1.9 已下载，重启后生效',
      button: '立即重启',
    });
    expect(
      updateNotice({ kind: 'available', version: '0.1.9', url: 'https://example.test' }, ''),
    ).toEqual({ version: '0.1.9', text: 'Pilion 0.1.9 已发布', button: '前往下载' });
  });

  it('stays away while nothing is waiting, and for the version put off with 稍后', () => {
    expect(updateNotice(undefined, '')).toBeUndefined();
    expect(
      updateNotice({ kind: 'downloading', version: '0.1.9', percent: 50 }, ''),
    ).toBeUndefined();
    expect(updateNotice({ kind: 'downloaded', version: '0.1.9' }, '0.1.9')).toBeUndefined();
    expect(updateNotice({ kind: 'downloaded', version: '0.1.10' }, '0.1.9')).toMatchObject({
      version: '0.1.10',
    });
  });
});
```

Run: `pnpm exec vitest run tests/update-view.test.ts`
Expected: FAIL，找不到模块 `../src/renderer/update-view`。

- [ ] **Step 2: 实现 `update-view.ts`**

Create `src/renderer/update-view.ts`：

```ts
import type { UpdateStatus } from '../shared/contracts';

/** 设置页「更新」分区的状态文字。 */
export function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return '开发版本不检查更新';
    case 'idle':
      return '';
    case 'checking':
      return '正在检查…';
    case 'up-to-date':
      return `已是最新版本（${clock(status.checkedAt)}）`;
    case 'downloading':
      return `正在下载 ${status.version}（${status.percent}%）`;
    case 'downloaded':
      return `${status.version} 已下载，退出时安装`;
    case 'available':
      return `${status.version} 已发布`;
    case 'error':
      return `上次检查失败：${status.message}（${clock(status.at)}）`;
  }
}

export interface UpdateButton {
  label: string;
  /** check：检查更新；install：已下载时立即重启，deb 有新版本时打开 Release 页面。 */
  action: 'check' | 'install';
  disabled: boolean;
}

/** 状态旁边的按钮；开发版本不显示。 */
export function updateButton(status: UpdateStatus): UpdateButton | undefined {
  switch (status.kind) {
    case 'unsupported':
      return undefined;
    case 'checking':
    case 'downloading':
      return { label: '检查更新', action: 'check', disabled: true };
    case 'downloaded':
      return { label: '立即重启', action: 'install', disabled: false };
    case 'available':
      return { label: '前往下载', action: 'install', disabled: false };
    default:
      return { label: '检查更新', action: 'check', disabled: false };
  }
}

export interface UpdateNotice {
  version: string;
  text: string;
  button: string;
}

/** 主窗口提示条：已下载或 deb 有新版本时显示；点过「稍后」的那个版本，这次运行不再显示。 */
export function updateNotice(
  status: UpdateStatus | undefined,
  dismissedVersion: string,
): UpdateNotice | undefined {
  if (status?.kind !== 'downloaded' && status?.kind !== 'available') return undefined;
  if (status.version === dismissedVersion) return undefined;
  return status.kind === 'downloaded'
    ? {
        version: status.version,
        text: `Pilion ${status.version} 已下载，重启后生效`,
        button: '立即重启',
      }
    : { version: status.version, text: `Pilion ${status.version} 已发布`, button: '前往下载' };
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
```

Run: `pnpm exec vitest run tests/update-view.test.ts`
Expected: PASS。

- [ ] **Step 3: e2e 补上设置页的断言（会失败）**

把 Task 3 加的那条 e2e 整条替换为：

```ts
test('checking for updates opens the update section, which keeps its switch; dev builds never check', async () => {
  if (!application || !mainPage || !profileDirectory) throw new Error('Not launched');
  // 开发模式与 e2e 不创建 electron-updater，不会联网。
  expect(
    await mainPage.evaluate(() =>
      window.pilion.getState().then((state) => state.update?.status.kind),
    ),
  ).toBe('unsupported');
  const version = await application.evaluate(({ app }) => app.getVersion());
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('checkForUpdates')!.click(),
  );
  const settingsPage = await preferencesPage(application);
  await expect(settingsPage.getByRole('heading', { name: '通用' })).toBeVisible();
  await expect(settingsPage.getByText(`当前版本 ${version}`)).toBeVisible();
  await expect(settingsPage.getByText('开发版本不检查更新')).toBeVisible();
  await expect(settingsPage.getByRole('button', { name: '检查更新' })).toHaveCount(0);
  const autoUpdate = settingsPage.getByRole('checkbox', { name: /自动更新/ });
  await expect(autoUpdate).toBeChecked();
  await autoUpdate.click();
  await expect(autoUpdate).not.toBeChecked();
  const settingsFile = join(profileDirectory, 'settings.json');
  await expect
    .poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).autoUpdate)
    .toBe(false);
});
```

Run: `pnpm run build && pnpm exec playwright test -g "checking for updates"`
Expected: FAIL，找不到「当前版本 …」。

- [ ] **Step 4: 设置页「更新」分区**

`src/renderer/Preferences.tsx`：

导入改为：

```ts
import type { AppState, UpdateState, UpdateStatus } from '../shared/contracts';
```

并加：

```ts
import { updateButton, updateStatusText } from './update-view';
```

`PreferencesWindow` 里渲染 `GeneralPane` 的那行改为：

```tsx
<GeneralPane
  settings={settings}
  theme={theme}
  mac={mac}
  save={save}
  update={state.update}
  run={run}
/>
```

`GeneralPane` 的参数与类型加上 `update` 和 `run`：

```tsx
function GeneralPane({
  settings,
  theme,
  mac,
  save,
  update,
  run,
}: {
  settings: AppSettings;
  theme: string;
  /** 关窗后藏在 Dock 里只有 macOS 有：别的平台藏起来的窗口找不回来，主进程也不认这一项。 */
  mac: boolean;
  save(patch: AppSettingsPatch): void;
  update?: UpdateState;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
```

`GeneralPane` 返回的片段最后（`{mac && (...)}` 之后、`</>` 之前）加：

```tsx
<UpdateSection settings={settings} update={update} save={save} run={run} />
```

`GeneralPane` 之后加组件：

```tsx
function UpdateSection({
  settings,
  update,
  save,
  run,
}: {
  settings: AppSettings;
  update?: UpdateState;
  save(patch: AppSettingsPatch): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const status: UpdateStatus = update?.status ?? { kind: 'unsupported' };
  const button = updateButton(status);
  return (
    <section className="prefs-section">
      <h2>更新</h2>
      {update && <p className="prefs-update-version">{`当前版本 ${update.currentVersion}`}</p>}
      <label className="prefs-option">
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(event) => save({ autoUpdate: event.target.checked })}
        />
        <span>
          <strong>自动更新</strong>
          <small>启动时和每 4 小时检查一次，下载好后提示重启。</small>
        </span>
      </label>
      <div className="prefs-update-status">
        <span role="status">{updateStatusText(status)}</span>
        {button && (
          <button
            className="secondary-button"
            disabled={button.disabled}
            onClick={() =>
              void run(() =>
                button.action === 'install'
                  ? window.pilion.updates.install()
                  : window.pilion.updates.check(),
              )
            }
          >
            {button.label}
          </button>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: 主窗口提示条**

`src/renderer/main.tsx`：

加导入：

```ts
import { updateNotice } from './update-view';
```

`const [error, setError] = useState('');` 后面加：

```ts
// 点过「稍后」的版本，这次运行不再提示；之后下载到更高的版本会再提示。
const [dismissedUpdate, setDismissedUpdate] = useState('');
```

`const native = Boolean(window.pilion);` 后面加：

```ts
const notice = updateNotice(state.update?.status, dismissedUpdate);
```

`{cookieImport ? (` 前面加：

```tsx
{
  notice ? (
    <div className="find-bar cookie-bar" role="status" aria-label="Pilion 更新">
      <RefreshCw size={15} />
      <span className="cookie-bar-copy">{notice.text}</span>
      <button
        className="primary-button"
        onClick={() => void run(() => window.pilion.updates.install())}
      >
        {notice.button}
      </button>
      <button className="secondary-button" onClick={() => setDismissedUpdate(notice.version)}>
        稍后
      </button>
    </div>
  ) : null;
}
```

（`RefreshCw` 已在 `lucide-react` 的导入列表里。）

- [ ] **Step 6: 样式**

`src/renderer/style.css`：`.cookie-bar .primary-button { ... }` 后面加：

```css
.cookie-bar .secondary-button {
  height: 28px;
  padding: 0 12px;
  font-size: 11px;
}
```

`.prefs-select { ... }` 块后面加：

```css
.prefs-update-version {
  margin: 0 0 10px;
  color: var(--text);
  font-size: 12px;
}
.prefs-update-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 30px;
  margin-top: 10px;
  color: var(--subtle);
  font-size: 12px;
}
```

- [ ] **Step 7: 运行 e2e 与全量检查**

Run: `pnpm run build && pnpm exec playwright test -g "checking for updates"`
Expected: PASS。

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/update-view.ts tests/update-view.test.ts src/renderer/Preferences.tsx src/renderer/main.tsx src/renderer/style.css tests/electron.e2e.ts
git commit -m "feat(ui): show update status in settings and a restart prompt in the browser"
```

---

### Task 5: 文档

**Files:**

- Modify: `README.md`、`CHANGELOG.md`、`docs/design/settings-and-menu.md`、`docs/architecture.md`、`docs/superpowers/specs/2026-10-11-auto-update-design.md`

**Interfaces:**

- Consumes: 前四个任务实现的行为与文案
- Produces: 无

- [ ] **Step 1: README**

「安装」一节，`Windows 安装包未签名，会出现 SmartScreen 提示，选择「仍要运行」。` 后面另起一段：

```markdown
从 0.1.8 起，Pilion 会在启动时和每 4 小时检查一次新版本，在后台下载好后提示重启；不点重启的话，下次退出时自动安装。不想自动更新可以在「设置 › 通用 › 更新」里关掉。Linux deb 包只提示新版本，需要自己下载安装。0.1.7 及更早的版本没有这个功能，需要先手动安装一次新版本。
```

「打包」一节，提到 secrets 的那段后面另起一段：

```markdown
在 GitHub 上把草稿 Release 点「发布」之后，已安装的 Pilion 会读到 Release 里的 `latest-mac.yml`、`latest.yml`、`latest-linux.yml` 并开始更新；草稿和预发布不会推送给用户。
```

- [ ] **Step 2: CHANGELOG**

`## [未发布]` 下面、`### 变更` 前面加：

```markdown
### 新增

- 自动更新：Pilion 会在启动时和每 4 小时检查一次新版本，在后台下载好后，地址栏下方提示「重启后生效」，可以立即重启，也可以等下次退出时自动安装。Agent 正在执行任务、有等待审批的操作，或正在录制、回放技能时点「立即重启」，会先确认一次。「设置 › 通用」新增「更新」分区，可以看当前版本、手动检查、关掉自动更新；菜单里也有「检查更新…」。Linux deb 包只提示新版本、不自动安装。0.1.7 及更早的版本需要先手动安装一次 0.1.8。
```

- [ ] **Step 3: 设置与菜单设计文档**

`docs/design/settings-and-menu.md`：

- 菜单表 Pilion 行：`关于 Pilion、设置… ⌘,、服务` 改为 `关于 Pilion、检查更新…、设置… ⌘,、服务`。
- 菜单表帮助行：`使用说明、反馈问题` 改为 `使用说明、反馈问题（Windows、Linux 上另有检查更新…、关于 Pilion）`。
- 「四、`settings.json`」第一条，`agentWindowBehavior`（默认 `foreground`）后面加：`、`autoUpdate`（默认 `true`，只管自动检查和下载，已经下好的更新退出时总会安装）`。
- 「五、设置窗口内容」**通用** 一行末尾的句号前加：`；更新（当前版本、自动更新开关、检查更新 / 立即重启）`。
- 「七、分期」三期：`快捷键可改、多工作区 / Profiles（独立立项）、更新检查（需要 autoUpdater）。` 改为 `快捷键可改、多工作区 / Profiles（独立立项）。更新检查已随 0.1.8 的自动更新实现，见 docs/superpowers/specs/2026-10-11-auto-update-design.md。`

- [ ] **Step 4: 架构文档**

`docs/architecture.md`：

- 模块表加一行：`| `main/updater.ts` | 自动更新：检查时机、下载、退出时安装，包装 electron-updater |`。
- 「当前边界」里签名那条后面加：

```markdown
- 自动更新只采用本仓库 GitHub Releases 里已发布、非预发布的版本：经 HTTPS 下载，校验 `latest-*.yml` 里的 sha512；macOS 上 Squirrel.Mac 另外要求新版本与当前版本同一开发者签名（同一 Team ID），Windows 安装包未签名，完整性只依赖 HTTPS 与 GitHub 账号本身的安全。更新请求走 electron-updater 自己的 session（系统代理），不经过网页的隔离分区与受控代理。开发模式和 e2e 不检查更新。
```

- 「验证」一段，第一句 `…与真实 Unix socket MCP 回程。` 后面加：`自动更新的检查时机、状态流转、错误文案与「立即重启」前的确认条件由 `tests/updater.test.ts` 覆盖。`

- [ ] **Step 5: 设计文档状态**

`docs/superpowers/specs/2026-10-11-auto-update-design.md` 的 `> 状态：设计已确认，待实现` 改为 `> 状态：已实现，随 0.1.8 发布`。

- [ ] **Step 6: 格式与提交**

Run: `pnpm exec prettier --write README.md CHANGELOG.md docs/design/settings-and-menu.md docs/architecture.md docs/superpowers/specs/2026-10-11-auto-update-design.md && pnpm format:check`
Expected: 通过（表格会被重新对齐）。

```bash
git add README.md CHANGELOG.md docs/design/settings-and-menu.md docs/architecture.md docs/superpowers/specs/2026-10-11-auto-update-design.md
git commit -m "docs: describe automatic updates"
```

---

### Task 6: macOS 真机演练

**Files:** 无代码改动。构建产物放在 `release/rehearsal/`（已被 `.gitignore` 忽略），驱动脚本放在 `release/rehearsal/drive.mjs`。

**Interfaces:**

- Consumes: Task 1–4 的全部行为
- Produces: 演练结论（四个场景通过与否），写进最终汇报

- [ ] **Step 1: 前置检查与备份**

先向用户确认：演练期间不使用 Pilion。Squirrel 安装后重新打开应用时不带 `--user-data-dir`，会用真实的配置目录，所以先备份、结束后还原。

```bash
pgrep -fl 'Pilion.app/Contents/MacOS/Pilion' && echo "请先退出 Pilion"
if [ -d "$HOME/Library/Application Support/Pilion" ]; then
  tar -czf /tmp/pilion-userdata-backup.tgz -C "$HOME/Library/Application Support" Pilion && echo backed-up
fi
```

- [ ] **Step 2: 构建旧版 0.1.98 与新版 0.1.99**

只打 arm64 zip，不公证；更新源改成本机的 generic 源。日志里遮掉 .p12 密码，结束时还原钥匙串搜索列表。

```bash
cat > /tmp/pilion-rehearsal-build.sh <<'EOF'
#!/bin/bash
set -uo pipefail
version="$1"
cd /Users/qingyun/Documents/GitHub/pilion-browser
trap 'security list-keychains -d user -s "$HOME/Library/Keychains/login.keychain-db"' EXIT
export CSC_LINK="$HOME/.pilion-signing/pilion-devid.p12"
export CSC_KEY_PASSWORD="$(security find-generic-password -a pilion -s pilion-signing-p12 -w)"
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_KEYCHAIN_PROFILE
pnpm exec electron-builder --mac zip --arm64 --publish never \
  -c.extraMetadata.version="$version" \
  -c.publish.provider=generic -c.publish.url=http://127.0.0.1:8123 \
  -c.directories.output="release/rehearsal/$version" 2>&1 | sed -u "s/${CSC_KEY_PASSWORD}/***/g"
EOF
chmod +x /tmp/pilion-rehearsal-build.sh
pnpm run build
/tmp/pilion-rehearsal-build.sh 0.1.98
/tmp/pilion-rehearsal-build.sh 0.1.99
ls release/rehearsal/0.1.99
```

Expected: `release/rehearsal/0.1.99/` 里有 `Pilion-0.1.99-mac-arm64.zip` 和 `latest-mac.yml`。没有 `latest-mac.yml` 时手写一份：

```bash
cd release/rehearsal/0.1.99
zip=Pilion-0.1.99-mac-arm64.zip
sha=$(openssl dgst -sha512 -binary "$zip" | base64)
size=$(stat -f%z "$zip")
printf "version: 0.1.99\nfiles:\n  - url: %s\n    sha512: %s\n    size: %s\npath: %s\nsha512: %s\nreleaseDate: '%s'\n" \
  "$zip" "$sha" "$size" "$zip" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > latest-mac.yml
cd -
```

- [ ] **Step 3: 本地更新源、驱动脚本与安装旧版**

```bash
python3 -m http.server 8123 --bind 127.0.0.1 --directory release/rehearsal/0.1.99   # 后台运行
cat > release/rehearsal/drive.mjs <<'EOF'
import { chromium } from '@playwright/test';
const [command, arg] = process.argv.slice(2);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const pages = browser.contexts().flatMap((context) => context.pages());
const main = pages.find(
  (page) => page.url().includes('index.html') && !page.url().includes('window=preferences'),
);
if (command === 'state')
  console.log(JSON.stringify(await main.evaluate(() => window.pilion.getState().then((s) => s.update))));
if (command === 'click') await main.getByRole('button', { name: arg, exact: true }).click();
if (command === 'eval') console.log(JSON.stringify(await main.evaluate(arg)));
await browser.close();
EOF
cat > /tmp/pilion-rehearsal-install.sh <<'EOF'
#!/bin/bash
set -euo pipefail
pkill -f 'pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion' || true
rm -rf "$HOME/pilion-rehearsal" "$HOME/Library/Caches/pilion-browser-updater" "$HOME/Library/Caches/com.echovic.pilion.ShipIt"
mkdir -p "$HOME/pilion-rehearsal/profile"
[ -n "${1:-}" ] && printf '%s' "$1" > "$HOME/pilion-rehearsal/profile/settings.json"
ditto -x -k /Users/qingyun/Documents/GitHub/pilion-browser/release/rehearsal/0.1.98/Pilion-0.1.98-mac-arm64.zip "$HOME/pilion-rehearsal/"
EOF
chmod +x /tmp/pilion-rehearsal-install.sh
```

启动旧版（后台运行）：

```bash
"$HOME/pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion" --user-data-dir="$HOME/pilion-rehearsal/profile" --remote-debugging-port=9333
```

等待下载完成（开启后 30 秒检查，随后下载）：

```bash
until node release/rehearsal/drive.mjs state | grep -q '"downloaded"'; do sleep 5; done
```

- [ ] **Step 4: 场景 1——立即重启**

`/tmp/pilion-rehearsal-install.sh`，启动旧版，等到 `downloaded`。截屏确认地址栏下方有「Pilion 0.1.99 已下载，重启后生效」：`screencapture -x /tmp/pilion-r1.png`。然后：

```bash
node release/rehearsal/drive.mjs click 立即重启
sleep 20
defaults read "$HOME/pilion-rehearsal/Pilion.app/Contents/Info.plist" CFBundleShortVersionString
pgrep -fl 'pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion'
```

Expected: 版本号为 `0.1.99`，并且有进程在运行（已经重新打开）。随后 `pkill -f 'pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion'`。

- [ ] **Step 5: 场景 2——稍后，退出时安装**

`/tmp/pilion-rehearsal-install.sh`，启动旧版，等到 `downloaded`。

```bash
node release/rehearsal/drive.mjs click 稍后
osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is '"$(pgrep -f 'pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion' | head -1)"') to true' 2>/dev/null || true
osascript -e 'tell application id "com.echovic.pilion" to quit'
sleep 20
defaults read "$HOME/pilion-rehearsal/Pilion.app/Contents/Info.plist" CFBundleShortVersionString
```

Expected: 点「稍后」后提示条消失（截屏确认），退出后版本号为 `0.1.99`，且没有被重新打开。

- [ ] **Step 6: 场景 3——「关闭窗口时退出」关掉、设置窗口开着**

`/tmp/pilion-rehearsal-install.sh '{"quitOnWindowClose":false}'`，启动旧版，等到 `downloaded`。

```bash
node release/rehearsal/drive.mjs eval "window.pilion.settings.open({ pane: 'general' })"
node release/rehearsal/drive.mjs click 立即重启
sleep 20
defaults read "$HOME/pilion-rehearsal/Pilion.app/Contents/Info.plist" CFBundleShortVersionString
```

Expected: 版本号为 `0.1.99`，应用重新打开，没有卡在「窗口被藏起来、进程还在」。

- [ ] **Step 7: 场景 4——有进行中的工作时先确认**

`/tmp/pilion-rehearsal-install.sh`，启动旧版，等到 `downloaded`。打开网页并开始录制，让应用处于「有进行中的工作」：

```bash
node release/rehearsal/drive.mjs eval "window.pilion.tabs.navigate('https://example.com')"
sleep 3
node release/rehearsal/drive.mjs eval "window.pilion.recording.start()"
node release/rehearsal/drive.mjs click 立即重启
screencapture -x /tmp/pilion-r4.png
```

Expected: 截图里有「现在重启会中断正在进行的工作」确认框。请用户点「取消」，然后：

```bash
node release/rehearsal/drive.mjs eval "window.pilion.getState().then((s) => Boolean(s.recording))"
defaults read "$HOME/pilion-rehearsal/Pilion.app/Contents/Info.plist" CFBundleShortVersionString
```

Expected: 录制仍在进行（`true`），版本号仍为 `0.1.98`。

- [ ] **Step 8: 清理与还原**

```bash
pkill -f 'pilion-rehearsal/Pilion.app/Contents/MacOS/Pilion' || true
pkill -f 'http.server 8123' || true
rm -rf "$HOME/pilion-rehearsal" "$HOME/Library/Caches/pilion-browser-updater" "$HOME/Library/Caches/com.echovic.pilion.ShipIt" release/rehearsal
if [ -f /tmp/pilion-userdata-backup.tgz ]; then
  rm -rf "$HOME/Library/Application Support/Pilion"
  tar -xzf /tmp/pilion-userdata-backup.tgz -C "$HOME/Library/Application Support"
  rm /tmp/pilion-userdata-backup.tgz
fi
security list-keychains -d user
```

Expected: 演练目录、缓存都已删除，真实配置目录已还原，钥匙串搜索列表只有登录钥匙串。

---

### Task 7: 全量检查、推送与 CI

**Files:** 无代码改动。

**Interfaces:**

- Consumes: 整个分支
- Produces: 分支已推送、CI 构建通过、汇报给用户（不合并、不发版，等用户决定）

- [ ] **Step 1: 全量检查**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`
Expected: 全部通过。

- [ ] **Step 2: 推送并跑发布流程（不发版）**

```bash
git push -u origin feat/auto-update
gh workflow run release.yml --ref feat/auto-update
gh run list --workflow release.yml --limit 1
```

等待运行结束（macOS 任务含公证，可能较久），三个平台都应成功。

- [ ] **Step 3: 检查 CI 产物**

```bash
run=$(gh run list --workflow release.yml --branch feat/auto-update --limit 1 --json databaseId -q '.[0].databaseId')
rm -rf /tmp/pilion-ci && gh run download "$run" -n pilion-macOS -D /tmp/pilion-ci
mkdir -p /tmp/pilion-ci/app && ditto -x -k /tmp/pilion-ci/Pilion-*-mac-arm64.zip /tmp/pilion-ci/app
cat /tmp/pilion-ci/app/Pilion.app/Contents/Resources/app-update.yml
spctl -a -vvv -t exec /tmp/pilion-ci/app/Pilion.app
xcrun stapler validate /tmp/pilion-ci/app/Pilion.app
```

Expected: `app-update.yml` 是 `provider: github`、`owner: echoVic`、`repo: pilion-browser`；Gatekeeper `accepted`、`source=Notarized Developer ID`；stapler 通过。

- [ ] **Step 4: 汇报**

向用户汇报：各任务结果、演练四个场景的结论、CI 结果；询问是否合并 `fix/mac-signing-keychain` 与 `feat/auto-update` 并发布 0.1.8。
