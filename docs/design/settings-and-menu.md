# Pilion 菜单栏 & 设置窗口 设计方案

> 状态：一期已实现（0.1.6）；二期设计已定，见第八节
> 更新：2026-10-11
> 范围：一期落地情况、二期设计、三期边界

---

## 一、决策记录

### 1. 设置窗口：独立窗口 + 懒创建

- ⌘, 或菜单「设置…」第一次打开时才创建；关闭只是 `hide()`，再开时原样显示。
- 渲染层复用同一份 bundle，以 `?window=preferences` 打开时渲染 `PreferencesWindow`（`src/renderer/Preferences.tsx`），preload 不变。
- 不设 `parent`：macOS 上子窗口会跟着主窗口一起移动、一起最小化。主窗口销毁时由主进程顺手销毁设置窗口。
- 设置窗口的 `close` 只在应用退出时放行（`before-quit` 一开始就置 `quitting`）。否则它拦下的 close 会让 ⌘Q 整个作废。
- Agent 连接只在设置窗口的 Agent 页配置，浏览区不再有「Agent 连接」页（同一份表单放两处，用户不知道该去哪改，也挤占网页区）。Agent 面板的下拉框仍然就地切换已配置的 Agent；其余入口都打开设置窗口：

  | 入口                                       | 打开                                 |
  | ------------------------------------------ | ------------------------------------ |
  | 面板下拉里选未配置的预设、「添加 Agent…」  | Agent 页，预选该预设，连上后自动收起 |
  | 面板「管理 Agent」、输入框提示「连接设置」 | Agent 页，连上后自动收起             |
  | 菜单「Agent › 管理 Agent 连接…」           | Agent 页，连上后自动收起             |
  | 侧栏底部「设置」、⌘,                       | 停在上次的页，不自动收起             |

  渲染层用 `settings.open({ pane, preset, returnOnConnect })` 打开；主进程把目标经 `preferences:open` 发给设置窗口，preload 记下最近一次，页面晚挂监听也不会错过。连上之后由主进程收起设置窗口（它知道窗口是怎么打开的），不在渲染层里 `window.close()`——那会直接销毁窗口而绕过关闭时只隐藏的处理。

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
| Pilion   | 关于 Pilion、检查更新…、设置… ⌘,、服务、隐藏、隐藏其他、全部显示、退出（macOS 专有）                               |
| 文件     | 新建标签页 ⌘T、打开位置… ⌘L、重新打开关闭的标签页 ⇧⌘T、关闭标签页 ⌘W、新对话、从 Chrome 导入 Cookie…               |
| 编辑     | 撤销、重做、剪切、拷贝、粘贴、粘贴并匹配样式、删除、全选（全部是 role 项）、查找… ⌘F                               |
| 显示     | 侧边栏、Agent 面板、刷新 ⌘R、停止载入、实际大小 / 放大 / 缩小、对话记录、下载；开发版另有开发者工具                |
| 历史记录 | 后退 ⌘[、前进 ⌘]、显示全部历史记录、最近关闭的标签页（子菜单）                                                     |
| 书签     | 添加或移除书签 ⌘D、显示全部书签                                                                                    |
| Agent    | 管理 Agent 连接…、共享浏览器 / 暂停浏览器权限、接管浏览器、停止任务、继续任务、断开 Agent、开始 / 停止录制、技能库 |
| 窗口     | 最小化、缩放、前置全部窗口                                                                                         |
| 帮助     | 使用说明、反馈问题（Windows、Linux 上另有检查更新…、关于 Pilion）                                                  |

路由规则：

- 菜单动作一律发给主窗口渲染层的 `performAction`，和快捷键、按钮走同一段代码。录制对前进后退刷新的记账、Agent 驾驶时的禁用条件因此不会被菜单绕过。
- 设置窗口在前时，⌘W 关闭设置窗口；其余动作作用在浏览器窗口上，先把它带到前面，并把键盘焦点交给 Pilion 的界面（和网页里按下的快捷键一样），地址栏、查找框才接得到输入。
- 菜单项的可用状态与界面按钮一致：接管只在 Agent 正在操作时可用，继续任务只在人接管后且连接空闲时可用；Agent 正在操作或技能在回放时，后退、前进、刷新、停止与缩放不可用，对应的快捷键在渲染层同样不执行。
- 「清除历史记录」不进菜单：一点即删、没有确认，留在历史记录页里。

---

## 四、`settings.json`

全局设置，与每个工作区自己的 `workspace.json` 分开。

- 结构定义在 `src/shared/settings.ts`（主进程、渲染层、preload 共用）：`theme`、`startupBehavior`、`searchEngine`、`quitOnWindowClose`（默认 `true`，即保持旧行为；只在 macOS 生效，别的平台没有 Dock，藏起来的窗口找不回来，又没有单实例锁，再启动会在同一份数据上开出第二个进程）、`agentWindowBehavior`（默认 `foreground`）、`autoUpdate`（默认 `true`，只管自动检查和下载，已经下好的更新退出时总会安装）。
- 文件里某一项被改坏只回退那一项，未知的键读入时丢掉，整个文件读不出就用默认值。
- 渲染层只送改动的几项；`AppSettingsPatchSchema` 是 strict 的、没有默认值，免得一次局部保存把其余项重置。
- 落盘沿用 `WorkspaceStore` 的写临时文件再 rename。
- 设置随 `AppState.settings` 广播，主窗口和设置窗口都从这里读，改了两边立刻生效。
- 主题以 settings.json 为准；`localStorage` 只留副本，让窗口在设置到达前先用上次的主题。旧版只存在 `localStorage` 的主题在第一次启动时迁过来。

IPC 信任边界：`trustedRenderer()` 默认只认主窗口自己的主 frame。设置窗口只在 `handle(..., { preferences: true })` 显式放行的通道上被认：状态、设置读写、Agent 连接的增删改查与本机检测、选择目录，以及检查更新与安装更新（`update:check`、`update:install`；重启前要不要先确认仍由主进程判断）。`settings:open` 与审批通道永远只认主窗口。

---

## 五、设置窗口内容

**通用**：主题（浅色 / 跟随系统 / 深色）；打开 Pilion 时恢复上次的标签页或打开新标签页；地址栏搜索引擎（Google / Bing / DuckDuckGo）；关闭窗口时退出 Pilion（关掉后关窗只是藏起来，点 Dock 图标回来）；更新（当前版本、自动更新开关、检查更新 / 立即重启）。

**Agent**：Agent 操作页面时「前台显示」或「后台静默」；Agent 连接管理（`AgentSettings`：本地预设、自定义命令与 SSH 远端）。

**一期没做、挪到二期**：下载位置（`requireDownload` 的路径校验以系统下载目录为前提，改它要连安全校验一起改）。默认权限模式不做，原因见第八节。

---

## 六、Agent 窗口行为

### 根因

窗口被抢占来自 `AgentShield.update()`：Agent 每次开始操作页面，护罩升起时调用 `parent.webContents.focus()`，把键盘焦点从网页移回 Pilion 自己的界面，免得人的按键落进护罩下面的网页。Electron 在 macOS 上的 `webContents.focus()` 会顺带激活应用并 `makeKeyAndOrderFront`，于是整个窗口被拉到最前。

`bindPage` 里网页 `before-input-event` 的那次 focus 是人在网页里按快捷键触发的，窗口本来就在前台，与抢占无关，两种模式下都照常执行。

页面操作走 CDP（`electron-page-adapter.ts` 经 `wc.debugger`），不要求窗口在前台，所以静默模式不需要改输入注入。

### 实现

- `takeShellFocus()`：静默模式下窗口不在前台时不调 `webContents.focus()`；前台模式行为不变。`AgentShield` 的两处 focus 与网页 `focus` 事件里的那处都改走它。
- 主窗口 `focus` 事件：护罩锁着时把焦点移回 Pilion 界面。静默模式下开工时没抢焦点，人切回来的那一刻补上，键盘输入不会落进护罩下的网页。
- Agent 的指针是一个独立的小窗口，`showInactive()` 会把它摆到别的应用上面。`AgentPointer` 收一个 `allowed()`：静默模式下窗口不在前台时不画指针，操作照常进行。
- 从设置窗口连上之后自动回到浏览器，也只在设置窗口还在前台时才把主窗口带到前面；「安装并连接」可能要几分钟，人已经去了别的应用就只收起设置窗口。
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

浏览器页（下载位置、清除浏览数据）、快捷键只读页、设为默认浏览器（只做 macOS）。设计见第八节。原计划里的默认权限模式、标签行为、录制与技能页不做。

### 三期

快捷键可改、多工作区 / Profiles（独立立项）。更新检查已随 0.1.8 的自动更新实现，见 docs/superpowers/specs/2026-10-11-auto-update-design.md。

---

## 八、二期设计

### 范围与取舍

做：浏览器页（下载位置、清除浏览数据）、快捷键页（只读）、设为默认浏览器（只做 macOS）。设置窗口的页依次为：通用、浏览器、快捷键、Agent。

不做：

- **默认权限模式**：输入框里的「完全访问 / 操作前确认」已经保存在工作区、全局生效，设置里再放一个就是同一个开关两处入口（第一节第 1 条为此把 Agent 连接从浏览区拿掉）；它也正是第一节第 2 条说的不进设置的那一类。
- **标签行为、录制与技能页**：没有具体需求，不为占位加设置项。技能库已有自己的页面。

### 默认浏览器（通用页，只在 macOS 显示）

- Info.plist 声明 http、https 两个 URL scheme（`CFBundleURLTypes`，角色 Viewer），只加在 macOS 的打包配置里。不声明 HTML 文档类型：URL 策略只放行 http(s)，本地 HTML 文件打不开。
- 「设为默认浏览器」调用 `app.setAsDefaultProtocolClient('http')` 与 `('https')`，macOS 会弹系统确认框，由人决定。状态取 `app.isDefaultProtocolClient('https')`：已经是默认时显示「Pilion 是默认浏览器」，不再显示按钮；设置窗口重新获得焦点时重查，人可能在系统设置里改过。开发版本（未打包）不显示按钮，免得把 Electron 本身设成默认浏览器。
- 外部链接：`open-url` 在 `will-finish-launching` 里注册，`ready` 之前到达的先排队；主窗口和工作区就绪后，逐个在当前工作区开新标签页并激活，把窗口带到前面。地址走统一 URL 策略，被拦截的地址与在地址栏输入时一样显示拦截页。不交给 Agent，也不改动 Agent 正在操作的标签页。
- Windows、Linux 这次不做：Windows 要在安装程序里写 StartMenuInternet / Capabilities 注册表，再让人到系统设置里选；Linux 要在 .desktop 里声明 MimeType 并调用 xdg-settings。两者都要单独验证。这两个平台上不显示该项。

### 下载位置（浏览器页）

- `settings.json` 新增 `downloadDirectory`（绝对路径，缺省为系统下载目录）。它只能由主进程写：`settings:save` 的补丁不接受这一项，渲染层只能调用 `downloads:choose-directory`（主进程弹原生目录选择框，校验目录可写后保存）和 `downloads:reset-directory`。两条通道对设置窗口放行。
- 新的下载存进这个目录；目录被删或不可写时退回系统下载目录，并在活动记录里说明。
- `requireDownload` 的路径校验改为：记录所在目录必须是系统下载目录或当前设置的下载目录，文件名仍须与记录一致。换了下载位置之后，旧位置的下载记录还在列表里，但不能再从 Pilion 打开或在文件夹中显示，提示文件不在当前下载位置。这是有意的：校验只认人当前选定的目录。

### 清除浏览数据（浏览器页）

- 可选四项：浏览记录（默认勾选）、下载记录（只清列表、不删文件，默认不勾）、Cookie 和网站数据（默认不勾）、缓存的图片和文件（默认勾选）。时间范围只有「全部」。
- 点「清除…」后由主进程弹原生确认框，列出要清除的项；勾了 Cookie 时写明会退出大多数网站，包括 Agent 正在用的登录状态。
- 只清网页所在的持久分区 `persist:pilion-default`：Cookie 和网站数据用 `clearStorageData()`（Cookie、localStorage、IndexedDB、Service Worker、Cache Storage 等），缓存用 `clearCache()`。不碰 Pilion 界面自己用的 defaultSession。浏览记录与历史记录页的「清除」走同一段逻辑，下载记录与下载页的「清除」走同一段逻辑（进行中和暂停的下载保留）。
- 通道 `browsing-data:clear`，参数用 strict schema 校验，对设置窗口放行。

### 快捷键页（只读）

- 从 `src/shared/keybindings.ts` 生成，不另写一份。每条快捷键在那里加上中文名称，菜单里对应的菜单项改用同一个名称，两边说法不会走样。
- 按标签页、导航、页面、其他分组；⌘1–⌘8 合成一行，⌘L 与 ⌘K 合成一行。macOS 显示 ⌘、⇧ 符号，其他平台写 Ctrl、Shift。
- 只读，页脚注明暂不支持修改（三期）。
