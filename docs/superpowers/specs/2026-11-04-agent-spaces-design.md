# Agent Space：每个外部 Agent 对话一个 Space（二期）

> 一期见 `2026-11-03-agent-skill-cli-design.md`（「安装到 Agent」、`pilion` CLI、`pilion-browser` skill，已合入本地 main 78abbe3）。本文是它「二期」一节的落地设计，二者冲突时以本文为准。

## 目标

终端 Agent（Claude Code、Codex 等）通过 `pilion` CLI 驱动 Pilion 时，每个对话拥有自己独立的 Agent Space：

- 对话之间互相碰不到对方的标签（ACL 按子 principal 隔离）。
- Agent 干活时，用户当前的标签列表和选中的标签不变。
- 用户在空间切换器里能看到每个对话在做什么，并能「查看 / 停止 / 接管」。

## 不做

- MCP 客户端和手动签发的客户端不强制使用 Space，保持一期行为（它们可以发控制帧建 Space，但不强制）。
- 不按父进程 PID 自动分 Space。
- 不改后台标签上限（全局 12 个）。
- 不做 Windows（外部通道本来就禁用）。

## 1. 数据模型与生命周期

### Schema（`src/shared/tab-organization.ts`）

```ts
const AgentSpaceInfoSchema = z.object({
  clientId: z.string().min(1).max(256),
  label: z.string().trim().min(1).max(40),
  createdAt: z.number().finite().nonnegative(),
  state: z.enum(['active', 'ended']),
  endedAt: z.number().finite().nonnegative().optional(),
  endReason: z.enum(['closed', 'stopped', 'idle', 'restart']).optional(),
});
BrowserSpaceSchema = z.object({ id, name, color, agent: AgentSpaceInfoSchema.optional() });
```

- 带 `agent` 的 Space 就是 Agent Space。`name` 取 label，`color` 固定 `'neutral'`。
- `TabStateSchema.spaces` 上限从 20 改为 40（用户 20 + 活跃 Agent 8 + 已结束 Agent 8，再留 4 个余量：淘汰要先异步归档标签再删 Space，期间已结束的会短暂多出几个）。`TabOrganization.createSpace` 的 20 个上限只统计不带 `agent` 的 Space。
- 渲染进程用的 `SpaceCreateSchema` / `SpaceEditSchema` 保持 strict，**不含 `agent`**：渲染进程无法创建或伪造 Agent Space。`SpaceEditSchema` 改为从不含 `agent` 的基础 schema 派生。
- 旧工作区 JSON 没有 `agent` 字段，照常加载。

### 规则（新文件 `src/main/external/spaces.ts`）

一个不依赖 Electron 的类 `AgentSpaces`，时钟、定时器与副作用全部注入，便于单测。

- **上限**：全局最多 8 个 active Agent Space、8 个 ended Agent Space，不按 client 分。Space 总数和后台标签上限都是全局的，按 client 计会让多个客户端突破 schema 上限。

- **create(clientId, label)**：已有 8 个 active 时拒绝，错误信息让 Agent 先 `pilion space close <id>`，或请用户在侧栏结束一个。成功后 Space 不会成为 `activeSpaceId`。写审计 `created`。
- **淘汰**：已结束的 Agent Space 超过 8 个时，按 `endedAt` 淘汰最旧的：它的标签进归档（`archivedTabs`，沿用现有 200 上限的裁剪规则），Space 删除，写审计 `evicted`。在每次 `end` 之后与启动时执行。
- **end(spaceId, reason)**：见第 3 节「停止」。Space 状态改为 ended，记 `endedAt` 与 `endReason`，标签留在原地。
- **空闲**：CLI 每条命令都是一个短连接，所以 60 分钟空闲计时挂在 Space 上，不挂在连接上。每个被接纳的工具请求调用 `touch(spaceId)` 重置计时。到时 `end(id, 'idle')`，写审计 `idle`。
- **恢复 resume**：只允许 `endReason` 为 `idle` 或 `restart` 的 Space。恢复后状态回到 active，并且只给 `ownerPrincipal` 等于该子 principal 的标签重新授 ACL。写审计 `resumed`。若恢复会超过 8 个活跃上限，拒绝并给出同 create 的提示。被 Agent 关闭（`closed`）或被用户停止（`stopped`）的 Space 永远不能恢复。
- **启动**：启动时恢复完标签之后，所有 active 的 Agent Space 改为 ended，`endReason: 'restart'`，然后执行淘汰。必须在标签恢复之后做：淘汰要把标签归档，若先删了 Space，恢复循环会把它的标签放进用户的 Space。
- **接管 takeOver(spaceId)**：等于 `end(id, 'stopped')`，再去掉 `agent` 字段，Space 变成普通用户 Space，标签的 `ownerPrincipal` 改为用户。若用户 Space 已有 20 个，拒绝并提示用户先删一个空间。写审计 `taken_over`。
- **吊销客户端**：一并对它所有 active 的 Space 执行 `end(id, 'stopped')`。

### 用户对 Agent Space 的编辑

- 不能把标签移入或移出 **active** 的 Agent Space（接管后才可以移动）。
- Agent Space（无论 active 还是 ended）不能改名或改颜色；active 的不能删除。
- active 的 Agent Space 里的标签不能改成固定或常用（常用标签会出现在所有 Space，取消常用时还会被移到用户当前 Space，等于绕过移动限制）。
- 删除已结束的 Agent Space：它的标签进归档，**不**像现有 `removeSpace` 那样并到第一个 Space。
- 这些守卫放在 `TabOrganization` 里，IPC 层报错文案中文。

## 2. 协议与 CLI

### hello 帧（`src/main/external/server.ts`）

`HelloSchema` 增加可选 `space: string`（1–256），仍为 strict。处理顺序：

1. 校验 token、识别客户端（一期逻辑）。
2. 带 `space` 时调用 `runtime.admitSpace(clientId, spaceId)`，结果四选一：
   - `ok`：Space 是 active 的。
   - `resumed`：Space 因 idle / restart 结束，已重新激活。
   - `not_found`：不存在或属于其他 client。两种情况返回**同一个**错误，避免探测别人的 spaceId。
   - `ended`：被关闭、停止或接管，不可恢复。错误信息「Space 已结束，请用 pilion space new 新建」。
3. 通过后 `admit(clientId, name, spaceId)`，principal 固化为 `external:<clientId>:<spaceId>`。
4. 不带 `space` 且客户端 `kind === 'agent-integration'`：连接仍被接纳（用基础 principal），可以发控制帧；**任何工具帧**都返回错误码 `SPACE_REQUIRED`，信息里给出正确命令：`先运行 pilion space new "<任务名>"，再给每条命令加 --space <id>`。
5. 不带 `space` 的其他客户端：一期行为不变。

### 控制帧

帧格式 `{id, control: {op, ...}}`，用 strict 的 discriminated union 校验，在 `RequestFrameSchema` 之前判断。控制帧**不经过** `EXTERNAL_TOOLS` 白名单，也不调用 `runtime.run`，只调用 `runtime.spaces`：

| op             | 参数                 | 返回                                                                |
| -------------- | -------------------- | ------------------------------------------------------------------- |
| `space.create` | `{label}`（1–40 字） | `{spaceId}`                                                         |
| `space.list`   | —                    | `{spaces: [{spaceId, label, state, endReason?}]}`，只列本 client 的 |
| `space.close`  | `{spaceId}`          | `{ok: true}`；只能关自己的，否则 `not_found`                        |

控制帧也计入每连接 4 个在途上限。带 Space 的连接同样可以发控制帧（例如关掉自己）。

### 子 principal 的连接

- `admitExternalConnection` 增加可选 `spaceId`，为子 principal 建独立的 attachment，登记进 `externalAttachments`，于是 `authorizeBrowserPrincipal` 的精确匹配无需改动。
- 连接的 `run` 每次调用前检查 Space 仍为 active（防止停止后仍开着的连接），并 `touch`。
- 子 principal 的连接正常断开时只 `invalidatePrincipal`，ACL 保留（一期语义）；ACL 只在 `end` 时撤销。
- `externalSpacePrincipal(clientId, spaceId)` 与 `parseExternalPrincipal(p): {clientId, spaceId?} | undefined` 放在新文件 `external/principal.ts`；现有的 `startsWith('external:')` 判断继续有效。
- `ExternalConnection` 增加只读 `spaceId?`；`ExternalRuntime` 增加 `spaces: ExternalSpaceControl`（`admit/create/list/close/stopClient`）。服务端吊销、删除客户端时按 `conn.clientId` 断开它所有连接（含子 principal），并调用 `spaces.stopClient`。

### CLI（`src/main/external/cli/`）

- 新文件 `cli/space.ts`：
  - `pilion space new "<label>"`：stdout 只打印 spaceId（便于 `$(pilion space new …)` 取值），stderr 打印提示「之后每条命令都加 --space <id>（或 export PILION_SPACE=<id>）」；`--json` 输出一行 `{"spaceId":"..."}`。
  - `pilion space list [--json]`：表格或 JSON 数组。
  - `pilion space close <id>`。
- 所有浏览器命令接受 `--space <id>`，未给时读 `$PILION_SPACE`。CLI 不自己判断「缺 Space」，由服务端统一报 `SPACE_REQUIRED`，保证各入口文案一致。
- `skill`、`status`、`version`、`space *` 不需要 Space。
- `client.ts` 的 hello 在有 space 时带上 `space`；新增发送控制帧的方法。

### 指南与 skill

- `guide.ts` 的标准流程改为：`space new` → 记下 id → 每条命令带 `--space` → `space close`。说明 Space 被用户停止或接管后的报错含义和应对（不要重试，告诉用户）。
- `skills/pilion-browser/references/install.md` 增加 `SPACE_REQUIRED` 的排错说明。`SKILL.md` 的 `metadata.version` **不改**：`tests/skill-package.test.ts` 要求它等于 `package.json` 的版本，二者在发版时一起升。

## 3. 浏览器侧与界面

### 开标签（`openAgentTab`）

- 调用者是子 principal 时，标签直接进入对应的 Agent Space（`kind: 'today'`、后台打开），不看用户的 `activeSpaceId`，也不看会话上一个标签。
- `ownerPrincipal` 记录完整子 principal，恢复时据此只拿回自己的标签。
- 全局 12 个后台标签上限不变，超出时报现有错误。
- 建 Space、开标签都不改变 `activeSpaceId`。
- 子 principal 调 `browser.tabs.activate`（`pilion activate`）只校验它对该标签有权限，不切换用户的视图；Agent 在自己的 Space 里没有「前台」可言。
- 用户「查看」一个还没有标签的 Agent Space 时提示「这个 Agent 空间还没有标签」，不新开标签。

### 停止 / 结束的副作用（`end` 在 main.ts 里的实现，抽成具名函数）

按顺序：

1. `browser.invalidatePrincipal(sub)` 中止在途操作。
2. 拒绝所有等待该子 principal 的审批。
3. `browser.revokePrincipal(sub)` 撤掉标签 ACL。
4. 关闭该子 principal 的所有在线连接。
5. 保存工作区并广播 state。

此后该 Space 的请求在 hello 阶段和每次工具调用时都会被拒绝。

### 空间切换器（`src/renderer/SpaceSwitcher.tsx`）

- 用户 Space 列表下方新增「Agent」分组，没有 Agent Space 时不显示。
- 每行显示「客户端名 · label」和状态徽标：**AI 操作中**（带现有的活动圆点）或 **已结束**。
- 每行操作：
  - **查看**：切换到该 Space。用户 principal 本来就是 owner，可以正常浏览，不影响 Agent。
  - **停止**：仅 active 时显示。
  - **接管**：active 和 ended 都显示，把它变成普通用户 Space。
  - **删除**：仅 ended 时显示，标签进归档。
- 当前 Space 是 Agent Space 时，「编辑当前空间」不可用。
- 客户端名不持久化：main 构建 `AppState` 时附上只读的 `agentClientNames: Record<clientId, name>`（客户端已吊销时值为「已吊销的客户端」；表里查不到——已删除，或对外通道关着拿不到注册表——时界面显示「外部客户端」）。
- 用户自己开的标签（⌘T、恢复归档等）若会落进 active 的 Agent Space，改放到第一个用户 Space；标签右键「移动到」只列用户 Space。
- 新 IPC：`spaces.stopAgent(id)`、`spaces.takeOverAgent(id)`；删除已结束的 Agent Space 复用现有 `spaces.remove`。新 API 同时加到 `src/preload/index.ts` 与 `src/preload/entry.cts`，parity 测试覆盖。

### 审批摘要

- 子 principal 发起时，来源一行为「来源：外部调用（<客户端名> · <label>）」，集成客户端名是「本机 Agent（CLI）」。
- MCP 和手动签发的客户端保持一期文案。

### 审计

`external.space.created / closed / stopped / taken_over / resumed / evicted / idle`。每条带 `clientId` 和 `spaceId`，**不带 label**：label 是 Agent 写的，不进日志。

### 代码放置

- 规则：`src/main/external/spaces.ts`。
- `TabOrganization`：用户 Space 计数、移动和编辑守卫、按 Space 归档。
- `main.ts`：只接线和 `end` 的副作用，抽成具名函数；不在 `init()` 里新增自由标识符（vm 片段测试会挂），需要时抽函数并在测试里打桩。

## 4. 测试

### 单测（vitest）

- `spaces.ts`（假时钟、注入副作用）：第 9 个 active 被拒；已结束超过 8 个时淘汰最旧、标签进归档；`end` 副作用顺序；60 分钟空闲结束、`touch` 重置；启动时 active → `restart`；`resume` 只对 `idle`/`restart` 生效且受活跃上限约束；接管在 20 个用户 Space 时被拒；吊销客户端停止它所有 Space。
- `server.ts`：hello 带 space 的四种结果；`not_found` 对「不存在」和「属于别人」返回同一错误；集成客户端不带 space 能发控制帧、发工具帧得 `SPACE_REQUIRED`；MCP 客户端不带 space 行为不变；控制帧不进 `runtime.run`、不查白名单；畸形控制帧被拒。
- ACL：子 principal 碰别的 Space 的标签得 `PERMISSION_DENIED`；停止后自己的标签也被拒；恢复后只重新授权 `ownerPrincipal` 匹配的标签。
- `TabOrganization`：用户 Space 计数；active Agent Space 不能移入移出、不能改名删除；删除已结束的 Agent Space 标签进归档。
- Schema：`SpaceEditSchema` 拒绝 `agent`；不带 `agent` 的旧 JSON 正常加载。
- CLI：`space new/list/close` 参数解析；`--space` 回落到 `$PILION_SPACE`；`--json` 输出。
- 合约 parity 测试覆盖新 IPC；vm 片段测试保持绿（新增依赖打桩）。

### E2E（Playwright，`PILION_INTEGRATION_HOME` 沙箱，同时只跑一个 E2E 套件）

- 安装后并行两个 `pilion space new`，各开一个标签、各自读页；交叉使用对方的 `--tab` 被拒。
- 全程用户选中的标签和 `activeSpaceId` 不变。
- 切换器的 Agent 分组显示两行。
- 「停止」第一个：它的 CLI 命令报「Space 已结束」，第二个仍可用。
- 「接管」第二个：它进入用户分组，标签还在，它的 CLI 命令报错。
- 不带 `--space` 的浏览器命令得 `SPACE_REQUIRED`。

### 完成标准

合并后的树上单测和 E2E 全绿；不运行 `electron-builder`；CHANGELOG `[未发布]` 写新条目；指南和 `install.md` 写新流程；README 与 `docs/architecture.md` 的外部通道一节写子 principal。

## 风险

| 风险                                   | 应对                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Agent 忘带 `--space`                   | 集成客户端服务端统一报 `SPACE_REQUIRED`，信息里给出正确命令             |
| 停止后仍开着的连接继续发请求           | 连接每次 `run` 前检查 Space 状态；`end` 时主动关闭连接                  |
| 通过 spaceId 探测别的客户端            | 「不存在」和「不属于你」返回同一错误                                    |
| label 里带敏感内容进日志               | 审计只记 clientId/spaceId                                               |
| `main.ts` 继续膨胀                     | 规则在 `spaces.ts`，main.ts 只接线                                      |
| Space 总数上限变化让旧版本读不了新数据 | 只放宽上限（20→40）；降级到旧版本时超过 20 个会被 schema 拒，属已知限制 |
