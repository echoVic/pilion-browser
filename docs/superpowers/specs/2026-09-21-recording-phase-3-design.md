# 录制与技能 第三期：过程即产物

## 目标

把录制的产物从「结论」改回「过程」。按下录制之后发生的一切都进一份只增不改的事件日志，日志是唯一真相；现在那份带编号步骤的轨迹降级为从日志算出来的投影，供回放使用。提炼时 Agent 读到的是过程，而不只是被归一化剩下的骨架。

## 为什么

现在脚本发出的原始事件进了 `TrajectoryRecorder` 就地归一化成带类型的步骤，原始流不落盘。落盘的是去重、合并、标好歧义的成品。丢掉的东西是具体的：

- 指针与点击合成一次点击，一连串输入合成一条「最终值」，打字过程没有了
- iframe、拖拽、右键只剩一个「需要我」标记，实际做了什么不可知
- 滚动、悬停、前进后退刷新、`contenteditable` 输入、停顿时长没有对应的步骤类型，直接消失

第一期待办里记着的三个「录制保真缺口」（iframe 内的输入仍被录下、前进后退刷新不产生步骤、富文本输入录不到）是同一个病的三个症状：归一化做得太早。日志化之后，这三个都变成日志里有记录、投影里有交代的东西，而不是静默丢失。

## 非目标

- 不把对账改成对日志：对账继续校验「技能里的每一步都能在投影里找到同目标的依据」。日志只作为提炼时的上下文。这是第二期的安全属性，本期一行不动。
- 不做录制中断恢复：日志在内存里攒着，停止录制时一次落盘。崩溃仍然丢失整次录制，与现在一致。
- 不让回放支持滚动、悬停、富文本输入：这些进日志、进投影时变成「需要我」，但 player 不新增动作类型。
- 不做变量展开、技能导入导出、技能互相引用、多标签编排、定时触发，沿用前两期的非目标。
- 不支持手工编辑 `trajectory.md` 的步骤块（见「一致性」）。

## 产物形状

一份录制仍是一个目录，多一个文件：

| 文件            | 角色                            | 谁写                            |
| --------------- | ------------------------------- | ------------------------------- |
| `events.jsonl`  | 过程日志，只增不改，唯一真相    | 只有 Pilion，停止录制时一次写入 |
| `trajectory.md` | 由日志算出的投影 + 人读的时间线 | Pilion，随日志重算              |
| `skill.md`      | 提炼产物                        | Agent 提炼、人编辑              |

`events.jsonl` 一行一个 JSON 对象，字段：

```
{ "seq": 1, "at": "2026-09-21T12:00:00.000Z", "kind": "click", "url": "https://…", … }
```

`seq` 从 1 连续递增，`at` 是 ISO 时间戳。`kind` 的全集与各自的附加字段：

| kind          | 附加字段                                                 | 来源                        | 进投影                                   |
| ------------- | -------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| `page`        | `title`, `text`（摘要，上限 2000 字）                    | 主进程，文档提交            | 是，`page` 条目                          |
| `navigate`    | `cause`: `address` \| `back` \| `forward` \| `reload`    | 主进程                      | 是，`navigate` 步骤                      |
| `note`        | `text`                                                   | 人在录制条里写的旁白        | 是，`note` 步骤                          |
| `pointer`     | `index`, `el`, `target?`, `ambiguous?`                   | 页面脚本                    | 是，配合 `click`                         |
| `click`       | 同上                                                     | 页面脚本                    | 是                                       |
| `input`       | 同上 + `value`                                           | 页面脚本                    | 是，合并为 `type`                        |
| `select`      | 同上 + `value`                                           | 页面脚本                    | 是                                       |
| `check`       | 同上 + `checked`                                         | 页面脚本                    | 是                                       |
| `key`         | 同上 + `key`, `shift`                                    | 页面脚本                    | 是，`press` 步骤                         |
| `secret`      | `index`, `el`, `otp`（**从不带值**）                     | 页面脚本                    | 是，`human` 步骤                         |
| `edit`        | `index`, `el`, `length`（字符数，不带内容）              | 页面脚本，`contenteditable` | 是，`human` + `unsupported: 'rich-text'` |
| `scroll`      | `x`, `y`                                                 | 页面脚本，节流              | 否，仅上下文                             |
| `unsupported` | `reason`: `iframe` \| `out-of-scope` \| `gesture`, `el?` | 页面脚本                    | 是，`human` 步骤                         |

`el` 是脚本算出的元素描述（沿用现有 `ElementDescriptionSchema`）。`target` 是采集时解析出的 `StepTarget`：先取实时 observe 里那一行，对不上就退回 `el`。两条路都有结果，所以 `target` 与 `ambiguous` 在元素类事件上是必填的，投影层因此一个回退分支都不需要。**把解析结果写进日志，是为了让投影成为纯函数**：重算投影不必重新观察页面。

> 2026-09-23 录制待办 Task 3 修订：名字可能取自人打的字或密码框的值的元素（自己身处编辑区——含沿扁平树跨过开放影子根与插槽、以及 `designMode`；子树里有编辑宿主或密码、一次性验证码框，开放影子根里的也算；或 `aria-labelledby` / `aria-owns` / `label` 指向这样的元素，`aria-labelledby` 连自己也算进去的密码、验证码框也算），脚本跳过这些算名字，其中身处编辑区的元素、以及角色在 WAI-ARIA 1.2 里不从内容取名的元素（表单、对话框、应用等）不从内容取名，并在 `el` 上标 `editable: true`；其余元素的 `el` 与以前逐字节相同。对带标记的元素，`target` 只有在 observe 那一行对得上、名字与脚本的干净名规范化后相等，且名字不空时脚本数出的同名个数等于 observe 里同角色、同标签、同名的行数，才照用那一行；否则扣下名字，只取 `el` 的描述——`name` 为空串、带 `editable: true`、不带 `nth`、也不带指纹。这样的目标回放时既不按名字也不按指纹匹配：名字扣下后，指纹证明不了 observe 那一行就是它。回放停在这一步并报告，由 Agent 发起的回放把这一步交还给 Agent。名字为空的元素照旧是以前的做法：observe 过期时，序号上同标签、同角色、名字也为空的那一行就算对上。已知没有盖住的形状：封闭影子根；只靠 CSS `-webkit-user-modify` 可编辑的区域；不在元素自己身上、而在子树里的元素、标签来源或被拥有的元素上的 `aria-owns`。

时钟同理归采集层：`at` 是主进程打的 ISO 字符串，投影原样抄进条目；元素事件另带 `pageAt`（页面时钟的毫秒数），双击折叠比的是它。投影里不得读当前时间。

## 两层拆开

现在 `TrajectoryRecorder`（381 行）同时做两件事：拿实时 observe 匹配元素，和把事件流归一化成步骤。第三期按这条缝把它拆成两个模块，拆分属于引入日志的那个任务，不单列清理任务。

- `capture.ts`：有副作用。收脚本事件与主进程事件，用当前 observe 结果解析目标，产出 `LoggedEvent`，维护上限与 `capped` 标记。`sameElement`、`fromDescription`、`toStepTarget` 的调用都在这里。
- `project.ts`：纯逻辑，没有副作用。现有的状态机原样搬过来：双击去重、挂起输入的提交时机、mousedown 后跳页补点击、超出 observe 上限降级、密码与验证码变「需要我」。不碰 Electron，不碰 observe。

投影规则相对现在只有两处新增：

1. `navigate` 的 `cause` 是 `back` / `forward` / `reload` 时，照样产出一条 `navigate` 步骤，URL 取落地后的地址。回放语义正确（player 的 navigate 本来就是「打开这个地址」），这条关掉了第一期「前进后退刷新不产生步骤」的缺口。
2. `edit` 产出 `human` 步骤，`reason` 为「手动填写富文本内容」，带 `unsupported: 'rich-text'`。静默丢失变成可见的交还。

`UNSUPPORTED_REASONS` 增加 `'rich-text'` 一项。

### 前进后退刷新从哪来

> 2026-09-23 录制待办 Task 1 修订：下面这节原先的机制（挂起原因、由下一个 `page` 无条件消费）在导航被取消或失败时会把原因张冠李戴到下一次不相关的换页上，一份终审实测里还因此吞掉了一次真实点击。现在的机制改为原因绑定预期落地地址，取代原描述。

今天 `IPC.tabNavigate` 的处理函数在录制标签上会调 `recorder.navigate(result.url)`，这是 `cause: 'address'`。而 `IPC.tabBack` / `IPC.tabForward` / `IPC.tabReload` 三个处理函数完全没碰录制器 —— 这就是缺口。录制期间这三个按钮是可用的（工具栏只在 Agent 操作与回放时禁用），所以人按了就真的丢了。

三个处理函数在调用导航之前，先从 `webContents.navigationHistory` 算出这次导航预期落地的地址（后退取 `getEntryAtIndex(getActiveIndex() - 1)`，前进取 `+ 1`，刷新取 `getURL()`），算不出来就不挂原因；算得出就把原因连同这个地址一起交给会话层：`session.pendingCause(tabId, cause, expectedUrl)`。会话层是这份状态唯一的主人——采集层不再自己留一份，两处不会再各说各话；`capture.page(entry, cause?)` 只在调用方明确给了原因时才先写一条 `navigate`。

落地地址是异步才知道的，所以不在这里写日志，而是由**下一个 `page` 事件**判定这次导航到底有没有真的发生、真的落在预期的地方。会话层记着三件事：挂起的原因、预期落地的地址、挂起之后是否真的有文档开始加载过（主进程在文档开始加载时已经会调的 `dropObservation` 顺带打上这个 `loadStarted` 标记）。`pageLoaded` 按顺序判断：

1. 这条的地址等于预期地址，并且（地址跟当前页不一样，或者确实加载过）：这就是那次导航的落地。消费原因，这一条不参与同页去重，把原因传进排队的页面记录，由采集层在 `page` 之前补一条 `{ kind: 'navigate', cause, url }`。
2. 地址跟当前页一样，且没有加载过：只是当前页的一次普通同步（标题变化、缩放、加载状态抖动），不是导航落地。照常去重，原因继续挂着，等真正的下一次换页。
3. 其它情况——落到了预期之外的地方（重定向），或者根本没发生、人已经去了别的页面：丢弃原因，这一条按没有原因时的规则去重与记录。

地址栏导航（`cause: 'address'`）会清掉挂起的原因，不能让它安到地址栏这次导航头上。这套判定专门堵住两个口子：导航被取消或失败之后贴到下一次不相关的换页头上（多出一条来源标错的 `navigate`，如果那一页是按下鼠标就跳转的，还会连带把那次点击吞掉），以及刷新被拦下之后同页的任何一次抖动都被当成落地、凭空多出一条刷新步骤。

## 页面脚本

`buildRecorderScript` 增加三处，其余（`isTrusted` 过滤、密码与验证码不带值、`detail === 0` 的补发点击不算点击）一字不动：

- `scroll`：监听 `scroll`，每 400 毫秒最多发一条，只带 `x` / `y`。
- `edit`：`input` 事件里，**在 `scoped()` 的提前返回之前**判断 `event.target.isContentEditable`，成立就发 `edit`，只带 `textContent.length`，**不带内容**。
  这条顺序是必须的：`OBSERVE_SELECTOR` 是 `a,button,input,textarea,select,[role]`，一个没写 `role` 的 `<div contenteditable>` 根本不在里面，`scoped()` 返回 null 就直接 return 了，这正是今天它被静默丢掉的原因。
  这类元素的 `index` 取 `indexOf()` 的结果（不在选择器里就是 -1），投影只把它变成「需要我」，不依赖这个序号。写了 `role="textbox"` 的富文本框本来就在选择器里，走同一条分支，不再落进 `input`。
- iframe 收口：现在只有 `pointerdown` / `click` 走 `inFrame` 判断，`input` / `change` / `keydown` 没有。三个监听都加上同一条判断，在 iframe 里改为发一条 `unsupported: 'iframe'`。这关掉第一期「iframe 里的输入仍被录下」的缺口。

## 一致性：日志赢

`trajectory.md` 的 json 块 `meta.version` 升到 `2`，并增加：

```
"source": { "events": <条数>, "hash": "<events.jsonl 全文的 sha256>" }
```

读取时若同目录存在 `events.jsonl` 且其哈希与 `source.hash` 不符，重算投影并改写 `trajectory.md`，列表上对这一份显示一次「步骤已按过程记录重算，手工改动未保留」。**日志赢，轨迹的步骤块不是可手工编辑的东西**；要改步骤请提炼成技能后在技能库里改，第二期已有分权与服务端校验。这是明确定下的产品规则：**轨迹不能改，只有技能可以改**。0.1.3 的更新日志写过「文件是普通 Markdown，可以直接改」，`[未发布]` 段落要补一句把这句话的范围收到技能文件，界面上轨迹视图也要说明它是算出来的。`serializeTrajectory` 顶部那句说明同步改写，文件自己要讲清楚这件事。

`version: 1` 的旧录制照常工作：没有 `events.jsonl`，投影就是 md 里已有的 `entries`，不重算，提炼退化成现在的行为。不做批量迁移。

## 提炼读得到过程

`buildDistillPrompt` 的固定说明与步骤规则一字不改，额外附一段渲染过的过程时间线，放在轨迹原文之后，并加一句：

> 过程记录是给你判断「什么时候用」「前置条件」「已知坑」和哪些步骤是误操作用的上下文。步骤仍然只能从 pilion-trajectory 代码块里挑选、合并、重排。

渲染由新函数 `renderEvents(events, limit)` 负责，规则：

- 连续滚动折叠成一行「滚动了 N 次」
- 同一字段的连续 `input` 折叠成最终值一行，注明「改了 N 次」
- 相邻事件间隔超过三秒时插一行「停顿 N 秒」
- 总行数上限 300，超出时保留首尾各 150 行，中间折叠成一行「省略 N 条」

这样对账的输入没有变化（仍是投影），第二期「Agent 不能凭空造步骤」的证明链条原样成立。

## 界面

技能库详情增加「过程」视图，与现有的「步骤」「原始轨迹」并列，只读，由日志渲染，同样受 300 行上限约束。录制条不变。加这个视图时把 `SkillLibrary.tsx`（547 行）里的编辑器拆成独立组件，拆分属于这个任务。

## 接口

新增与改动的公开面，计划按此展开：

- `src/main/recording/types.ts`：`LoggedEventSchema`（上表的判别联合）、`LoggedEvent`；`UNSUPPORTED_REASONS` 增加 `'rich-text'`；`TrajectorySchema.meta` 增加 `version: 2` 与可选的 `source: { events: number; hash: string }`，`version: 1` 仍可读。
- `src/main/recording/capture.ts`（新，从 `recorder.ts` 拆出）：`class RecordingCapture`，方法 `page()` / `navigate(url)` / `pendingCause(cause)` / `note(text)` / `raw(event, observed?)`，属性 `capped`、`counts`，产出 `finish(): LoggedEvent[]`。目标解析（`sameElement`、`fromDescription`、`toStepTarget`）留在这里。
- `src/main/recording/project.ts`（新，从 `recorder.ts` 拆出）：`class Projector`，方法 `push(event)`，属性 `entries` / `counts` / `capped`；外加便捷函数 `project(events) = events.reduce(…)`。做成增量式是因为录制条要实时显示步数：采集层自己持有一个 `Projector` 喂事件，取数是 O(1)，不必每来一个事件就把整份日志重算一遍。两条路径同一套状态机，同一份日志算两次结果必须相同（单测钉死）。不引入 Electron 与 observe。
- `src/main/recording/recorder.ts`：删除。`RawEventSchema` / `RawEvent` / `ElementDescriptionSchema` 移到 `types.ts`（`recording-channel.ts` 与 main.ts 都在用），其余逻辑按上面两条分流。
- `src/main/recording/library.ts`：`eventsPath(id)`、`readEvents(id): Promise<LoggedEvent[] | undefined>`；`create(name, trajectory, events)` 与 `write(id, trajectory, events?)` 在同一次写队列调用里落两个文件，先写日志再写轨迹，两个都走临时文件加 rename 与 0o600；`read(id)` 在哈希不符时重算投影、改写 `trajectory.md`，返回值带 `recomputed: true`。
- `src/main/recording/distill.ts`：`renderEvents(events: readonly LoggedEvent[], limit?: number): string`；`buildDistillPrompt` 多一个可选参数接收它的输出。
- `src/shared/contracts.ts`：`RecordingSummary` 增加 `hasEvents: boolean`（决定详情页显不显示「过程」视图）；IPC 频道 `recordingsEvents`，入参 `{ id }`，返回 `{ lines: string[]; capped: boolean }`（渲染在主进程做，渲染器只显示，避免把两万条事件送过桥）。
- 两份 preload 同步增加对应方法，E2E 边界用例的方法名清单同步更新（这是第一期踩过的坑）。

## main.ts 的两块也要搬

`src/main/main.ts` 现在 3362 行，其中录制采集的编排（起停、事件入队、`finished` 标志、观察预取、与标签生命周期的耦合）和提炼生命周期（`startDistillation` / `acceptDistillation` / `keepDistilled` / `discardDistilled` 与它们的模块级状态）是两块自洽的东西。本期这两块都要动：采集那块改成写日志，提炼那块改成多送一段过程。**按「在开发中重构」的原则，搬迁属于这两个任务本身，不单列清理任务。**

- 录制采集编排搬到 `src/main/recording/session.ts`，对外暴露 `createRecordingSession(deps)`，`deps` 显式声明它需要的东西（页面注册表、observe、`emit`、库、时钟），不再隐式吃 main.ts 的闭包。
- 提炼生命周期搬到 `src/main/recording/distillation.ts`，同样用显式依赖，把 `distilling` / `distillStarting` / `pendingSkill` / `distillationRejected` 收进一个对象，消灭四个模块级变量。

搬迁的验收标准只有一条：`main.ts` 里只剩下把 IPC 与这两个模块接起来的代码，两块的状态不再有模块级变量。具体依赖清单在写计划时逐项落实，不在本规格里展开。

## 上限与隐私

- 日志上限 20000 条或 8 MB，先到者为准；到顶停止记录并标记 `capped`，停止录制照样存得下。
- 投影仍受现有 2000 条上限约束。日志没到顶而投影到顶时，日志是完整的、投影是截断的，轨迹按现在的方式标记 `capped`，界面照旧提示。两个上限各管各的，不联动。
- 滚动事件每文档节流到 400 毫秒一条。
- 密码与一次性验证码的过滤在页面脚本源头，日志里 `secret` 不带值也不带长度；`edit` 只记字符数不记内容。日志不是键盘记录器：`input` 记的是字段当时的值，与现在一致。
- 目录 0700、文件 0600 不变。`docs/architecture.md` 四处同步：模块表里 `main/recording` 那一行（第 41 行附近）、「录制与技能」里描述轨迹文件敏感度的那段（第 111 行附近，补 `events.jsonl` 存什么、同样 0600、同样含键入文本）、说「归一化全部在 `recording/recorder.ts` 完成」的那句（第 113 行附近，改成采集与投影两层）、以及测试覆盖那段（第 137 行附近）。

## 测试

- `project.ts` 的纯函数性质用表驱动单测钉死：同一份日志跑两次结果相同，且增量喂入与一次性 `project()` 的结果逐条相等；现有 `recorder.ts` 的全部用例平移过来，断言不变。
- 新投影规则各一条：back/forward/reload 产出 navigate 步骤（含 `pendingCause` 被下一个 `page` 消费、导航失败时被丢弃两条）；`edit` 产出带 `rich-text` 的 human 步骤。
- 一致性：日志被改动后读取会重算并给出提示；v1 录制没有日志时不重算。
- 上限：日志到顶后停止追加且 `capped` 为真，停止录制仍能写出完整的两个文件。
- `renderEvents` 的四条折叠规则各一条，含 300 行截断。
- 脚本层（`tests/recording-script.test.ts` 的现有 harness）：滚动节流在 400 毫秒内只发一条；`contenteditable` 发 `edit` 且载荷里没有文本内容；`top !== window` 时输入与按键发 `unsupported: 'iframe'` 而不是 `input` / `key`。
- E2E：录一段包含滚动、后退、富文本输入的操作，停止后目录里有 `events.jsonl`，技能库「过程」视图能看到滚动与停顿，步骤视图里后退是一条 navigate、富文本是一条「需要我」。

## 迁移与发布

本期不改任何已发布的文件格式的读法，只增加一个文件和一个版本号。`[未发布]` 段落新增一条中文条目说明「录制现在记录完整过程」。
