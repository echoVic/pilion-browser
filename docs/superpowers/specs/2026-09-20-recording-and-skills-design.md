# 录制与技能

人录制一段浏览器操作，交给 Agent 提炼成一份技能，你决定是否保留；此后任意 ACP Agent 都能发现并使用它。

## 目标

- 人录制自己的真实操作，得到一份可移植的行为轨迹（文本 + 步骤）
- Agent 把轨迹提炼成技能文档：什么时候用、前置条件、已知坑、步骤
- 技能以确定性回放为主；某步解析不到目标时交还 Agent，由它用现有工具接上再续播
- 一处管理：查看、修改、一键提炼、回放
- 不引入任何新的元素身份通道，不给 Agent 任何脚本执行能力

## 非目标

不做参数化与变量、循环与条件、定时触发、跨设备同步、跨标签编排、iframe 支持、录制导出为 Playwright 脚本、把技能写入某个 Agent 自己的 skills 目录。技能库只由 Pilion 和人写入。

## 已定决策

| 决策 | 结论 |
| --- | --- |
| Agent 如何消费 | 混合：确定性回放为主，卡住交还 Agent，修完那一步续播 |
| 如何采集 | 隔离世界里的固定录制脚本，只收 `isTrusted` 事件 |
| 敏感输入 | 不录。密码与一次性验证码只留「需要我」步骤，回放到此转人工 |
| 发现与授权 | Agent 自己 `list` 与 `play`；首次回放某技能需一次审批，列出全部步骤 |
| 谁能录 | 只有人。MCP 里不存在录制动词 |
| 产物形态 | 一个 md 文件，机器可读部分承载在其中的 fenced json 块里 |

## 核心结论：回放不新增元素身份通道

`main/main.ts` 的 `runTool` 是所有工具的唯一入口：`requireAttachment` → snapshot → `describeElement` → `validateTrustedEffectTarget` → `classifySemanticRisk` → 策略裁决 → 规范化命令 → `createIntent` → 审批 → 执行凭证 → 执行。

player 不实现「按选择器点击」。它是主进程里的一个 `ToolRequest` 调用方，与 Agent 走同一条路：

```
播放第 N 步：
  executeTool({ name: 'browser.observe' })   → 新鲜 Observation（含 ElementRef）
  resolve(step.target, observation)          → 纯函数匹配，挑出唯一 ref
  executeTool({ name: 'browser.click', args: { elementRef } })
```

因此 Intent 与审计、`actionDigest`、指纹重校验、`documentEpoch`/fencing、`ask` 模式策略、agent-shield、可见光标、停止与接管的取消链路全部沿用，一行不改。`ElementRef` 仍然只能由 `observe` 签发；`main/browser/types.ts` 中 "Deliberately has no execute(command) or CDP escape hatch" 依然成立。

**不存 ElementRef。** `browser-service.ts` 的校验要求 `candidate.documentEpoch === tab.documentEpoch`（当前活的 epoch）、存储 ref 逐字段相等、指纹一致，否则 `STALE_ELEMENT`；而 `document-committed` 每次导航都递增 epoch。ref 的三层身份都是一次性的：`tabId` 是本次运行的标签身份，epoch 回放前必然已变，`id` 背后的 `elementKey` 是 CDP `nodeId`，在新文档里无意义。存 ref 等于存一个文件描述符编号。

录制时仍然跑 `observe()`，但只用来取词：`role` / `name` / `inputType` 走与回放同一条 AX 路径，避免两头对「可访问名」的理解不一致。存下来的只有可移植语义，不含任何只有 Pilion 认得的句柄（不存 `querySelectorAll` 序号，因为那会把格式焊死在 `electron-page-adapter.ts` 的 `SELECTOR` 常量上）。

## 能力边界

由 `observe()` 的能力决定，录制时当场判定并标记，不等回放才失败：

| 边界 | 原因 |
| --- | --- |
| 只支持主框架，iframe 内的操作录不了 | `applyVisibleEffect` 对 `frameId !== 'main'` 抛 `UNSUPPORTED_ELEMENT` |
| 只支持 `a,button,input,textarea,select,[role]` | `observeElements` 的 `SELECTOR` |
| 单文档最多前 200 个元素 | `observeElements` 的截断 |
| 一份技能跟着当前标签走 | 不做多标签编排 |
| 没有 scroll 步骤 | `applyVisibleEffect` 自己把目标滚进视口 |
| 没有拖拽、hover 菜单、右键 | 现有 `BrowserEffect` 里没有 |

## 产物格式

一个目录一份技能：

```
~/Library/Application Support/Pilion/recordings/<slug>/
  trajectory.md   机器写的原始轨迹，只追加，不删改
  skill.md        提炼产物，你批准后才存在
```

**一个 fenced json 块是唯一真相，其余全是给人和 Agent 看的散文。** 不用 frontmatter：运行时依赖只有 ACP SDK、MCP SDK 和 zod，不值得为 YAML 再加一个；而元信息同时出现在 frontmatter 和 json 块里又会互相不一致。

加载时只做三件事：找到 fenced block → `JSON.parse` → zod。解析不了就拒绝回放并指出哪一行，不猜、不修。写回时按规范形式重写整个文件。

`skill.md`：

````markdown
# 月度导出

## 什么时候用
每月初要给财务那份 CSV 时。只管导出，不管后续上传。

## 前置条件
- 需要已登录 report.example.com
- 月份下拉在数据未就绪时是禁用的，要等表格出现

## 已知坑
- 「导出 CSV」有两个同名按钮，上面那个是导出当前筛选

```json pilion-skill
{
  "meta": {
    "name": "月度导出",
    "about": "登录后选月份并导出 CSV",
    "recordedAt": "2026-09-20T14:03:11+08:00",
    "distilledBy": "claude-code",
    "trajectory": "trajectory.md"
  },
  "steps": [
    { "kind": "navigate", "url": "https://report.example.com/login" },
    { "kind": "type", "onUrl": "https://report.example.com/login",
      "target": { "role": "textbox", "name": "邮箱", "tagName": "input", "inputType": "email" },
      "text": "me@x.com", "replace": true },
    { "kind": "human", "onUrl": "https://report.example.com/login", "reason": "填写密码" },
    { "kind": "click", "onUrl": "https://report.example.com/login",
      "target": { "role": "button", "name": "登录", "tagName": "button" } },
    { "kind": "select", "onUrl": "https://report.example.com/dashboard",
      "target": { "role": "combobox", "name": "月份", "tagName": "select" },
      "value": "2026-09" },
    { "kind": "click", "onUrl": "https://report.example.com/dashboard",
      "target": { "role": "button", "name": "导出 CSV", "tagName": "button",
                  "nth": 2, "fingerprint": "a1b2c3d4" } }
  ]
}
```
````

**散文段不许复述步骤。** 步骤只存在于 json 块里；界面显示与交还 Agent 时都从 json 渲染成人话。否则散文写 5 步、json 里 6 步，你批准的是哪个都说不清。

`trajectory.md` 同构：一个 ```json pilion-trajectory 块装原始事件，上面的时间线是从它渲染出来的，加载时直接忽略。轨迹额外含页面条目（URL、标题、`readText()` 摘录截 2000 字）、`note` 旁白、以及每条步骤的 `unsupported` / `ambiguous` 标记。

步骤类型：`navigate` / `click` / `type` / `select` / `check` / `press` / `human` / `note`。`note` 不参与回放。

`onUrl` 出现在除 `navigate` 与 `note` 之外的每个步骤上，作为前置条件；`human` 也带，它同样需要页面在正确位置。

录制产出的 `type` 一律 `replace: true`：脚本记的是字段最终值而非增量，回放时应当整体覆盖。

`target` 字段：`role`、`name`、`tagName`、`inputType?`、`optionValues?`、`nth?`（`role` + `name` + `tagName` 完全相同的候选多于一个时，按文档顺序第几个）、`fingerprint?`（`localFingerprint` 前 8 位十六进制）。

## 模块

新增 `src/main/recording/`：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `Skill` / `Trajectory` / `Step` / `StepTarget` |
| `format.ts` | md 的 parse 与 serialize（定位 fenced block、zod、规范化写回） |
| `recorder-script.ts` | 固定的隔离世界脚本源码，字符串常量，随包发布 |
| `recorder.ts` | 接收 binding 消息、校验、归一化成步骤、超纲标记 |
| `resolve.ts` | 纯函数：`StepTarget` × `Observation` → 唯一 ref 或失败原因 |
| `player.ts` | 回放状态机：前置条件、逐步执行、交还、游标 |
| `distill.ts` | 提炼 prompt 构造与四条对账校验 |
| `library.ts` | 目录枚举、读写、slug、删除、重命名 |

`resolve.ts` 是健壮性的全部所在，按序降级，每级要求唯一命中，命中后交叉校验 `role` + `tagName`：

1. `fingerprint` 精确
2. `role` + `name` + `tagName`（+ `inputType`）精确
3. 同上，`name` 归一化（trim、空白折叠、大小写无关）
4. `role` + `name` + `tagName` 相同但候选不唯一时，在该候选集内按文档顺序取第 `nth` 个
5. `select` 追加一层：`optionValues` 与新鲜值的交集

全部不中就交还。

## 采集

### 脚本生命周期

当前文档用 `Page.createIsolatedWorld` 取隔离世界 contextId，把固定源码送进去；后续文档用 `Page.addScriptToEvaluateOnNewDocument`（`worldName: 'pilion-recorder'`）。这样按下录制立刻生效，不必刷新页面丢掉已填的表单。回传走 `Runtime.addBinding`，binding 名每次录制随机。

固定命令集新增、且只在录制期间开启：`Page.enable`、`Runtime.enable`、`Page.createIsolatedWorld`、`Page.addScriptToEvaluateOnNewDocument`、`Runtime.addBinding`，加对应移除命令与 `Runtime.bindingCalled` 事件。停止录制、切标签、页面崩溃、退出应用都要拆干净。

### 必须挡住的坑

`Input.dispatchMouseEvent` 派发的事件 `isTrusted` **也是 true**。Agent 自己的点击、以及回放时 player 的点击都会被录进去。录制、Agent 任务、回放三者互斥，界面禁用之外主进程也要拒绝。

### 脚本的职责

只做三件事：`isTrusted` 过滤、密码判断、算元素的可移植描述。永不 `preventDefault`，永不等主进程。捕获阶段、passive。

- `pointerdown` → 候选点击目标（在默认动作之前，页面随后可能跳走）
- `input` / `change` → 字段值变化，不逐键上报
- `blur` 或字段切换 → 提交 `type`，带最终值
- `keydown` → 只上报 `PRESS_KEYS` 白名单内的，其余已体现在字段最终值里
- `change` on `select` → `select`；on checkbox / radio → `check`

**密码是唯一必须留在脚本里的判断**：`input.type === 'password'` 或 `autocomplete` 含 `one-time-code` → 只发 `{ kind: 'human', reason: '填写密码' }`，值与长度都不发。其余敏感字段靠人在审阅时自己插「需要我」。

### 归一化（`recorder.ts`，vitest 可测，不需要浏览器）

- 同字段连续 `input` 合并成一条 `type`，只留最终值。中文输入法因此自动正确，composition 中间态不产生步骤
- `pointerdown` + 随后的导航 → 合成 `click`，导航后的 URL 成为下一段的 `onUrl`
- 双击噪音折叠
- 页面加载完成 → 记页面条目：URL、标题、`readText()` 摘录
- 每个文档在 `document-committed` 时预取一次 `observe()`；首个动作若赶在预取之前则懒取一次。epoch 已变则退回脚本自带描述，两条路产出同一个 `StepTarget` 形状

### 超纲当场标记

iframe 内、不在 `SELECTOR` 范围内、拖拽 / 右键 / hover 菜单、预取 observe 里同描述不唯一、超出 200 截断，分别给出原因。界面显红并提示「这一步回放不了，提炼时会变成需要我」。

### 旁白

录制中工具栏一个输入框，敲一句进轨迹（`{ kind: 'note', text }`）。不参与回放，只喂提炼 —— 提炼质量几乎全靠文本这一轨。

### 只有人能录

- **MCP 里不存在录制动词**。只有 `browser.skills.list` 与 `browser.skills.play`。这是首要防线：不是加检查，是不给这个能力
- 启动只能来自可信 Renderer 的 IPC，沿用审批那套 sender / frame / origin 校验，不是只看 channel。网页是独立 WebContentsView、无 preload，本来发不出 IPC
- `executeTool` 顶部加一条：录制期间所有浏览器工具直接拒绝，理由「用户正在录制」。挡得住 goal 型 Agent 迟到的异步调用，且不必改动 attachment 状态
- 反方向：录制中发任务 → 拒绝并在输入框正上方说明原因，不自动停止录制
- 录制的开始、停止、技能保存记进 Host 的 `events` 表

### 录制中的状态

- `AppState` 加 `recording?: { active, steps, unsupported, tabId }`。界面只渲染主进程快照，不本地推断
- 工具栏：红点 + 「录制中 · 7 步」+ 停止。计数实时走，这是它真的在记的唯一证据；`unsupported > 0` 时旁边挂黄色角标
- 网页区域四周 2px 红框，画在可信 Renderer 里（复用它已通过 ResizeObserver 管着的 viewport 矩形），不进页面 —— 不会出现在截图里，页面也伪造不了一个假的在别处
- 与回放必须长得不一样：录制是红框加红点、不挡输入；回放是现有半透明蒙层加底部「正在回放 3/5」、挡输入
- 仍在录制时关窗口或退应用 → 先停止并存轨迹，不静默丢

## 提炼

在一个专属会话「提炼：<技能名>」里跑，聊天记录照实可查，不塞进正在做的任务。要求已连接 Agent 且没有活跃任务，沿用「不与活跃任务交错」。

**那一轮不给浏览器工具** —— 提炼只需读文本。Agent 若在这轮调用浏览器工具则拒绝并说明原因。

Pilion 发出的 prompt 含轨迹原文与固定说明：输出一个 md，含四个散文段与一个 ```json pilion-skill 块；只能从轨迹里的动作挑选、合并、重排，可插「需要我」，不得新增动作；散文不得复述步骤。

响应里取 fenced block → `JSON.parse` → zod → 逐步对账：

| 检查 | 规则 |
| --- | --- |
| 动作有依据 | 每个动作步骤必须在轨迹里存在同类型 + 同目标名的一条，**消耗式匹配**，一条轨迹步骤不能被复用成三步 |
| 值未被改写 | `text` / `value` 必须与轨迹一致，或被替换成占位符。不许改写人输入过的内容 |
| URL 未被编造 | `navigate` 的目标必须在轨迹里出现过 |
| 例外 | 只有 `human` 与 `note` 可自由插入 |

任一条不过则不保存，界面指出「第 N 步在轨迹里找不到依据」，给重炼。通过也不自动保存，等人按保留。

这条不变量的意义：否则提炼就成了「Agent 可以写出一串你没做过的操作，然后请你批准」，而人批准时只会扫一眼。

## 回放

每步：断言 `onUrl`（比 origin + path，不比 query）→ `executeTool('browser.observe')` → `resolve()` → `executeTool(step.kind)`。

- `human` 步 → 现有 `pauseForHuman()`，任务转人工并显示 reason；游标存在 task 上（`task.replay = { skillId, nextStep }`），人点「继续任务」时从 N+1 续
- 匹配失败或前置条件不符 → 停下交还 Agent：

```json
{ "ok": false, "failedAt": 3, "reason": "NO_MATCH",
  "step": "点击 \"登录\"（button）",
  "url": "https://report.example.com/login", "title": "登录",
  "remaining": ["选择 \"月份\" = 2026-09", "点击 \"导出 CSV\""] }
```

Agent 用现有 `observe` / `click` 只修这一步，再 `play(skillId, fromStep: 4)` 续播。

- 单步沿用现有 `timeoutMs`；整场回放一个总预算 4 分钟，留在 10 分钟 prompt 上限内
- 停止与接管复用已有取消链路（`AbortSignal` + `promptCancelled`），并清游标
- `navigate` 步骤照旧过 URL 策略，技能不能夹带私网地址

### 授权与审计

- Agent 首次 `play` 某技能需一次审批，详情列出全部步骤，`actionDigest` 覆盖 skillId 与步骤内容哈希；批准后同任务内不再问
- **`full` 模式也问**。这是对「full 省略交互审批」的有意例外：一份技能是一捆预授权副作用
- 技能内容改过（哈希变了）重新要审批
- 回放每一步照旧 `createIntent`，带 skillId、步骤序号与那次覆盖审批的 `approvalId`。台账里读得出「回放月度导出第 3 步，依据审批 X」

### 人工回放与本地 principal

技能库里的播放按钮不需要连 Agent —— 录完、提炼完得能自己先跑一遍看对不对。但 `runTool` 第一行是 `requireAttachment()`，整条 Intent 与执行凭证路径都挂在 `sessionId` / `attachmentId` / `connectionEpoch` 上。

因此给 Host 开一个本地 principal：自己的 session、attachment 与 epoch，审计里记成「人工回放」。这是本特性最大的一块新增工作量。

不接受的替代方案是「v1 要求已连接 Agent、复用当前 attachment」：那会把人的操作记在 Agent 名下，在那套 12 张表的台账里撒这个谎，代价比省下的工作量大。

人工回放不需要审批（人自己按的播放），但仍然升起蒙层 —— 页面上正在发生自动输入，人不该与它抢。

## MCP 契约

`main/agents/browser-mcp-server.ts` 新增两个工具，`ToolNameSchema` 同步加两项，Host 策略里 `list` 归 observe 类、`play` 归 effect 类。

- `browser.skills.list` → `[{ id, name, about, steps, needsHuman, recordedAt }]`，不含步骤明细
- `browser.skills.play { skillId, fromStep? }` → 成功 `{ ok: true, steps, finalUrl }`；失败如上

工具描述写成指令，因为它是唯一能引导任意 ACP Agent 的东西：「有匹配的技能时优先用它，不要自己摸索；`ok:false` 时读 `failedAt` 那步，只修那步，再用 `fromStep = failedAt + 1` 续播」。

## 界面

`renderer/main.tsx` 的 `Surface` 联合类型加 `'skills'`，左栏入口挨着历史与下载。选中时 WebContentsView 按既有机制隐藏，编辑步骤因此有整块空间。

列表：名字、一句说明、步数、需人工数、上次运行、状态（已提炼 / 仅轨迹）。

详情：技能与轨迹两个标签。轨迹只读 —— 它存在的意义就是让人核对提炼有没有骗自己。散文段用已有的 react-markdown 渲染；步骤从 json 渲染成行。

**修改分权**：散文段自由改（textarea 加预览）；步骤只给结构化操作 —— 删除、上下移、改输入值、插「需要我」，**没有新建步骤**。能凭空造步骤的编辑器等于给了一条「写出你从没做过的操作再请你批准」的路。

人直接用编辑器改 md 仍然允许，无轨迹支撑的步骤在界面上标「手工添加」而不是被拒绝：威胁模型是「Agent 编步骤加人随手批准」，不是人改自己的文件。这个目录只有 Pilion 与人写得进去，Agent 只能通过 MCP 读与播。

动作按钮：提炼 / 重炼、播放、改名、删除、在 Finder 中显示。点播放 → 关掉覆盖层回到网页 → 蒙层升起 → 底部「正在回放 3/5」加停止与接管。

## 安全与数据边界

- 手改过的 md 对 player 是不可信输入，与网页正文同级：语法校验、值长度上限、URL 仍过现有 URL 策略、按键仍限 `PRESS_KEYS`
- 技能与轨迹以 `0o600` 明文存放。**按构造不含密码与一次性验证码**，但含人输入过的其它内容（邮箱、搜索词），文档需说明
- 录制脚本是 Pilion 自己的固定源码，随包发布，不接受任何调用方或 Agent 提供的脚本。这条不变量不变
- 隔离世界令页面 JS 看不到也改不了录制脚本；`isTrusted` 过滤令页面伪造不出人类动作
- 技能格式不含任何只有 Pilion 认得的句柄，可被 orca、blade 或 Playwright 直接读取

## 测试计划

单元：

- `resolve` 五级降级与失败：改名、换序、同名重复、`select` 选项变更、目标消失
- `recorder` 归一化：按键合并、中文输入法、双击折叠、超纲标记、密码只产出 `human`
- `distill` 四条对账各一个必须被拒的用例：凭空造步骤、复用一条轨迹步骤、改写输入值、伪造 `navigate` URL
- `format` 往返一致；坏文件精确报行；`skills.play` 参数校验

集成：回放打在 fixture page 上，走真实 `BrowserService` 加假 page port，照 `tests/browser-service.test.ts`。

Electron E2E：

- 录 4 步 → 提炼（确定性 ACP fixture 返回固定 skill）→ 保留 → 回放 → 断言最终 DOM
- 按钮改名 → 断言交还 payload 到达工具结果，且 `failedAt` 正确
- 回放中途停止 → 断言游标清理与蒙层移除
- 录制期间 Agent 调用浏览器工具 → 断言被拒绝
- 录制期间发任务 → 断言被拒绝且原因显示在输入框上方

## 实现前需验证

每项都带兜底，不阻塞设计：

1. `Page.createIsolatedWorld` 与 `Runtime.addBinding`（`executionContextName`）在 Electron 44 的组合行为。若绑不上指定 context，改为不限定 context 的 binding，并在脚本里带每次随机的 token 做来源校验 —— 页面在主世界看不到隔离世界的变量，拿不到 token
2. 每文档预取 `observe()` 的延迟（最多 200 元素乘每元素三次 CDP 往返）。若过慢，预取降为首个动作时懒取；本特性的兜底始终是脚本自带描述。合并 `observeElements` 的 per-element 往返是独立优化，不属于本特性
3. 本地 principal 对 Host 状态机 `assertTransition` 的影响。若状态机要求 attachment 必须绑 ACP 连接，则人工回放使用一个长期存在的 local session 并单独记 events 行，不复用 attachment 状态机
4. `resolve` 层级在真实站点的命中率，需手测 3 至 5 个站点。层级顺序可调，格式不变

## 对现有文档的改动

`docs/architecture.md`：

- 新增「录制与技能」一节
- 「当前边界」里「网页没有 preload 和 Node 权限」改成带前提的版本 —— 录制期间隔离世界里跑着 Pilion 自己的固定脚本，这个不能含糊
- 模块表加 `main/recording`，MCP 工具清单加两项
