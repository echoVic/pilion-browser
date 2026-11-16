<p align="center"><img src="build/icon.png" width="112" alt="Pilion"></p>

# Pilion Browser

简体中文 | [English](README.en.md)

**把你的编码 Agent 接进真实浏览器：用你的登录态，你在场，方向盘随时拿得回来。**

Pilion 是一个桌面浏览器，把标签页通过 MCP 交给 [Agent Client Protocol](https://agentclientprotocol.com) Agent 操作。它不另开未登录的 profile，也不把网页搬进无头浏览器：Agent 就在你日常使用的浏览器里工作，用你的登录态；动作受审批设置约束，全程留审计，任务随时可以接管，重启后还能接着聊。

![Pilion 演示：让 Agent 改购物车，切到操作前确认，接管修改地址，重启后恢复会话](docs/demo.gif)

[下载](https://github.com/echoVic/pilion-browser/releases) · [安装](#安装) · [架构](docs/architecture.md) · [更新日志](CHANGELOG.md)

## 为什么用 Pilion

- **8 个 Agent 开箱即用**：Claude Code、Codex、Gemini CLI、Grok Build、OpenCode、Pi、Orca、Blade 自动检测；缺少 ACP 适配器时按固定版本装进 Pilion 的数据目录，不修改全局 CLI。
- **默认放手，刹车随时踩**：新对话默认「完全访问」但仍全程留审计；切到「操作前确认」后，每个改变页面的动作都等你点头，也可以允许整个任务。
- **接管再交还**：接管会停下当前这一回合，但对话、空间、标签和历史都保留；「继续任务」或「交还」后 Agent 从同一个标签接着跑。
- **原语齐全**：文件直接写进页面的 `<input type=file>`；滚动不消耗审批；白板、地图和播放器这类 `<canvas>` / `<video>` 可以按坐标点击、拖拽和滚轮。
- **录一次，回放成技能**：把演示录成技能，Agent 之后用 `browser_skills_play` 回放。
- **远端 Agent，本地浏览器**：Agent 跑在 VPS 上，通过 SSH 驱动本机浏览器，登录态仍在本机。
- **会话可恢复、本地优先**：每个对话保存 ACP session id，重连时用 `session/resume` 或 `session/load` 接上；数据留在本机，MIT 开源。

## 安装

从 [Releases](https://github.com/echoVic/pilion-browser/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS | dmg；Apple Silicon 选 arm64，Intel 选 x64 |
| Windows | exe 安装程序；未签名，SmartScreen 提示时选「更多信息 → 仍要运行」 |
| Linux | AppImage 或 deb |

安装后会自动检查更新，提示重启或在退出时安装，可在「设置 › 通用 › 更新」关闭；Linux deb 只提示新版本，需要手动下载。

## 快速开始

1. 打开「设置 › Agent」，选择一个本地 Agent。已装好的 CLI 或 ACP 适配器会直接复用，缺适配器时点「安装并连接」。
2. 在右侧面板选好权限和模型，直接输入任务，例如「打开 GitHub，看看我有哪些未读通知」。
3. 需要自己接手时点「接管」，改完点「继续任务」或「交还」；按 `⌘/Ctrl+Shift+O` 查看所有 Agent 任务。

默认是「完全访问」。处理支付、发布、删除这类动作时，建议在输入框切到「操作前确认」。

## 浏览器工作区

- 左侧用空间组织标签（工作、阅读等），空间共享登录态；标签可以固定在当前空间或设为所有空间可见。
- 普通标签闲置 24 小时后自动归档，当前页、播放音频、录制和 Agent 工作页会保留；可在「设置 › 浏览器」调整时长或关闭，在「已归档标签」恢复。
- `⌘/Ctrl+T` 打开命令栏，搜索标签、书签、历史和命令；输入 `>` 只查命令。地址栏支持网址和搜索，页内查找、缩放和下载管理都在工具栏。
- 「扩展与浏览器数据」可以从本机 Chrome、Edge、Brave、Chromium 导入 Cookie / 登录态和扩展，也可以加载已解压的 Manifest V2 / V3 扩展；Cookie 导入目前仅 macOS。
- 右侧对话面板支持多会话、流式 Markdown、可折叠的工具与思考过程、审批坞、任务总览、图片附件和待发队列。

## 控制与审计

- 审批显示在所属对话的输入框上方，页面变化、取消或断线会让审批失效；审批摘要里来自网页或 Agent 的文字会压成一行，不能借换行伪造审批内容。
- 输入框下方的「暂停浏览器权限」立即撤销 Agent 的标签权限，随时可以「共享浏览器」恢复。
- 每个动作、审批和连接事件都写进本地 `host.sqlite`；启动时清理 30 天前的工具结果正文和 7 天前的对外调用记录，审计条目保留。
- Tab ACL 按 principal 隔离：Agent 只能操作自己打开的标签。页面运行在独立的 Electron `WebContentsView` 沙箱里，不提供任意 JavaScript 执行。

## 外部 CLI / MCP

Pilion 可以把同一个受控浏览器开放给终端里的 Agent，或 Claude Desktop、Cursor 这类 MCP 客户端。默认关闭，在「设置 › 通用 › 对外控制」打开。

```bash
pilion status
pilion tabs
pilion new https://example.com
pilion observe --tab <id>
pilion screenshot --tab <id> -o shot.png
pilion upload --tab <id> --ref-file ref.json --file /absolute/path/receipt.png
```

加 `--json` 输出机器可读结果，`pilion skill` 打印完整用法。外部调用与内置 Agent 走同一条审批 / 执行 / 审计链路，开放 19 个工具，不开放 `browser_request_human`、技能回放和定时任务。外部控制基于 Unix domain socket，Windows 上不提供；`cli.token` 是本机文件凭证，泄露时在设置里吊销对应客户端。更细的信任模型见[架构说明](docs/architecture.md)。

## 录制、技能与定时任务

- 工具栏「开始录制」录下一次操作，写完描述后提炼成技能，保存在本机，可以编辑、改名和删除；录制不会记下密码、银行卡号、有效期、安全码和一次性验证码。
- Agent 用 `browser_skills_list` 发现技能、`browser_skills_play` 回放，同一任务内首次回放需要确认一次；输入框打 `/` 可以把技能插进提示。
- 「设置 › 定时任务」可以按间隔、每天定点、指定星期或五段 cron 让绑定的 Agent 后台运行一条 Prompt；无人值守时 60 秒自动拒绝审批，Agent 创建或删除定时任务始终需要你确认。

## 安全与数据

- 网页运行在独立的 Electron `WebContentsView` 中，网络连接遵循 Chromium 和系统的 DNS、代理及路由设置；下载不会自动打开。
- userData 下的 `agents.json` 保存连接配置，`workspace.json` 保存对话 / 书签 / 历史 / 标签，`host.sqlite` 保存执行审计，`schedules.json` 保存定时任务；JSON 权限为 0600，但不是加密存储。
- 目前只有一个个人工作区，同一时刻最多 4 个 ACP 会话；Agent 新开的标签默认留在后台，需要渲染或输入时临时唤醒。
- 尚未包含密码管理和跨设备同步；Windows 和 Linux 安装包未签名。

## 开发

需要 Node.js 22.13+、pnpm 10；桌面应用基于 Electron 43。

```bash
pnpm install
pnpm dev      # Vite + 主进程 watch + Electron
pnpm build
```

`pnpm dev` 里的 Vite 地址只用于界面预览；真实网页、Agent、审批和持久化都在 Electron 里。

提交前跑和 CI 相同的检查：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:e2e   # 先构建，再用 Playwright 驱动真实 Electron；目前只在 macOS 跑
```

`pnpm dist` 生成当前平台的安装包到 `release/`，`pnpm run pack` 只生成未压缩的应用目录。推送 `v*` 标签会触发发布工作流：检查通过后在三平台构建并上传草稿 Release，缺少签名 secrets 时直接失败。

## 文档

[架构说明](docs/architecture.md) · [Arc 特性设计与验收](docs/design/arc-features.md) · [设置与菜单](docs/design/settings-and-menu.md) · [更新日志](CHANGELOG.md) · [安装给其他 Agent 的 skill](skills/pilion-browser/SKILL.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
