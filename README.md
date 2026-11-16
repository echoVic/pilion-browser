<p align="center"><img src="build/icon.png" width="112" alt="Pilion"></p>

<h1 align="center">Pilion Browser</h1>

<p align="center"><b>把你的编码 Agent 接进真实浏览器：用你的登录态，你在场，方向盘随时拿得回来。</b></p>

<p align="center">
<b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
<a href="https://github.com/echoVic/pilion-browser/releases"><b>下载</b></a>
&nbsp;·&nbsp;
<a href="#安装">安装</a>
&nbsp;·&nbsp;
<a href="#快速开始">快速开始</a>
&nbsp;·&nbsp;
<a href="docs/architecture.md">架构</a>
&nbsp;·&nbsp;
<a href="CHANGELOG.md">更新日志</a>
</p>

![Pilion 演示：让 Agent 改购物车，切到操作前确认并批准结算，接管修改地址，重启后恢复会话](docs/demo.gif)

Pilion 是一个桌面浏览器，把标签页通过 MCP 交给 [Agent Client Protocol](https://agentclientprotocol.com) Agent 操作。它不另开一个未登录的 profile，也不把网页搬进无头浏览器集群：Agent 就在你日常使用的浏览器里工作，用你的登录态；动作受你的审批设置约束，全程留审计，任务可以随时接管，重启后还能接着聊。

## 为什么用 Pilion

- **8 个 Agent 开箱即用** —— Claude Code、Codex、Gemini CLI、Grok Build、OpenCode、Pi、Orca、Blade 自动检测；缺少 ACP 适配器时按固定版本装进 Pilion 的数据目录，不修改全局 CLI。
- **默认放手，刹车随时踩** —— 新对话默认「完全访问」，仍然全程留审计；切到「操作前确认」后，每个会改变页面的动作都等你点头，一次「本任务允许」可以覆盖整条任务。
- **接管，然后交还** —— 接管会停下当前这一回合，但不会结束会话：对话或空间、标签和历史都保留。内置对话点「继续任务」，外部 Agent Space 点「交还」，Agent 都从同一个标签接着跑；「转为我的空间」才是不可逆的。
- **上传、滚动、画布输入都是原语** —— 文件直接写进页面的 `<input type=file>`；滚动不消耗审批；白板、地图、播放器这类 `<canvas>` / `<video>` 可以按坐标点击、拖拽和滚轮。
- **录一次，回放成技能** —— 把演示录下来，提炼成技能，Agent 之后用 `browser_skills_play` 回放，不必每次重新摸索。
- **远端 Agent，本地浏览器** —— Agent 跑在 VPS 上，通过 SSH 驱动本机浏览器，登录态仍在本机。
- **会话可恢复** —— 每个对话保存 ACP session id，重连时用 `session/resume` 或 `session/load` 接上；重启不等于从头再来。
- **本地优先** —— 数据留在本机，MIT 开源；macOS、Windows、Linux 都有安装包，装好自动更新。

## 安装

从 [Releases](https://github.com/echoVic/pilion-browser/releases) 下载对应平台的安装包：

| 平台    | 安装包                                                            |
| ------- | ----------------------------------------------------------------- |
| macOS   | dmg；Apple Silicon 选 arm64，Intel 选 x64                         |
| Windows | exe 安装程序；未签名，SmartScreen 提示时选「更多信息 → 仍要运行」 |
| Linux   | AppImage 或 deb                                                   |

安装后 Pilion 会自动检查并下载新版本，提示重启或在退出时安装，可在「设置 › 通用 › 更新」关闭。Linux deb 只提示新版本，需要手动下载安装。

## 快速开始

1. 打开「设置 › Agent」，选择一个本地 Agent。已经装好的 CLI 或 ACP 适配器会直接复用，缺适配器时点「安装并连接」。
2. 在右侧面板选好权限和模型，直接输入任务，例如「打开 GitHub，看看我有哪些未读通知」。
3. 需要自己接手时点「接管」；改完点「继续任务」或「交还」。按 `⌘/Ctrl+Shift+O` 查看所有 Agent 任务。

默认是「完全访问」。处理支付、发布、删除这类动作时，建议在输入框切到「操作前确认」。

## 浏览器工作区

- 左侧用空间组织标签（工作、阅读等），空间共享登录态；标签可以固定在当前空间，或设为所有空间可见。
- 普通标签闲置 24 小时后自动归档，当前页、播放音频、录制和 Agent 工作页会保留；可在「设置 › 浏览器」调整时长或关闭，在「已归档标签」恢复。
- `⌘/Ctrl+T` 打开命令栏，搜索标签、书签、历史和命令；输入 `>` 只查命令。`⌘/Ctrl+Shift+C` 复制当前网址。
- 地址栏支持网址和搜索；页内查找、缩放和下载管理都在工具栏。macOS 上可把 Pilion 设为默认浏览器。
- 「扩展与浏览器数据」可从本机 Chrome、Edge、Brave、Chromium 导入 Cookie / 登录态和扩展，也可以加载已解压的 Manifest V2 / V3 扩展；Cookie 导入目前仅 macOS。
- 右侧对话面板支持多会话、流式 Markdown、可折叠的工具与思考过程、审批坞、任务总览、图片附件和待发队列。

## Agent 连接

- 8 个本地预置，自动检测 PATH、nvm、Homebrew、Volta、`~/.grok/bin`、`~/.opencode/bin` 等位置；可手动指定 Node.js 路径和工作目录，默认工作目录是 userData 下的 `workspace-files`。
- 缺少适配器时用 npm 把固定版本装进 `userData/adapters/`，先装到临时目录、校验完整后再启用；不会修改全局 CLI。Pi 和 Blade 需要 Node.js 22.19+，原生可执行文件不依赖 Node.js。
- 「自定义 / 远端」支持任意 ACP stdio 命令（参数为 JSON 数组，可配环境变量和认证方式），也支持 SSH 远端：ACP 走 SSH stdio，浏览器 MCP 走一条独立的 SSH 私有 socket 回程，远端无需安装 Pilion。
- SSH 远端需要 Unix、已安装 Agent 和支持 `nc -U` 的 netcat，本机能用密钥登录且已确认主机指纹。
- 每个对话绑定一个 Agent，最多 4 个会话同时运行；权限、模型和会话都按对话保存。

[Orca](https://github.com/echoVic/orca-agent) 是 DeepSeek 原生的编码 Agent，[Blade](https://github.com/echoVic/blade-code) 支持 38+ 模型 Provider，两者由 Pilion 作者维护，原生实现 ACP。

## 控制与审计

- 审批显示在所属对话的输入框上方，按钮始终可见；页面变化、取消或断开连接会让审批失效。
- 「操作前确认」下可以批准一次，或允许整个任务；外部客户端还可以始终允许该客户端。「本任务允许」覆盖当前任务；外部客户端的 Space 授权跨重连保留，Space 结束或接管后失效。
- 审批摘要里来自网页或 Agent 的文字会先压成一行，不能借换行伪造审批内容。
- 输入框下方的「暂停浏览器权限」会立即撤销 Agent 的标签权限，随时可以「共享浏览器」恢复。
- 每个动作、审批和连接事件都写进本地 `host.sqlite`；启动时清理 30 天前的工具结果正文和 7 天前的对外调用记录，审计条目保留。
- Tab ACL 按 principal 隔离：Agent 只能操作自己打开的标签，你自己的标签不会被它拿到。
- 不提供任意 JavaScript 执行；页面运行在独立的 Electron `WebContentsView` 沙箱里。

## 浏览器原语

Pilion 通过 MCP 提供 24 个内置工具：

- **观察**：`browser_observe`、`browser_snapshot`、`browser_screenshot`、`browser_page_info`。
- **交互**：`browser_navigate`、`browser_click`、`browser_hover`、`browser_pointer`、`browser_type`、`browser_select`、`browser_check`、`browser_press`。
- **视口与文件**：`browser_scroll`、`browser_upload_file`。
- **标签**：`browser_tabs_list`、`browser_tabs_open`、`browser_tabs_activate`、`browser_tabs_close`。
- **技能、定时与交还**：`browser_skills_list`、`browser_skills_play`、`browser_schedule_create`、`browser_schedule_list`、`browser_schedule_delete`、`browser_request_human`。

几个值得知道的细节：

- `browser_observe` 返回最多 200 个 DOM 候选和元素引用；`browser_screenshot` 在超大页面上自动降级为 JPEG / 缩小分辨率，支持 `scale`、`quality`、`format` 和 `clip`，并给出图片像素与页面像素的换算。
- `browser_pointer` 只用于 `<canvas>` / `<video>`，坐标相对内容区左上角；结果只说 `dispatched`，是否生效要再截图确认。画面外或被遮挡的点会在派发前拒绝。
- `browser_upload_file` 直接写入（包括隐藏的）`<input type=file>`，只接受绝对路径的普通文件，拒绝符号链接，单文件 200 MB、一次最多 10 个，并回读页面确认。
- `browser_scroll` 是视口滚动，不改变页面状态，因此不进入审批链。
- `browser_click` 对无布局或 hover-only 控件可以先 `browser_hover`，或用它的 `force` 参数（命令行是 `pilion click --force`）；`browser_press` 返回 `effect: activated | none | dispatched`，不用裸 `ok: true` 掩盖无响应。

## 录制与技能

- 点工具栏「开始录制」录下一次操作，写完描述后提炼成技能；技能保存在本机，可以编辑、改名和删除。
- 录制不会记下密码、银行卡号、有效期、安全码和一次性验证码，也不会把 URL 里的登录凭据写进回放。
- Agent 用 `browser_skills_list` 发现技能、`browser_skills_play` 回放；同一任务内首次回放需要你确认一次。输入框打 `/` 可以直接把技能插进提示。
- Agent 在对话里写出的技能修改会先作为提案，你确认后才写入。

## 定时任务

- 「设置 › 定时任务」可以按间隔、每天定点、指定星期或五段 cron，让绑定的 Agent 在后台运行一条 Prompt；跑完发系统通知，睡眠错过的任务在启动或唤醒后补跑。
- 每个任务单独选运行权限，默认「操作前确认」；无人值守时 60 秒自动拒绝审批。Agent 创建或删除定时任务始终需要你在来源对话里确认。
- 到点另开一条后台对话，完成后断开专用连接并释放名额；同一任务运行期间不重复触发。

## 外部 CLI / MCP

Pilion 可以把同一个受控浏览器开放给终端里的 Agent，或 Claude Desktop、Cursor 这类 MCP 客户端。**默认关闭**，在「设置 › 通用 › 对外控制」打开。

- 点「安装到 Agent」会签发一个本机客户端、把 token 写进 `userData/external/cli.token`（0600）、安装 `~/.local/bin/pilion`，并把 `pilion-browser` skill 复制到已存在的 Claude Code、Codex、WorkBuddy、Gemini、Trae、Cursor 等 skills 目录。
- 只想要 skill 时可以用 `npx skills add echoVic/pilion-browser`，它不会安装或升级桌面客户端。
- 新增外部客户端会生成只显示一次的 token；客户端注册表只存 scrypt 哈希。不同客户端有各自的 principal 和 Tab ACL，默认只能操作自己打开的标签。新建的客户端（包括「安装到 Agent」）默认「始终允许此客户端」，可在客户端列表改回「操作前确认」；新增后还会给出该客户端的 MCP 配置 JSON，粘进 `mcpServers` 即可。
- 外部调用与内置 Agent 走同一条审批 / 执行 / 审计链路，开放 19 个工具；不开放 `browser.request_human`、`browser.skills.play` 和三个 `browser.schedule.*` 工具，也不提供任意 JavaScript 执行。

```bash
pilion status
pilion tabs
pilion new https://example.com
pilion observe --tab <id>
pilion click --tab <id> --ref-file ref.json
pilion pointer click --tab <id> --ref-file canvas.json --at 120,80   # 只用于 canvas/video
pilion screenshot --tab <id> -o shot.png
pilion upload --tab <id> --ref-file ref.json --file /absolute/path/receipt.png
```

加 `--json` 输出机器可读结果；`pilion skill` 打印随客户端交付的完整用法。外部 Agent 的每个对话还可以拥有自己的 Agent Space：

```bash
SPACE=$(pilion space new "比价任务")
pilion navigate --space "$SPACE" https://example.com/
pilion screenshot --space "$SPACE"
pilion space close "$SPACE"
```

**取舍**：`cli.token` 是文件凭证，本机以你的身份运行的进程都可能读到。它和其他外部客户端一样受审批、ACL 和审计约束；泄露时在设置里吊销对应客户端。外部控制基于 Unix domain socket，Windows 上不提供。更细的信任模型见[架构说明](docs/architecture.md)。

## 安全与数据

- 网页运行在独立的 Electron `WebContentsView` 中，网络连接遵循 Chromium 和系统的 DNS、代理及路由设置，可访问公网、内网以及本机 HTTP(S) 服务；下载不会自动打开。
- userData 下的 `agents.json` 保存连接配置，`workspace.json` 保存对话 / 书签 / 历史 / 标签，`host.sqlite` 保存执行审计，`schedules.json` 保存定时任务；JSON 权限为 0600，但并非加密存储。
- 目前只有一个个人工作区，同一时刻最多 4 个 ACP 会话；Agent 新开的标签默认留在后台，需要渲染或输入时临时唤醒。
- 尚未包含密码管理和跨设备同步；Windows 和 Linux 安装包未签名；ACP HTTP transport 仍在草案阶段，远端使用 SSH 上的标准 stdio。

## 开发

需要 Node.js 22.13+、pnpm 10，桌面应用基于 Electron 43。

```bash
pnpm install
pnpm dev      # Vite + 主进程 watch + Electron
pnpm build
pnpm start
```

`pnpm dev` 里的 Vite 地址只用于界面预览；真实网页、Agent、审批和持久化都在 Electron 里。

提交前跑和 CI 相同的检查：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:e2e
```

E2E 会先构建，再用 Playwright 驱动真实的 Electron（目前只在 macOS 跑）：每次使用 `os.tmpdir()` 下的临时 profile，不读写你日常的 `~/Library/Application Support/pilion-browser`，也不抢系统焦点。E2E 共用 `dist/`，不要同时跑两次。设置 `PILION_E2E_EXECUTABLE=<打包后的可执行文件>` 可以直接验证安装包。

如果 Electron 启动报 `bad option: --remote-debugging-port=0`，先检查环境里有没有 `ELECTRON_RUN_AS_NODE=1`，用 `env -u ELECTRON_RUN_AS_NODE pnpm test:e2e` 再试。

## 打包与发布

```bash
pnpm dist       # 当前平台安装包，输出到 release/
pnpm run pack   # 只生成未压缩的应用目录
```

推送 `v*` 标签会触发 GitHub Actions：先跑类型检查、lint、格式检查和单元测试，并校验标签与 `package.json` 版本一致，通过后才在 macOS、Windows、Linux 上构建，上传到草稿 Release。补上 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 等 secrets 后，macOS 包会自动签名并公证；缺少这些 secrets 时发布工作流会直接失败，避免发出无法自动更新的包。E2E 不在发布流程里，推 main 的 CI 会跑。草稿 Release 发布后，已安装的 Pilion 才会收到更新。

## 文档

- [架构说明](docs/architecture.md) —— 模块、状态机、对外通道与安全边界。
- [Arc 特性设计与验收](docs/design/arc-features.md) —— 空间、标签、命令栏。
- [设置与菜单](docs/design/settings-and-menu.md)。
- [更新日志](CHANGELOG.md) —— 每个版本的变化。
- [skills/pilion-browser](skills/pilion-browser/SKILL.md) —— 安装给其他 Agent 的入口 skill。

## 许可

MIT，见 [LICENSE](LICENSE)。
