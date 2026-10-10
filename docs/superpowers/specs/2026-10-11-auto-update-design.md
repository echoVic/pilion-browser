# 自动更新

> 状态：已实现，随 0.1.8 发布
> 日期：2026-10-11
> 目标版本：0.1.8（与 macOS 签名、公证一起发布）

## 目标

已安装的 Pilion 自己发现、下载并安装新版本，用户不用再去 GitHub 手动下载。你在 GitHub 上点「发布」之后，用户在下次启动或几个小时之内看到更新；更新不打断正在进行的 Agent 任务；不想自动更新的人可以关掉。

## 现状

发布端已经就绪。`release.yml` 在 `v*` 标签上运行 `electron-builder --publish always`，草稿 Release 里除了安装包，还已经有 electron-updater 需要的元数据和增量下载用的 blockmap（0.1.7 实际上传的文件）：

| 平台    | 元数据             | 安装包                                |
| ------- | ------------------ | ------------------------------------- |
| macOS   | `latest-mac.yml`   | arm64 与 x64 的 `.zip`（另有 `.dmg`） |
| Windows | `latest.yml`       | NSIS `.exe`                           |
| Linux   | `latest-linux.yml` | `.AppImage`、`.deb`                   |

缺的是客户端：应用里没有任何检查更新的代码。

macOS 的自动更新走 Squirrel.Mac，要求应用已签名，并且新版本与正在运行的版本出自同一个开发者签名。签名与公证从 0.1.8 起生效（`fix/mac-signing-keychain`），本设计建立在它之上。

## 非目标

- 不做预发布或测试通道。草稿和预发布版本不推送给任何人。
- 不做强制更新、最低版本限制或回滚。
- 不在应用内展示更新内容；更新内容看 GitHub Release。
- 不做 Windows 代码签名，也不做下载镜像或加速。
- 不在后台安装 Linux deb 包（需要管理员密码，见下文）。
- 0.1.7 及更早的版本没有更新代码，这些用户需要手动安装一次 0.1.8。

## 用户看到的行为

### 检查与下载

- 「自动更新」开着时，启动后约 30 秒检查一次，之后每 4 小时检查一次。
- 发现新版本就在后台下载，不打扰。设置页「更新」分区显示进度。
- 「检查更新」随时可以手动触发，开关关着时也可以；手动检查发现新版本同样会下载。
- 开关只管自动检查和自动下载。已经下载好的更新，不论开关状态，退出 Pilion 时都会安装。关掉开关不中断正在进行的下载。

### 提示条

下载完成后，主窗口地址栏下方出现一条提示，样式沿用「导入 Chrome cookie」的提示条：

> Pilion x.y.z 已下载，重启后生效　［立即重启］［稍后］

- 「稍后」：本次运行不再为这个版本显示提示条（记在主窗口渲染层，按版本号区分）。下次退出时安装，再打开就是新版本。之后若又下载了更高的版本，提示条会再次出现。
- 设置页的「更新」分区始终显示「x.y.z 已下载，退出时安装」和「立即重启」按钮。

### 立即重启

- 没有进行中的工作：直接走退出流程，安装并重新打开。
- 有进行中的工作时，先弹原生确认框（主进程的 `dialog.showMessageBox`，挂在当前窗口上）。「进行中的工作」指以下任一项：Agent 状态为 `starting`、`running` 或 `stopping`；有等待审批的操作；正在录制；正在回放技能（包括 Agent 发起的回放）；正在提炼技能。

  > 现在重启会中断正在进行的工作
  > Agent 的任务、等待审批的操作、录制或技能回放都会停止。　［立即重启］［取消］

- 确认后走现有的退出流程（`shutdown()`：停止录制、保存工作区、处理审批、断开 Agent、停止子进程），再安装并重新打开。

### 设置

`AppSettings` 新增 `autoUpdate: boolean`，默认 `true`，读坏时回退为 `true`。

设置窗口「通用」页最后加「更新」分区：

- 当前版本号。
- 开关「自动更新」，说明文字：「启动时和每 4 小时检查一次，下载好后提示重启」。
- 一行状态，加一个随状态变化的按钮：

| 状态                    | 文字                       | 按钮     |
| ----------------------- | -------------------------- | -------- |
| 尚未检查                | （空）                     | 检查更新 |
| 检查中                  | 正在检查…                  | （禁用） |
| 已是最新                | 已是最新版本（时间）       | 检查更新 |
| 下载中                  | 正在下载 x.y.z（35%）      | （禁用） |
| 已下载                  | x.y.z 已下载，退出时安装   | 立即重启 |
| 有新版本、需手动（deb） | x.y.z 已发布               | 前往下载 |
| 出错                    | 上次检查失败：原因（时间） | 检查更新 |
| 不支持（开发版、e2e）   | 开发版本不检查更新         | （无）   |

### 菜单

- macOS：Pilion 菜单「关于 Pilion」下面加「检查更新…」。
- Windows、Linux：帮助菜单「关于 Pilion」上面加「检查更新…」。
- 点击后打开设置窗口的通用页并立即检查，结果显示在「更新」分区。

### Linux

- AppImage 与其他平台一样自动下载、退出时安装。
- deb 包的安装需要 `pkexec`/`sudo`，没法在后台静默完成，在退出时弹密码框也不合适。所以 deb 版只提示不下载：提示条显示「Pilion x.y.z 已发布　［前往下载］［稍后］」，按钮打开该版本的 GitHub Release 页面。
- 判断方式与 electron-updater 一致：Linux 上有 `APPIMAGE` 环境变量就是 AppImage，否则按 deb 处理。

## 架构

### `src/main/updater.ts`

包装 electron-updater 的控制器，不直接 import Electron 之外的全局状态，依赖都从构造参数传入，单元测试用假的 updater 和假的计时器：

```ts
interface UpdaterDeps {
  updater: UpdaterLike; // electron-updater 的 autoUpdater，或测试替身
  currentVersion: string;
  manualOnly: boolean; // Linux deb：只提示不下载
  releaseUrl: (version: string) => string;
  openExternal: (url: string) => void; // 「前往下载」用系统浏览器打开
  onChange: (state: UpdateState) => void;
  timers?: TimerLike; // 默认 setTimeout/setInterval
}

class UpdateController {
  setAutoUpdate(enabled: boolean): void; // 开：30 秒后首次检查并每 4 小时一次；关：清掉计时器
  checkNow(): Promise<void>; // 手动检查；检查进行中时合并为同一次
  installNow(): void; // downloaded：quitAndInstall；available（deb）：打开 Release 页面；其他状态无操作
  get state(): UpdateState;
}
```

- `autoDownload` 固定为 `false`，由控制器在 `update-available` 时决定：`manualOnly` 进入「需手动」状态，否则调用 `downloadUpdate()`。这样手动检查和自动检查走同一条路。
- `autoInstallOnAppQuit` 保持 `true`。
- 下载进度最多每 500 毫秒上报一次，避免频繁广播状态。
- electron-updater 的日志接到 `console`，不进界面的事件记录。
- `main.ts` 在启动时、以及每次 `settings:save` 改到 `autoUpdate` 时调用 `setAutoUpdate()`。

### 状态与广播

`src/shared/contracts.ts` 新增：

```ts
export type UpdateStatus =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'available'; version: string; url: string } // 只提示（deb）
  | { kind: 'error'; message: string; at: number };

export interface UpdateState {
  currentVersion: string;
  status: UpdateStatus;
}
```

`AppState.update?: UpdateState`，随现有的 `emit()` 一起发给主窗口和设置窗口。

### IPC

| 通道             | 作用                                                                | 谁可以调用       |
| ---------------- | ------------------------------------------------------------------- | ---------------- |
| `update:check`   | 立即检查                                                            | 主窗口、设置窗口 |
| `update:install` | 已下载：立即重启安装（忙时先确认）；deb 有新版本：打开 Release 页面 | 主窗口、设置窗口 |

两个通道都不带参数。设置窗口的「立即重启」按钮需要 `update:install`，所以它和 `update:check` 一样用 `{ preferences: true }` 放行；是否需要确认由主进程判断，与从哪个窗口调用无关。preload 暴露 `window.pilion.updates.check()` 与 `install()`。

「前往下载」也调用 `update:install`：主进程用 `shell.openExternal` 打开它自己算出的 Release 地址（`https://github.com/echoVic/pilion-browser/releases/tag/v<版本>`）。设置窗口不能开标签页，渲染层也不传 URL 进来，主进程不会替页面打开任意链接。

### 退出流程

`quitAndInstall()` 会先关闭所有窗口，再调用 `app.quit()`，而 `before-quit` 要等窗口都关完才触发。Pilion 的设置窗口、以及「关闭窗口时退出」关掉时的主窗口，都只在 `quitting` 置位后才真的关闭，否则只是藏起来，退出就会卡住。

所以在 Electron 的 `autoUpdater` 上监听 `before-quit-for-update`，一触发就置 `quitting = true`。之后的 `before-quit` 照旧调用 `shutdown()` 再退出，安装在进程退出后进行。

### 启用条件

只有 `app.isPackaged && process.env.NODE_ENV !== 'test'` 时创建 electron-updater 实例。开发模式和 e2e 测试（包括用 `PILION_E2E_EXECUTABLE` 跑打包版）都不会联网，状态为 `unsupported`。

### 依赖

`electron-updater@6.8.10` 加入 `dependencies`。主进程由 `tsc` 编译、不经打包工具，运行时依赖必须进 `dependencies` 才会被打进 asar。6.8.10 与 electron-builder 26.16.x 同属 v26 维护线，修过从 GitHub 增量下载的问题。

## 出错处理

- 自动检查失败（断网、连不上 GitHub）：不弹错误，只在设置页显示「上次检查失败：原因（时间）」，下一个周期重试。手动检查失败在同一位置显示。
- 下载中断：下个周期重新检查，electron-updater 会复用已下载的部分或重新下载。
- 常见错误转成中文：
  - 网络错误（`ENOTFOUND`、`ETIMEDOUT`、`ECONNRESET`、`net::ERR_*`）：「无法连接到 GitHub」。
  - sha512 不符：「更新包校验失败」，不安装。
  - macOS 签名校验不通过（Squirrel.Mac 的 code signature 错误）：「更新包签名校验失败」，不安装。
  - 只读卷或未放进「应用程序」（Squirrel.Mac 的 read-only volume 错误）：「请把 Pilion 拖到「应用程序」文件夹后再更新」。
  - 其他：原样显示错误信息。
- 安装失败：旧版本照常运行，状态显示错误。

## 安全

- 更新源是本仓库的 GitHub Releases，经 HTTPS 获取。只有已发布、非预发布的 Release 会被采用；草稿是发布前的人工把关。
- electron-updater 校验安装包的 sha512，sha512 来自同一个 Release 的 `latest-*.yml`。这能挡住传输损坏，挡不住 GitHub 账号被盗后的整体替换。
- macOS 上 Squirrel.Mac 另外要求新版本满足当前版本的签名要求（同一个 Team ID），被替换的包装不上。
- Windows 安装包未签名，完整性只依赖 HTTPS 与 GitHub 账号本身的安全。以后给 Windows 签名时，再配置发布者校验。
- 更新请求走 electron-updater 自己的 session，使用系统代理设置，不经过网页所在的隔离分区和受控代理。网页的网络边界不受影响。

## 发布流程

不需要改：打 `v*` 标签，CI 把安装包与 `latest-*.yml` 上传到草稿 Release；在 GitHub 上点「发布」后，客户端在下次启动或 4 小时内收到。

## 测试

- 单元测试 `tests/updater.test.ts`，用假 updater 与假计时器：
  - 状态流转：检查 → 下载（进度节流）→ 已下载；检查 → 已是最新；检查或下载出错。
  - 开关：打开后 30 秒首次检查、之后每 4 小时；关闭后不再检查；关闭不中断进行中的下载。
  - 并发：检查进行中再次检查只发起一次。
  - deb 模式：发现新版本进入「需手动」，不下载，`url` 指向该版本的 Release。
  - `installNow()` 只在已下载时调用 `quitAndInstall`。
  - 错误信息映射。
- 单元测试 `tests/settings.test.ts`：`autoUpdate` 缺省为 `true`，读坏回退为 `true`，补丁可以单独改它。
- e2e（开发模式）：
  - 设置窗口通用页有「更新」分区，显示当前版本与「开发版本不检查更新」。
  - 「自动更新」开关写入 `settings.json`，重启后保持。
  - 菜单里有「检查更新…」，点击打开设置窗口的通用页。
- 真机演练（发布前，macOS）：本机构建两个签名版本，版本号不同，发布配置改为指向本机 HTTP 服务的 generic 源。装上旧版本后验证：
  1. 发现新版本、下载、出现提示条、「立即重启」后版本号变为新版本。
  2. 「稍后」后退出，再打开已是新版本。
  3. 「关闭窗口时退出」关掉、设置窗口开着的情况下，「立即重启」不卡住。
  4. Agent 执行任务时点「立即重启」先弹确认，取消后任务继续。
- Windows 与 Linux：CI 验证能正常打包；实际更新在 0.1.8 发布后、发布 0.1.9 时验证。

## 文档

- README「安装」：说明装好后会自动更新，可在「设置 › 通用」关闭；0.1.7 及以前需要手动安装一次。
- CHANGELOG「未发布」：新增自动更新。
- `docs/design/settings-and-menu.md`：菜单表加「检查更新…」，三期的「更新检查」标为已实现，`settings.json` 一节加 `autoUpdate`。
- `docs/architecture.md`：主进程会访问 GitHub 检查与下载更新，更新包的校验方式见上文「安全」。
