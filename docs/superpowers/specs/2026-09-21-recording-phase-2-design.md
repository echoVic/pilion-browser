# 录制与技能 第二期：提炼、Agent 使用与编辑

第一期（`2026-09-20-recording-and-skills-design.md`，已合并）让人录制并自己回放。第二期把录制交到 Agent 手里：Agent 把轨迹提炼成技能文档，人保留后任意 ACP Agent 都能发现并回放；人可以在界面上有限度地修改技能。本文只写第二期新增与变化的部分，第一期的不变量全部沿用。

## 目标

- Agent 把 `trajectory.md` 提炼成 `skill.md`，且**不能凭空造步骤**（四条对账）
- `browser.skills.list` / `browser.skills.play` 两个 MCP 工具；Agent 首次回放某技能需人一次审批，`full` 模式也问
- 回放卡在「需要我」或目标解析失败时交还，Agent 只修那一步再续播
- 技能库详情页可以改散文、结构化地改步骤，没有「新建动作步骤」

## 非目标

不做变量展开（占位符只是"回放到这一步交给人"）、不做技能导出/导入、不做技能间引用、不做多标签编排、不做定时触发、不改第一期的录制采集。

## 已定决策

| 决策           | 结论                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 范围           | 提炼、MCP、审批、交还、编辑五块一起做                                                                                                                |
| Agent 可见性   | `skills.list` 只列已提炼（有 `skill.md`）的；仅轨迹的条目 Agent 看不到也播不了                                                                       |
| 提炼会话       | 走「新对话」同一条路：新建对话并重连出干净的 ACP session，标题「提炼：<名字>」                                                                       |
| 卡在「需要我」 | 与 `browser.request_human` 同一段逻辑：任务转人工，工具返回 `HUMAN` 并要求 Agent 结束回合                                                            |
| 首次审批       | 复用现有 `requestApproval`，绑定发起时的标签 / epoch / origin；批准后同任务内同哈希不再问                                                            |
| 占位符         | `type.text` / `select.value` 匹配 `/^\{\{[^{}]{1,60}\}\}$/` 时通过对账；回放到该步当 `human`（`填写 "目标名"：xxx`）；`isPlaceholder()` 是唯一判定处 |

## skill.md

一个 fenced 块是唯一真相，块上方的散文原样保留、不解析，与轨迹文件同一套约定。

````markdown
# 月度导出

## 什么时候用

每月初要给财务那份 CSV 时。只管导出，不管后续上传。

## 前置条件

- 需要已登录 report.example.com

## 已知坑

- 「导出 CSV」有两个同名按钮，上面那个是导出当前筛选

```json pilion-skill
{
  "meta": {
    "app": "pilion",
    "version": 1,
    "kind": "skill",
    "name": "月度导出",
    "about": "登录后选月份并导出 CSV",
    "recordedAt": "2026-09-20T14:03:11+08:00",
    "distilledBy": "claude-code",
    "trajectory": "trajectory.md"
  },
  "steps": []
}
```
````

- `SkillSchema`：`meta.kind` 固定 `'skill'`，`about` ≤ 200 字，`distilledBy` 是 Agent 配置 id（人手工创建时为 `'person'`），`steps` 复用第一期 `StepSchema`，≤ 500 步
- `parseSkill(md) → { prose, skill }`，`serializeSkill(prose, skill) → md`：`prose` 是块上方全文（`trimEnd`），写回时 `prose + '\n\n' + 块`
- 解析失败沿用 `RecordingFormatError`，带行号；文件是不可信输入
- `RecordingLibrary` 加 `readSkill(id)` / `writeSkill(id, prose, skill)` / `hasSkill(id)`；`RecordingSummary` 加 `distilled: boolean` 与 `about`
- 回放取步骤的规则：有 `skill.md` 用它，否则用轨迹步骤。人工回放两者都行；Agent 只能播已提炼的

## 提炼

**前置**：已连接 Agent，没有活跃任务，不在录制或回放中，目标条目存在轨迹。

**会话**：新建对话（与「新对话」按钮同一条路，含重连），标题「提炼：<名字>」。聊天记录留在历史里可查；提炼结束后不自动切回原对话。

**Prompt**（固定中文说明 + 轨迹 md 原文）：

- 只输出一个 Markdown 文档，含 `# <名字>`、`## 什么时候用`、`## 前置条件`、`## 已知坑` 四段散文，和一个 ```json pilion-skill 块
- 步骤只能从轨迹里的动作挑选、合并、重排；可以插入 `human`（说明要人做什么）和 `note`；不得新增任何动作；不得改写人输入过的值，需要隐去的值用 `{{说明}}` 占位
- 散文不要复述步骤
- 不要调用任何工具

**那一轮不给浏览器工具**：`distilling` 标志期间 `executeTool` 拒绝，消息「提炼期间不提供浏览器工具，请只输出文档」。

**解析**：取该回合 assistant 文本（`runPrompt` 同款：从回合起点起的 assistant 消息拼接）→ 定位 ```json pilion-skill 块 → `JSON.parse` → `SkillSchema` → `reconcile`。任一步失败进入 `rejected`，原因随状态发给界面。

**`reconcile(skill, trajectory, { blocking })`**（`distill.ts`，纯函数）：

| 检查         | 规则                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动作有依据   | 轨迹中的动作步（navigate 之外的 click / type / select / check / press）构成一个池，每条只能被消耗一次。技能里的每个动作步按顺序在池里找第一条**同 kind、同目标**（`tagName` 相等、`role` 相等、`normalizeName(name)` 相等）且未消耗的，找到即消耗 |
| 值未被改写   | `type.text` / `select.value` / `check.checked` / `press.key` 必须与被消耗那条相同；`text` / `value` 也可以是占位符                                                                                                                                |
| URL 未被编造 | `navigate.url` 必须与轨迹里某条 `navigate` 步或某条 `page` 条目的 `url` 完全相同；不消耗                                                                                                                                                          |
| 例外         | `human` 与 `note` 自由                                                                                                                                                                                                                            |

阻塞模式返回 `{ ok: true }` 或 `{ ok: false, step, reason: 'NO_EVIDENCE' | 'VALUE_CHANGED' | 'URL_UNKNOWN' }`；非阻塞模式返回 `{ manual: number[] }`（没有依据的步骤序号），供界面标「手工添加」。

**状态**：`AppState.distillation?: { id, name, status: 'running' | 'proposed' | 'rejected', conversationId, markdown?, steps?, reason? }`。`proposed` 时主进程持有 `pendingSkill`，人按 **保留** 才 `writeSkill`；**丢弃**清空；**重炼**再发一轮（同一会话）。应用退出丢弃未保留的提案。

**错误**：Agent 回合失败、取消、空回复走现有 prompt 错误路径，`distillation.status = 'rejected'`，原因用现有可读错误文本。

## Agent 使用

### MCP 契约

`browser-mcp-server.ts` 注册两个工具，`ToolNameSchema` 加 `'browser.skills.list'`、`'browser.skills.play'`。描述是引导任意 ACP Agent 的唯一渠道，写成指令：

- `browser.skills.list`（无参数）：List the skills the person recorded and kept in this workspace. Prefer a matching skill over exploring by hand; each entry says when to use it. → `[{ id, name, about, steps, needsHuman, recordedAt }]`
- `browser.skills.play { skillId, fromStep? }`：Replay a kept skill on the current tab. `{ ok: true, steps, finalUrl }` when every step ran. On `{ ok: false }` read `failedAt`, `step`, `url`, `remaining`: fix only that step with `browser_observe` and the effect tools, then call this again with `fromStep = failedAt + 1`. On `reason: "HUMAN"` the browser was handed to the person; end your turn and, when they resume you, continue with `fromStep`. The first replay of a skill in a task asks the person once.

Host 策略里 `list` 归 observe 类（`pure-observe`），`play` 归 effect 类。

### `play` 的执行

在 `runTool` 顶部与 `request_human` 同级处理，不走元素路径：

1. 读取 `skill.md`（不存在或解析失败 → 工具错误「该技能未提炼」/ 格式错误含行号）
2. **首次审批**：`hash = sha256(JSON.stringify(steps))`；当前任务的 `approvedSkills` 没有该哈希时，构造 canonical command（tool `browser.skills.play`，arguments `{ skillId, stepsHash }`，target 为当前页）→ `createIntent`（verdict `require_approval`）→ `requestApproval`（`tool: 'browser.skills.play'`，summary = 名字 + about + 编号的 `describeStep` 行，绑定当前标签 / epoch / origin）。**`permissionMode === 'full'` 也走这一步**。批准后把哈希记入 `approvedSkills`（内存，按任务 id）。已批准则 verdict `allow`
3. `playSteps(steps, { fromStep, signal, execute, probe, onProgress })`：`execute` = `executeTool(req, agentActor)`，其中 `agentActor.replayApproval = approvalId` 令每步的策略裁决为 allow + `revalidate_target`（沿用第一期人工回放的做法），每步 Intent 仍记在 Agent 的 attachment 下；每步另写 `store.recordEvent('replay', skillId, 'replay.step', { step, requestId, approvalId })`，通过 `idempotency_key = requestId` 与 action 行对应。`probe` 读当前页快照，不进台账
4. 结果原样作为工具结果返回。`HUMAN`：先 `pauseForHuman(humanReason)`，任务记 `replayCursor = { skillId, name, nextStep: at + 1 }`，再返回 `{ ok: false, reason: 'HUMAN', at, step, humanReason, url, title, message: '浏览器已交回用户，请结束本回合；用户继续后从 fromStep 续播' }`。人点「继续任务」时，交接说明追加一句「技能「名」停在第 N 步，请从第 N+1 步续播」，`replayCursor` 随之清除
5. 占位符步骤在播放时视为 `human`，reason `填写 "<目标名>"：<占位符内容>`

**互斥**：Agent 回放期间 `agentReplay` 有值，`startRecording` / `startReplay` 拒绝；人的录制或回放期间 Agent 工具照旧被拒（第一期）。停止 / 接管走现有 `interruptAgent`，同时 abort 播放器的 controller。

**界面**：Agent 操作条的 detail 显示「回放「名」 3/5」（`AppState.agentReplay?: { name, step, total }`）；审批出现在输入框上方的现有审批区，详情里是全部步骤。

## 编辑分权

技能库详情页「技能」标签：

- **散文**：textarea + react-markdown 预览，自由改
- **步骤**：结构化操作 —— 删除、上移 / 下移、改 `type.text` 或 `select.value`（可填占位符）、改 `human.reason`、在任意位置插入 `human`。**没有「新建动作步骤」**
- **保存**：IPC `skills:save { id, prose, steps }`。主进程校验：`steps` 逐条过 `StepSchema`；每个动作步必须与当前文件里某个动作步 **kind + 目标** 相同（值可变），且总数不超过原有该 kind + 目标的条数 —— 这条在主进程执行，界面没有新建按钮只是表象。通过后 `writeSkill` 整体重写；哈希变了，Agent 下次 `play` 重新审批
- **手工添加**：加载时用 `reconcile` 非阻塞模式，没有轨迹依据的步骤显示「手工添加」标记（人直接改文件加的步骤是允许的）
- **提炼入口**：仅轨迹的条目显示「提炼」，已提炼的显示「重炼」；`distillation.status` 为 `running` 时该条目禁用其它操作；`proposed` 时详情页顶部横幅 + 提案预览（散文 + 步骤）+ 保留 / 丢弃 / 重炼；`rejected` 时显示原因 + 重炼
- 列表行状态：已提炼 / 仅轨迹；仅轨迹的行注明「Agent 看不到」

## 模块

| 文件                                          | 改动                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `main/recording/types.ts`                     | `SkillSchema`、`isPlaceholder()`                                                                                                 |
| `main/recording/format.ts`                    | `parseSkill` / `serializeSkill`                                                                                                  |
| `main/recording/library.ts`                   | `readSkill` / `writeSkill` / `hasSkill`，summary 的 `distilled` / `about`                                                        |
| `main/recording/distill.ts`                   | 新增：`buildDistillPrompt`、`extractSkillMarkdown`、`reconcile`、`stepsHash`                                                     |
| `main/recording/player.ts`                    | 占位符步骤视为 `human`                                                                                                           |
| `main/agents/browser-mcp-server.ts`           | 两个工具                                                                                                                         |
| `shared/contracts.ts`                         | `ToolNameSchema` 两项、`AppState.distillation` / `agentReplay`、`ConversationTask.replayCursor`、`SkillSave` 等 schema、IPC 常量 |
| `main/main.ts`                                | 提炼编排、`play` 分支、`approvedSkills`、`agentReplay` 互斥与取消、`skills:save` 校验、交接说明                                  |
| `preload/index.ts` **与** `preload/entry.cts` | 同步加方法（第一期的教训：两个文件都要改）                                                                                       |
| `renderer/SkillLibrary.tsx`                   | 编辑、预览、状态                                                                                                                 |
| `tests/fixtures/e2e-agent.mjs`                | 「提炼」分支回固定 skill.md；「用技能」分支调用 list / play                                                                      |

## 安全与数据边界

- Agent 只能通过 MCP 读技能摘要与回放；写入技能目录的只有 Pilion（提炼保留、界面保存）和人
- 提炼那一轮没有浏览器工具；对账在主进程执行，Agent 的输出是不可信文本
- `skills:save` 的"不能新建动作步骤"在主进程校验，不依赖界面
- 首次审批的 digest 覆盖步骤内容哈希，技能一改即失效；每步 Intent 与 `replay.step` 事件让台账能回答「这一步依据哪次审批」
- 占位符不展开，不引入任何变量存储

## 测试

单元：

- `format`：skill 往返、块上方散文原样保留、坏文件报行
- `distill`：四条对账各一个必拒用例、消耗式匹配（一条轨迹步不能被复用两次）、占位符通过、URL 来自 page 条目也算、非阻塞模式的 `manual` 列表、`extractSkillMarkdown` 对多余文字 / 无块 / 多块的处理（多块取第一个）
- `player`：占位符步骤返回 `HUMAN` 且 reason 含目标名
- `library`：`hasSkill` / `readSkill` / `writeSkill`，summary 的 `distilled`
- `browser-mcp-server`：两个工具注册、`play` 参数校验（`fromStep` 范围）
- `main.ts` 的 `skills:save` 校验逻辑抽成纯函数 `validateSkillEdit(existing, submitted)` 放在 `distill.ts`，单测覆盖：删步、改值、插 human 通过；新增动作步、复制动作步被拒

Electron E2E（确定性 fixture Agent）：

1. 录一段 → 提炼 → 保留 → `skills.list` 只列它 → Agent `play` → `full` 模式下审批出现在输入框上方 → 批准 → 回放到 iana.org → Host `events` 里有 `replay.step`
2. 目标消失 → fixture 收到的工具结果含 `failedAt: 2` 与 `remaining`
3. 技能含「需要我」→ 任务转人工 → 继续任务 → fixture 用 `fromStep` 续播完成
4. 编辑：删一步 + 插「需要我」→ 保存 → 再 `play` 重新审批

## 实现前需验证

1. 审批绑定发起时的标签 / epoch / origin：决策时的重校验必须在回放尚未开始时通过 —— 审批在第一步执行前完成，页面未动。若现有校验因 `browser.skills.play` 没有 elementRef 而拒绝，给审批路径加「无目标」形态
2. 工具名转换：`browser.skills.play` → MCP 名 `browser_skills_play`（现有 `replaceAll('.', '_')`），确认与 Claude / Codex 适配器的工具名限制兼容
3. 一次 `play` 是一次可能长达四分钟的工具调用；确认 ACP 适配器不会对长工具调用超时（第一期 E2E 的回放约 20 秒，未触及）
4. 「新对话」路径的重连耗时（数秒）作为提炼的前置延迟是否可接受；不可接受则在当前 ACP session 上直接发提炼 prompt、只把消息记入新对话记录

## 对现有文档的改动

- `docs/architecture.md`「录制与技能」加提炼、MCP 工具、审批与交还、编辑分权四段；MCP 工具清单加两项
- `CHANGELOG.md`「未发布」加提炼与 Agent 使用的条目
- README 若列出 MCP 工具，同步两项
