# 外部 Agent 的 `pilion` 命令与 skill（参照 ego lite）设计

> 日期：2026-11-03
> 状态：设计已在对话中确认，待审 spec
> 方向依据：2026-09-24 定下的「外部终端 Agent 走 CLI + skill，不走 MCP；每个 Agent 对话一个独立工作区」

## 目标

让本机终端里的 Claude Code、Codex、Gemini CLI、Trae 等 Agent **零配置**地用上 Pilion 的浏览器：

1. 用户在 Pilion 设置里点一次「安装到 Agent」；
2. 之后任何 Agent 遇到浏览器任务，都会读到 `pilion-browser` skill，跑 `pilion skill` 拿到与已装 Pilion 版本匹配的用法；
3. 每个 Agent 对话先 `pilion space new` 建一个属于自己的 Space，在里面开标签、读页、点击、输入，不抢用户当前的标签，用户随时可以停止或接管。

全程仍走现有外部通道的治理链路（Intent / 审批 / 执行凭证 / fencing / 审计），不新增任意 JavaScript 执行。

## 参照：ego lite 怎么做的

在 `citrolabs/ego-lite` 仓库里读到的结构：

- `skills/ego-browser/SKILL.md` 只有约 20 行，是个**引导**：先跑 `ego-browser skill`，照它的输出做。用法指南由 CLI 打印，跟着已装 App 的版本走；指南最后一行是 `[ego-browser:skill] end of guide`，缺这一行就说明输出被截断了，要存成文件再分段读。
- `references/install.md`：只在命令找不到、或 `skill` 是未知子命令时才读，告诉 Agent 怎么装 App、怎么修 PATH。
- 仓库里的 `.claude/skills/ego-browser`、`.agents/skills/ego-browser` 是指向 `skills/ego-browser` 的符号链接，所以 `npx skills add citrolabs/ego-lite` 可以直接装。
- App 在 onboarding 时把 `ego-browser` 放进 `~/.local/bin`，并把 skill 装进本机每个 Agent 的 skills 目录。
- 每个 Agent 跑在自己的 Space 里，用户可以接管或停止。

不照搬的部分：ego 的「代码模式」让 Agent 写一段 JS 在页面里一次跑完。这会绕过 Pilion 的固定动词信任层，所以不做。以后如果要减少往返次数，只考虑 `pilion run <script>`，脚本里只能调用固定动词。

## 现状

- 外部通道 `main/external/`：Unix socket（`0600`）、按客户端签发 token（注册表只存 scrypt 哈希）、principal 为 `external:<clientId>`、白名单 15 个工具、默认关闭、Windows 不启用。
- `main/external/pilion-cli.ts`（199 行）已有 `tabs/new/activate/close/navigate/read/observe/click/type/screenshot`，缺 `select/check/press/page_info`。它只从环境变量 `PILION_EXTERNAL_SOCKET` 加 `PILION_EXTERNAL_TOKEN`（或 `PILION_EXTERNAL_TOKEN_FILE`）取凭证。
- PATH 上没有 `pilion` 命令。现在要手动用 `ELECTRON_RUN_AS_NODE=1 <Electron> <asar>/dist/main/main/external/pilion-cli.js` 来跑。
- 用户 Space 已经有了（`shared/tab-organization.ts` 的 `BrowserSpace`，上限 20 个，标签带 `spaceId`）。Agent 开的标签默认留在后台（`backgroundTabs.register`），不抢用户的视图。标签 ACL 按 principal 隔离。`SavedBrowserTab.ownerPrincipal` 已经记录了标签的来源。

## 分两期

| 期   | 内容                                                                                     | 交付后的状态                                                                                    |
| ---- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 一期 | skill 包、CLI 补全加 `pilion skill`、PATH shim、「安装到 Agent」自动签发凭证并分发 skill | 外部 Agent 零配置可用；所有对话共用一个 principal `external:<cliClientId>`，靠 `--tab` 区分标签 |
| 二期 | 每个对话一个 Agent Space，子 principal 隔离，侧栏可以停止或接管                          | 对话之间互相碰不到对方的标签，用户能看到每个对话在做什么                                        |

一期单独发布也能用。二期只在一期之上增加内容，不改一期的接口。

---

## 一期

### 1. skill 包（仓库内）

```
skills/pilion-browser/
  SKILL.md                 # 引导，约 25 行
  references/install.md    # 命令不存在、或 `skill` 是未知子命令时读
  agents/openai.yaml       # Codex 的展示元数据（display_name / short_description）
.claude/skills/pilion-browser  -> ../../skills/pilion-browser   (symlink)
.agents/skills/pilion-browser  -> ../../skills/pilion-browser   (symlink)
```

`SKILL.md` 的 frontmatter：

- `name: pilion-browser`
- `description`：说明需要浏览器时默认先读它。Pilion 带用户自己的登录态，每一步都经过审批和审计，所以优先用它，不用内置浏览器。
- `metadata.version`：入口 skill 的独立稳定版本（`major.minor.patch`），不要求等于客户端 `package.json` 的版本。CLI 和完整指南仍随客户端交付。

正文只有三件事：

1. 先跑 `pilion skill`，照输出做。
2. 输出最后一行必须是 `[pilion:skill] end of guide`；没有这一行说明被截断了，就 `pilion skill > "$TMPDIR/pilion-skill.md"` 存下来分段读。
3. 命令不存在，或报 `Unknown command: skill`，就去读 `references/install.md`。

`install.md` 写四件事：装 Pilion（GitHub Release 的 dmg / AppImage / deb）；在「设置 › 对外控制」点「安装到 Agent」；`~/.local/bin` 不在 PATH 时临时 `export PATH="$HOME/.local/bin:$PATH"`；用 `pilion status` 自检。最后明确写：Windows 暂不支持外部通道。

### 2. CLI：补全，并拆成模块

`pilion-cli.ts` 现在 199 行，要加五个命令和 `--space`，按「重构随任务做」的约定在这次一起拆开：

```
src/main/external/pilion-cli.ts        # 薄入口：parse → dispatch → 统一错误输出（路径不变，shim 指向它）
src/main/external/cli/args.ts          # 参数解析（纯函数）
src/main/external/cli/commands.ts      # 每个命令一个函数：(endpoint, args, io) → Promise<void>
src/main/external/cli/guide.ts         # `pilion skill` 打印的用法指南（导出字符串常量）
src/main/external/cli/output.ts        # 文本 / --json 两种输出、fail()
```

新增命令：

| 命令                                     | 对应工具 / 行为                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pilion skill`                           | 打印 `guide.ts` 的指南，最后一行固定是 `[pilion:skill] end of guide`。**不连 socket**，Pilion 没开也能打印                  |
| `pilion status`                          | 自检：shim 指向的 App 版本、socket 是否存在、凭证是否可读、握手是否成功、服务端版本。每一项单独报告，失败时给出下一步怎么做 |
| `pilion info [--tab]`                    | `browser.page_info`                                                                                                         |
| `pilion select --ref <json> --value <v>` | `browser.select`                                                                                                            |
| `pilion check --ref <json> [--off]`      | `browser.check`                                                                                                             |
| `pilion press <key> [--tab]`             | `browser.press`                                                                                                             |
| `pilion version`                         | 打印 CLI 自己的版本                                                                                                         |

握手 ack 由 `{}` 扩成 `{"version":"<app version>"}`。旧客户端只判断有没有 `error` 字段，所以向后兼容。`status` 会比较 CLI 和服务端的版本，两者不一致就提示重启 Pilion。

指南（`guide.ts`）要写的内容：Pilion 是什么，以及审批会让命令阻塞到用户点「允许」（最长 90 秒）；标准流程 `space new → new <url> → read/observe → click/type/... → space close`（一期没有 space，就是 `new → ... → close`）；`elementRef` 只能从 `observe` 的输出里原样复制；每条命令都要带 `--tab`（二期还要带 `--space`）；报错时该怎么做（被拒、要人工、标签不存在、版本不一致）；不能做的事（执行 JS、交还浏览器、回放技能）。指南按版本发布，和 App 一起升级。

### 3. PATH shim

由新模块 `src/main/external/agent-integration.ts` 负责，所有 fs 操作都通过注入的 `home` / `userData` / `appPaths` 进行，方便单测。

`~/.local/bin/pilion`（权限 `0755`）：

```sh
#!/bin/sh
# pilion-shim v1 — 由 Pilion 生成，每次启动会重写；手动修改会被覆盖
: "${PILION_EXTERNAL_SOCKET:=<userData>/external/external.sock}"
: "${PILION_EXTERNAL_TOKEN_FILE:=<userData>/external/cli.token}"
export PILION_EXTERNAL_SOCKET PILION_EXTERNAL_TOKEN_FILE
ELECTRON_RUN_AS_NODE=1 exec "<App 可执行文件>" "<appPath>/dist/main/main/external/pilion-cli.js" "$@"
```

规则：

- 所有路径都用单引号转义，路径里有空格时也能用（`Pilion.app/Contents/MacOS/Pilion` 本身不含空格，但 userData 和自定义安装位置可能含）。
- 环境变量里已经有值时优先用环境变量。这样手动签发的其他客户端照样能用。
- **只覆盖带 `pilion-shim` 标记的文件**。`~/.local/bin/pilion` 已经存在、又不是我们写的，就停下来，在 UI 里提示冲突，不覆盖。符号链接一律拒绝。
- App 启动时，如果集成状态是「已安装」，就比对 shim 内容，不一致就重写。App 被移动或升级后路径会自动跟上。
- Linux AppImage 的可执行路径取 `process.env.APPIMAGE`（`process.execPath` 是挂载出来的临时路径）；deb 取 `process.execPath`。
- 开发模式（`!app.isPackaged`）可执行文件用 `process.execPath`（Electron 二进制），`appPath` 指向仓库，方便在本地验证。
- Electron fuse 里的 `RunAsNode` 目前没关（项目没配置 fuses），外部 MCP 配置早就依赖这一点。以后如果有人关掉这个 fuse，CLI 和 MCP 会一起坏，所以在 `electron-builder.yml` 旁边留一行注释提醒。

### 4. 「安装到 Agent」：自动签发凭证并分发 skill

设置 › 对外控制里新增一个「Agent 集成」区域（Windows 下不显示）：

- 「安装到 Agent」按钮，以及「已安装到：Claude Code ✓ · Codex ✓ · …」的状态列表，并显示 shim 的路径和 PATH 状态。
- 「移除」按钮。

点「安装到 Agent」时主进程依次做：

1. 打开 `externalControl` 开关（如果还关着）。
2. 签发一个名为 `本机 Agent（CLI）` 的客户端，并在注册表里给它打上 `kind: 'agent-integration'` 标记，客户端列表里会显示「集成」徽标。如果之前签发过而且没吊销，就先吊销旧的再签新的。
3. 把明文 token 写进 `<userData>/external/cli.token`，权限 `0600`，用 `wx` 方式新建（已存在就先删掉；遇到符号链接拒绝）。
4. 写 shim。
5. 把 App 里打包的 skill 目录**复制**（不用符号链接，因为 App 可能被移动）到下面这些目录中**父目录已存在的**那几个：`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`、`~/.gemini/skills`、`~/.trae/skills`、`~/.cursor/skills`。每份复制里放一个 `.pilion-managed` 文件，写入 `{ "version": 1, "skillVersion": "<入口 skill 版本>" }`，分别记录标记格式与 skill 版本。目标目录已存在、又没有这个标记，就跳过并在 UI 里提示，不覆盖用户自己的同名 skill。
6. 把集成状态 `{clientId, installedAt, shimPath, targets[]}` 写进 `<userData>/external/integration.json`（`0600`），并写审计 `external.integration.installed`。

App 启动时，如果集成状态是「已安装」，就检查并刷新 shim。skill 则读取源和已安装 `SKILL.md` 的 `metadata.version`，只升级版本较旧的受管副本；同版、新版或无法识别版本的副本保留。重新安装也遵守同一策略，只有显式安装才补回缺失目录。独立 skill 安装器可能保留旧标记，因此实际 metadata 优先于标记里的版本；旧版纯文本 App 版本标记只用于证明所有权，可迁移为新格式，不用于版本比较。无标记的副本不覆盖。Bundled skill 版本无效时，在签发凭证前报错。

入口 skill 可以通过 `npx skills add echoVic/pilion-browser` 独立更新；这不会升级 App/CLI。`pilion skill` 的完整指南随 CLI 交付，入口不包含 Space 生命周期等具体运行规则。

「移除」，或者在客户端列表里吊销 / 删除这个集成客户端时：删掉 `cli.token`，删掉 shim（只删带标记的），删掉带 `.pilion-managed` 的 skill 目录，清空 `integration.json`，写审计。`externalControl` 开关不动，因为用户可能还有别的客户端。

打包：在 `electron-builder.yml` 里加 `extraResources: [{from: skills/pilion-browser, to: skills/pilion-browser}]`，运行时用 `process.resourcesPath` 取。开发模式直接用仓库里的目录。

#### 安全取舍（要写进 README 和 architecture）

0.1.10 的安全复审定下过一条「CLI 不再自动读 userData 里的共享 token」。这次在**用户显式点击之后**，有意回退成一个文件凭证：

- 任何同用户进程都能读到 `cli.token`，进而以 `external:<cliClientId>` 的身份驱动浏览器。这和现在用户把 token 粘进 shell rc 或 MCP 配置时的风险相同，没有更差，但它变成了默认路径。
- 缓解措施：这个凭证只在用户点「安装到 Agent」后才存在；它和其他外部客户端一样，只能操作自己开的标签，效果类操作固定走「操作前确认」，不随对话的完全访问模式变化，白名单不变；可以一键移除或吊销，吊销后立刻断开连接、摘掉 ACL、删除文件；总开关一关，socket 就停止监听。
- token 文件路径不随 state 广播，只记在 shim 和 `integration.json` 里。

### 一期测试

单测（vitest）：

- `cli/args`：各命令的参数解析和错误用法。
- `pilion skill`：输出以哨兵行结尾，不连 socket。
- `SKILL.md` 声明独立稳定版本；两个 symlink 都存在并指向正确。测试覆盖 App 单独升级、skill 单独升级、旧标记迁移、同版不重写、新版不降级，以及未知版本保留。
- `agent-integration`（临时 home 加临时 userData）：
  - shim 内容和权限；路径含空格或单引号时转义正确；遇到不带标记的同名文件、或者符号链接时拒绝；启动时内容不一致会重写。
  - token 文件是 `0600`，`wx` 新建，拒绝符号链接；移除时删除。
  - skill 复制只写进父目录存在的目标；跳过不带标记的同名目录；版本落后时刷新；移除时只删带标记的目录。
  - 吊销集成客户端会触发清理。
- `server`：ack 带上 `version`；旧客户端解析 `{}` 时照常工作。

E2E（Playwright + Electron，测试 profile）：在设置页点「安装到 Agent」，然后用生成的 shim 跑真实子进程 `pilion new <fixture url>`、`pilion read`、`pilion observe`、`pilion click`，断言成功，并断言用户当前选中的标签没有变；点「移除」后 `pilion status` 报告凭证缺失。E2E 里的 home 指向临时目录，绝不写真实的 `~/.claude`，守卫复用 `e2e-profile-guard`。

---

## 二期：每个对话一个 Agent Space

### 模型

- `BrowserSpaceSchema` 增加可选字段 `agent?: { clientId: string; label: string; createdAt: number; state: 'active' | 'ended' }`。带 `agent` 的 Space 就是 Agent Space。
- 上限：用户 Space 仍是 20 个；Agent Space 另外最多 8 个**活跃**的。第 9 个建不出来，报错让 Agent 先 `space close`，或者请用户在侧栏结束一个。已结束的 Agent Space 最多保留 8 个，超出时按结束时间淘汰最旧的，它的标签进归档。
- 子 principal 是 `external:<clientId>:<spaceId>`。现有 ACL、审计、审批都按 principal 处理，所以对话之间天然隔离，ledger 也按 Space 自然分成独立的流。
- 只有签发这个 Space 的那个 `clientId` 能用它。服务端在 hello 阶段校验。

### 协议

- hello 帧增加可选的 `space: string`。服务端会校验：这个 Space 存在、属于该 clientId、状态是 active（处于 ended 的，见下面「恢复」）。校验通过后 `admit(clientId, name, spaceId)`，固化子 principal。没带 `space` 时，行为和一期相同，用基础 principal（MCP 客户端走这条路）。
- 新增**控制帧** `{id, control: {op, ...}}`，和工具请求分开处理，不进 `EXTERNAL_TOOLS` 白名单，也不碰浏览器：
  - `space.create {label}` → `{spaceId}`
  - `space.list` → 只列本 clientId 的 Agent Space
  - `space.close {spaceId}` → 结束 Space，撤掉子 principal 的 ACL，标签留给用户
- 审计：`external.space.created/closed/stopped/taken_over/resumed/evicted`。

### CLI

- `pilion space new "<label>"` 打印 spaceId；`--json` 时输出 `{spaceId}`。
- `pilion space list`、`pilion space close <id>`。
- 所有浏览器命令都要带 `--space <id>`（也可以用环境变量 `PILION_SPACE`，但每次 Bash 调用都是新 shell，所以以参数为主）。**对集成客户端来说，缺 `--space` 就直接报错**，提示先 `pilion space new`，不会退回到共享 principal。`skill/status/version/space *` 不受这条限制。
- 指南里的标准流程改成：开始任务时 `space new`，记下 id，之后每条命令都带上，任务结束时 `space close`。

### 浏览器侧

- `openAgentTab` 由子 principal 调用时，标签进入对应的 Agent Space，`kind: 'today'`，在后台打开，不切换用户的视图（复用现有的 `backgroundTabs`）。
- `SpaceSwitcher` 把 Agent Space 单独分一组，显示客户端名、label，以及「AI 操作中」或「已结束」。每个 Space 有三个操作：
  - **查看**：切换过去。用户看自己的东西，不影响 Agent。
  - **停止**：中止在途操作，摘掉子 principal 的 ACL，Space 标为 ended，此后该 Space 的所有请求都会被拒绝。
  - **接管**：等于停止，再加上把 Space 转成普通的用户 Space（去掉 `agent` 字段），标签归用户所有。
- 审批摘要的来源一行改成：「来源：外部调用（本机 Agent（CLI）· <label>）」。

### 生命周期

- lease：每个子 principal 有自己的 60 分钟空闲 lease。过期后 Space 标为 ended，标签保留。
- 恢复：Pilion 重启后，Agent Space 都以 ended 状态恢复（标签带 `ownerPrincipal`，现有字段已经支持）。同一个 clientId 在 hello 时带上 ended 的 spaceId，会**重新激活**它：重新给它自己的标签授 ACL（只限 `ownerPrincipal` 等于该子 principal 的标签），并写审计 `resumed`。被用户接管或停止过的 Space 不能重新激活。
- 吊销集成客户端，会一并停止它所有的 Agent Space。

### 二期测试

单测：

- 子 principal 之间 ACL 隔离：A 的 Space 碰 B 的标签会得到 `PERMISSION_DENIED`。
- hello 时校验 space 的归属和状态。
- 控制帧不经过工具白名单，也不能调用工具。
- 上限和淘汰规则。
- 停止和接管之后请求被拒。
- 重启后重新激活只恢复本 principal 的标签。

E2E：两个并行的 `pilion space new`，各自开标签、各自读页面，交叉访问时被拒；侧栏能看到两个 Agent Space，「停止」后对应的 CLI 报错，「接管」后 Space 变成普通 Space；整个过程中用户选中的标签不变。

## 不做

- 不做 `pilion mcp`（MCP 客户端继续用现有的 MCP 配置 JSON）。
- 不做代码模式和 in-page JS。
- 不做 Windows（外部通道本来就禁用）。
- 不做 `npx skills add` 的 npm 发布。仓库里的 symlink 已经让它能从 GitHub 安装，不需要另外发包。
- 不做按父进程 PID 自动分 Space。

## 风险

| 风险                                   | 应对                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 文件凭证被同用户进程读到               | 只在显式安装后才存在；能力受 ACL、审批、白名单约束；一键吊销                                            |
| `~/.local/bin` 不在 PATH               | `install.md` 和 UI 都提示；`status` 会检测                                                              |
| 用户已有同名 `pilion` 命令或同名 skill | 只覆盖带标记的文件或目录，冲突时在 UI 里显示                                                            |
| Agent 忘带 `--space`                   | 集成客户端缺参数就报错，错误信息里给出正确的命令                                                        |
| 审批阻塞让 CLI 超时（90 秒）           | 指南里说明；超时错误信息提示用户去 Pilion 窗口审批                                                      |
| `main.ts`（5762 行）继续膨胀           | 集成逻辑放进 `external/agent-integration.ts`，Space 控制放进 `external/spaces.ts`，`main.ts` 只负责接线 |
