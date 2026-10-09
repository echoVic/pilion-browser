# Pilion 菜单栏 & 设置窗口 设计方案

> 状态：一期已实现（0.1.6）
> 更新：2026-10-09
> 范围：一期落地情况 + 二期/三期边界

---

## 一、决策记录

### 1. 设置窗口：独立窗口 + 懒创建

- ⌘, 或菜单「设置…」第一次打开时才创建；关闭只是 `hide()`，再开时原样显示。
- 渲染层复用同一份 bundle，以 `?window=preferences` 打开时渲染 `PreferencesWindow`（`src/renderer/Preferences.tsx`），preload 不变。
- 不设 `parent`：macOS 上子窗口会跟着主窗口一起移动、一起最小化。主窗口销毁时由主进程顺手销毁设置窗口。
- 设置窗口的 `close` 只在应用退出时放行（`before-quit` 一开始就置 `quitting`）。否则它拦下的 close 会让 ⌘Q 整个作废。
- 侧栏的「Agent 连接」页面保留在主窗口里（首次连接 Agent 的流程在这里，e2e 也覆盖它）；设置窗口的 Agent 页嵌入同一个 `AgentSettings`。

### 2. 安全相关开关：不进设置

审批开关、蒙层、`full` 权限作为全局默认、忽略证书错误、私网拦截——这些是产品定义，不是偏好，任何版本都不进设置 UI。未来真要开口子（例如允许特定私网网段），必须放在高级页、文案写清放弃了什么、二次确认并记日志，且单独评审。

### 3. 设为默认浏览器：二期，路由保守

外部 http(s) 链接进来时开新标签页、落在当前工作区，不自动交给 Agent。自动交给 Agent 的开关（默认关）等二期上线后看反馈再定。

---

## 二、快捷键：一份定义

`src/shared/keybindings.ts` 是唯一的定义处：

- `interceptedShortcut()`：主窗口渲染层的 keydown 和网页视图的 `before-input-event` 都用它判断。这类快捷键网页拿不到（⌘T、⌘W、⌘L、⌘1–9……）。
- 其余快捷键（⌘,、⌘D）只挂在菜单上：网页没拦下时由菜单接住，所以设置窗口里也能用。
- 菜单的 accelerator 通过 `acceleratorFor()` 从同一张表取。

渲染层里所有入口——自己按的快捷键、网页里按下被主进程转来的快捷键（`app:shortcut`）、菜单动作（`app:command`）——都进同一个 `performAction`，做的事与界面上对应的按钮一样。

---

## 三、菜单栏

`src/main/menu.ts` 只负责拼模板；`main.ts` 的 `refreshMenu()` 在菜单显示的状态（最近关闭的标签页、Agent 连接与任务状态、是否在录制）变化时才重建。`emit()` 很频繁，每次都 `setApplicationMenu` 会让展开着的菜单被收起。

| 菜单     | 项目                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Pilion   | 关于 Pilion、设置… ⌘,、服务、隐藏、隐藏其他、全部显示、退出（macOS 专有）                                          |
| 文件     | 新建标签页 ⌘T、打开位置… ⌘L、重新打开关闭的标签页 ⇧⌘T、关闭标签页 ⌘W、新对话、从 Chrome 导入 Cookie…               |
| 编辑     | 撤销、重做、剪切、拷贝、粘贴、粘贴并匹配样式、删除、全选（全部是 role 项）、查找… ⌘F                               |
| 显示     | 侧边栏、Agent 面板、刷新 ⌘R、停止载入、实际大小 / 放大 / 缩小、对话记录、下载；开发版另有开发者工具                |
| 历史记录 | 后退 ⌘[、前进 ⌘]、显示全部历史记录、最近关闭的标签页（子菜单）                                                     |
| 书签     | 添加或移除书签 ⌘D、显示全部书签                                                                                    |
| Agent    | 管理 Agent 连接…、共享浏览器 / 暂停浏览器权限、接管浏览器、停止任务、继续任务、断开 Agent、开始 / 停止录制、技能库 |
| 窗口     | 最小化、缩放、前置全部窗口                                                                                         |
| 帮助     | 使用说明、反馈问题                                                                                                 |

路由规则：

- 菜单动作一律发给主窗口渲染层的 `performAction`，和快捷键、按钮走同一段代码。录制对前进后退刷新的记账、Agent 驾驶时的禁用条件因此不会被菜单绕过。
- 设置窗口在前时，⌘W 关闭设置窗口；其余动作作用在浏览器窗口上，先把它带到前面。
- Agent 菜单项的可用状态与界面按钮一致：接管只在 Agent 正在操作时可用，继续任务只在人接管后且连接空闲时可用。
- 「清除历史记录」不进菜单：一点即删、没有确认，留在历史记录页里。

---

## 四、`settings.json`

全局设置，与每个工作区自己的 `workspace.json` 分开。

- 结构定义在 `src/shared/settings.ts`（主进程、渲染层、preload 共用）：`theme`、`startupBehavior`、`searchEngine`、`quitOnWindowClose`（默认 `true`，即保持旧行为）、`agentWindowBehavior`（默认 `foreground`）。
- 文件里某一项被改坏只回退那一项，未知的键读入时丢掉，整个文件读不出就用默认值。
- 渲染层只送改动的几项；`AppSettingsPatchSchema` 是 strict 的、没有默认值，免得一次局部保存把其余项重置。
- 落盘沿用 `WorkspaceStore` 的写临时文件再 rename。
- 设置随 `AppState.settings` 广播，主窗口和设置窗口都从这里读，改了两边立刻生效。
- 主题以 settings.json 为准；`localStorage` 只留副本，让窗口在设置到达前先用上次的主题。旧版只存在 `localStorage` 的主题在第一次启动时迁过来。

IPC 信任边界：`trustedRenderer()` 默认只认主窗口自己的主 frame。设置窗口只在 `handle(..., { preferences: true })` 显式放行的通道上被认：状态、设置读写、Agent 连接的增删改查与本机检测、选择目录。审批通道永远只认主窗口。

---

## 五、设置窗口内容

**通用**：主题（浅色 / 跟随系统 / 深色）；打开 Pilion 时恢复上次的标签页或打开新标签页；地址栏搜索引擎（Google / Bing / DuckDuckGo）；关闭窗口时退出 Pilion（关掉后关窗只是藏起来，点 Dock 图标回来）。

**Agent**：Agent 操作页面时「前台显示」或「后台静默」；Agent 连接管理（嵌入 `AgentSettings`，不带页眉）。

**一期没做、挪到二期**：下载位置（`requireDownload` 的路径校验以系统下载目录为前提，改它要连安全校验一起改）、默认权限模式。

---

## 六、Agent 窗口行为

### 根因

窗口被抢占来自 `AgentShield.update()`：Agent 每次开始操作页面，护罩升起时调用 `parent.webContents.focus()`，把键盘焦点从网页移回 Pilion 自己的界面，免得人的按键落进护罩下面的网页。Electron 在 macOS 上的 `webContents.focus()` 会顺带激活应用并 `makeKeyAndOrderFront`，于是整个窗口被拉到最前。

`bindPage` 里网页 `before-input-event` 的那次 focus 是人在网页里按快捷键触发的，窗口本来就在前台，与抢占无关，两种模式下都照常执行。

页面操作走 CDP（`electron-page-adapter.ts` 经 `wc.debugger`），不要求窗口在前台，所以静默模式不需要改输入注入。

### 实现

- `takeShellFocus()`：静默模式下窗口不在前台时不调 `webContents.focus()`；前台模式行为不变。`AgentShield` 的两处 focus 与网页 `focus` 事件里的那处都改走它。
- 主窗口 `focus` 事件：护罩锁着时把焦点移回 Pilion 界面。静默模式下开工时没抢焦点，人切回来的那一刻补上，键盘输入不会落进护罩下的网页。
- `requestAttention()`：Agent 发起审批、或把浏览器交还给人（`request_human`、技能回放卡在需要人的步骤、目标暂停）时，窗口不在前台就让 Dock 图标跳一下（其他平台闪任务栏）。不抢焦点，两种模式都适用。

### 注意

- 不提供「可见但不抢焦点」（`showInactive`）第三档：macOS 跨版本行为不一致，价值有限。
- 网页自己调用 `window.focus()` 时会不会拉起窗口不在我们控制之内。

---

## 七、分期

### 一期（0.1.6，已实现）

快捷键单一定义；`settings.json` 与广播；关于面板；原生菜单（role 保真、动态项、按状态重建）；懒创建的设置窗口（通用 + Agent）；静默模式与 Dock 提醒；关闭窗口时退出的开关。

验收：e2e「settings open in their own window, reach every window at once and survive a restart」——菜单结构与编辑 role 项、⌘, 打开设置窗口、改主题两窗同时生效、Agent 页可用且窗口行为写入 settings.json、设置窗口在前时 ⌘W 只关设置窗口、带着藏起来的设置窗口也能正常退出、重启后设置仍在。

### 二期

浏览器页（清除数据、标签行为）、录制与技能页、快捷键只读页、下载位置、默认权限模式、设为默认浏览器（`CFBundleURLTypes` + `open-url`，外部链接开新标签页）。

### 三期

快捷键可改、多工作区 / Profiles（独立立项）、更新检查（需要 autoUpdater）。
