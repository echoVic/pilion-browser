# 录制待办六条 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关掉第三期终审留下的六条待办：取消的导航留下错标、超长地址让整页事件丢失、点击路径带出富文本正文、重算提示会被后续刷新吃掉、日志读不出时显示为空、临时文件残留。

**Architecture:** 六条都是对第三期已有代码的修补，不引入新模块。每个任务按行为给出要求、设计决定与验收用例，实现者据此写代码；设计决定是约束，不是建议。

**Tech Stack:** TypeScript 5.9 / Electron 44 / React 19 / zod 4 / vitest 5 / Playwright（Electron E2E）

**Spec:** `docs/superpowers/specs/2026-09-21-recording-phase-3-design.md`（第三期）；本计划的设计决定写在各任务里，与规格冲突时以本计划为准，并在任务内同步改规格。

## Global Constraints

- **不新增运行时依赖。** 运行时只允许 `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod` 三个
- **`src/` 内部 import 必须带 `.js` 扩展名**；`tests/` 内 import 不带扩展名
- **界面文案、错误消息、代码注释用中文**；commit message 英文 conventional commits
- **两个 preload 都要改**：`src/preload/index.ts` 只供类型，`src/preload/entry.cts` 才是 Electron 加载的；`tests/contracts.test.ts` 的 preload parity 用例与 `tests/electron.e2e.ts` 钉着的方法名清单必须同步
- **投影层（`project.ts`）不许有时钟、不许有 I/O**
- **对账函数（`reconcile` 及其辅助）逻辑不改**；它对整个目标取哈希，目标多一个字段是允许的
- **密码与一次性验证码的值与长度永不离开页面**
- **永远不要在工作区里用 `git stash`**：stash 栈与主检出、其他会话共享。要暂存就做临时提交
- **每个新测试都要做一次变异验证**：删掉它要钉住的那一行，确认它变红，再恢复。报告里写明结果。这一条在第三期抓出过三条不可能失败的测试
- 命令：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm test:e2e`；单文件 `pnpm vitest run tests/<file>.test.ts`
- 基线：`main` @ `e61adcb`，单测 28 文件 / 380 用例全绿。`format:check` 只会列出被 git 忽略的 `.superpowers/` 下的文件，被跟踪的文件必须全部通过

---

### Task 1: 导航原因绑定预期的落地地址

**问题。** 人按后退、前进或刷新时，主进程先挂起一个原因，由下一条页面条目消费。导航没真正发生时（页面拦下了离开、导航失败），原因不会被清掉，会贴到下一次换页上：多出一条来源标错的导航步骤；如果那一页是按下鼠标就跳转的，投影在处理导航时会先清掉挂起的按下，人真点的那一下就从录制里消失了。此外，刷新被拦下后，同一页面的任何一次同步（标题变化、缩放、加载状态抖动）都会把挂着的刷新原因消费掉，凭空多出一条刷新步骤。

**Files:**

- Modify: `src/main/main.ts`（三个导航处理函数，约 2900-2925 行，动手前 `grep -n` 复核）
- Modify: `src/main/recording/session.ts`、`src/main/recording/capture.ts`
- Test: `tests/recording-session.test.ts`、`tests/recording-capture.test.ts`、`tests/integration-security.test.ts`
- Docs: `docs/superpowers/specs/2026-09-21-recording-phase-3-design.md`「前进后退刷新从哪来」一节、`CHANGELOG.md` 的 `[未发布]`

**设计决定：**

1. **原因只有一个主人：会话层。** 删掉采集层的 `pendingCause()` 与 `#pendingCause`；`capture.page(entry, cause?)` 只在调用方给了原因时先写一条 `navigate`。采集层的 `navigate()` 不再需要清原因。两份状态各说各话的风险随之消失。
2. **原因绑定预期落地地址。** 主进程在调用导航之前算出预期地址：后退取 `navigationHistory.getEntryAtIndex(getActiveIndex() - 1).url`，前进取 `+ 1`，刷新取 `webContents.getURL()`。取不到就不挂原因。会话层签名变为 `pendingCause(tabId, cause, expectedUrl)`。
3. **会话层记录「挂起之后是否真的开始加载过」。** 主进程在文档开始加载时已经会调 `dropObservation(tabId)`，让它顺带把挂起原因标记为 `loadStarted`。
4. **`pageLoaded(entry)` 的规则**，有挂起原因时按顺序判断：
   - `entry.url === expectedUrl`，并且（`entry.url !== lastPageUrl` 或者 `loadStarted`）：这是那次导航的落地。消费原因，这一条不去重，把原因传进排队的页面记录，由采集层写出 `navigate` 再写 `page`。
   - `entry.url === lastPageUrl` 且没有 `loadStarted`：这是当前页的一次普通同步，不是导航落地。照常去重，原因继续挂着。
   - 其它情况：导航落到了别处，或者根本没发生而人去了别的页面。丢弃原因，这一条按正常规则去重与记录。
5. 地址栏导航（会话层 `navigate`）照旧清掉挂起的原因。
6. 主进程三个处理函数保留现有的 `canGoBack()` / `canGoForward()` 守卫。`tests/integration-security.test.ts` 里钉着「守卫在挂原因之前」的静态断言按新的调用形状更新，意图不变，并重做一次变异验证。

**验收用例**（`tests/recording-session.test.ts`，假依赖；每条都要做变异验证）：

- 真刷新：`pendingCause(reload, A)` → `dropObservation` → `pageLoaded(A)`，事件为 `navigate(reload, A)` 紧接 `page(A)`。
- 被拦下的刷新：`pendingCause(reload, A)` 之后连续三次 `pageLoaded(A)` 且没有 `dropObservation`，不产生任何 `navigate`、也不多出 `page`；之后经链接去了 B（`dropObservation` → `pageLoaded(B)`），B 没有 `navigate`。
- **被拦下的后退、然后按下鼠标即跳转的链接**：`page(A)`、`pendingCause(back, A0)`、在 A 上一次 `pointer`、`dropObservation`、`pageLoaded(B)`。投影出的步骤里有那次点击，没有 `navigate`。这是第三期终审实测丢点击的那个序列，修复前必须是红的。
- 真后退：`pendingCause(back, A0)` → `dropObservation` → `pageLoaded(A0)`，得到 `navigate(back, A0)`。
- 后退落到了别处（重定向）：`pendingCause(back, A0)` → `dropObservation` → `pageLoaded(R)`，没有 `navigate`，有 `page(R)`。
- 同文档后退（锚点）：`pendingCause(back, A#x)` → 不经 `dropObservation` 直接 `pageLoaded(A#x)`，得到 `navigate(back, A#x)`。

变异验证至少包括：去掉 `loadStarted` 条件，被拦下的刷新用例变红；去掉与预期地址的比较，丢点击那条用例变红。

- [ ] 写失败用例并确认红；实现；`pnpm typecheck && pnpm lint && pnpm test`；变异验证；改规格与更新日志；提交 `fix(recording): bind a navigation cause to where it is expected to land`

---

### Task 2: 超长地址不再让整页事件丢失

**问题。** 页面脚本发出的地址不截断，而原始事件的校验上限是 8192 个字符，超过的那一页所有事件都会在主进程校验时被静默丢掉。更糟的是主进程这一侧：页面条目与地址栏导航的地址同样没有截断，而事件日志与轨迹的 schema 都限制在 8192，所以一份录制里只要有一个超长地址，停止录制时轨迹序列化会失败，整份录制存不下来。

**Files:**

- Modify: `src/main/recording/types.ts`、`src/main/recording/recorder-script.ts`、`src/main/recording/capture.ts`、`src/main/recording/project.ts`
- Test: `tests/recording-script.test.ts`、`tests/recording-capture.test.ts`、`tests/recording-project.test.ts`、`tests/recording-session.test.ts` 或 `tests/recording-library.test.ts`
- Docs: `CHANGELOG.md` 的 `[未发布]`

**设计决定：**

1. `types.ts` 导出 `MAX_URL_LENGTH = 8192`，所有地址字段的 `.max(8192)` 改用它，不留字面量。页面脚本通过模板注入同一个常量。
2. 页面脚本的 `href()` 截到 `MAX_URL_LENGTH`。
3. 采集层对每一个进入日志的地址截断到 `MAX_URL_LENGTH`：页面条目、导航、备注的 `onUrl`；元素、滚动、不支持这几类的地址已经由脚本截过，仍然防御性地截一次。
4. **截断过的导航不能原样回放**：去一个被截短的地址会悄悄走错。`LoggedEvent` 的 `navigate` 增加可选的 `truncated: true`；投影遇到它时产出一条「需要我」步骤，`UNSUPPORTED_REASONS` 增加 `'url-too-long'`，说明写「手动打开录制时的那个地址：地址太长，回放无法原样还原」。
5. 页面条目与步骤的 `onUrl` 截断后不需要特殊处理：回放比对页面只看源与路径（`player.ts` 的 `samePage`），截掉的是尾部。

**验收用例**（每条做变异验证）：

- 脚本：`location.href` 为 9000 个字符时，点击事件照常发出，载荷里的地址长度等于 `MAX_URL_LENGTH`，并能通过 `RawEventSchema.parse`。
- 采集：9000 字符的页面地址记进日志后长度为上限，日志里每一条都能通过 `LoggedEventSchema.parse`；9000 字符的地址栏导航带 `truncated: true`。
- 投影：截断过的导航产出带 `url-too-long` 的「需要我」；没截断的导航与现在逐字节相同。
- **端到端的存取**：一份页面地址为 9000 字符、上面有一次点击的录制，经会话层停止后能成功写盘并读回，点击步骤的 `onUrl` 与原始长地址用 `samePage` 比对为真。修复前这条必须是红的（存盘失败）。

- [ ] 写失败用例并确认红；实现；全量检查；变异验证；更新日志；提交 `fix(recording): clamp over-long addresses instead of losing the page`

---

### Task 3: 富文本正文不再进入元素名

**问题。** 元素名有两个来源，两个都会带出富文本编辑区里的正文：

- 页面脚本的 `accessibleName` 对非表单元素退回读 `textContent`。点击发生在一个带角色属性、里面包着编辑区的元素上（CKEditor 一类的外壳、包着编辑器的卡片），或者点在编辑区内部的链接、提及标签上，元素名会带出最多 400 个字的正文，写进事件日志的 `el`。
- 采集层在观察结果对得上时用观察那一行的名字，而观察的名字来自浏览器的可访问性树。按钮、链接、单元格这类角色的可访问名取自内部文字，包括编辑区里的正文，最多 200 个字，会进入步骤目标，写进日志、轨迹，并出现在审批摘要里。

**Files:**

- Modify: `src/main/recording/recorder-script.ts`、`src/main/recording/types.ts`、`src/main/recording/capture.ts`、`src/main/recording/resolve.ts`、`src/main/recording/format.ts`
- Test: `tests/recording-script.test.ts`、`tests/recording-capture.test.ts`、`tests/recording-resolve.test.ts`、`tests/recording-format.test.ts`、`tests/electron.e2e.ts`
- Docs: `docs/architecture.md`（第三期写明了这条泄漏，修好后改掉那句）、`CHANGELOG.md` 的 `[未发布]`

**设计决定：**

1. **「可编辑上下文」的判定。** 一个元素的名字「可能取自可编辑文字」，当且仅当：它自身或某个祖先是编辑宿主（`closest('[contenteditable]:not([contenteditable="false"])')` 非空，覆盖编辑区里的链接与 `contenteditable="false"` 的提及标签）；或者它的后代里有编辑宿主；或者它的 `aria-labelledby` 指向的元素满足前两条之一。
2. **脚本算名字时不读可编辑文字。** 对上述元素，从内容取名与从 `aria-labelledby`、`label` 取名时跳过编辑宿主的整棵子树；元素本身处在编辑宿主里时，完全不从内容取名。**不在任何编辑上下文里的元素，名字必须与现在逐字节相同**：只有检测到编辑上下文时才走新的计算路径，否则仍然直接用 `textContent`。
3. **元素描述带标记。** `ElementDescriptionSchema` 增加可选的 `editable: true`，脚本对上述元素置位。
4. **采集层只在可证明干净时采用观察的名字。** 带标记的元素：观察那一行对得上，且观察名与脚本算出的干净名规范化后相等，照常用观察那一行（带标签的编辑框就是这种情况，回放按名字匹配不受影响）；否则**扣下名字**：目标的 `name` 为空串，带 `editable: true`，保留指纹，不带 `nth`。观察对不上、走脚本描述的那条路时，带标记的元素一律扣下名字。
5. **扣下名字的目标只按指纹回放。** `StepTargetSchema` 增加可选的 `editable: true`；`resolveTarget` 遇到它只试指纹一级，对不上就返回 `NO_MATCH` 交还给人，**绝不按名字匹配**：空名或残缺的名字可能正好等于页面上另一个元素的名字，按名字匹配会点错元素，这是这个功能的核心安全属性。
6. 步骤描述（`describeStep`）对扣下名字的目标不打印空引号，改为说明名字已隐去，例如 `点击 [名称已隐去，含富文本]（button）`。它进入审批摘要，所以同样要过 `oneLine`。
7. 回放能力的代价要写清楚：包着编辑区的元素，以前只有正文与录制时完全相同才能按名字匹配上，现在只有外层 HTML 完全相同才能按指纹匹配上，两者大体相当；对不上时交还给人，不会点错。

**验收用例**（每条做变异验证）：

- 脚本：`<span role="button">` 包着编辑区时点击，载荷里没有任何一段编辑区文字，`el.editable` 为真；编辑区内部的链接、`contenteditable="false"` 的提及标签（越界上报那条路径）同样扣下；`aria-labelledby` 指向编辑区的按钮同样扣下。**普通按钮的载荷与现在逐字节相同**，没有 `editable` 字段。
- 采集：带标记且观察名含正文时目标被扣下（空名、`editable`、有指纹、无 `nth`）；带标记但观察名与干净名相等时目标与现在相同；不带标记时与现在相同。
- 回放：扣下名字的目标指纹对得上时命中；指纹对不上、而页面上恰好有一个同角色同标签、名字为空串的元素时返回 `NO_MATCH`，不命中它。
- **端到端**：在现有「过程日志」E2E 旁边加一条或扩展它：在一个带角色属性的外壳里点进编辑区并输入一段独特的文字，停止后读 `events.jsonl` 与 `trajectory.md` 的全文，断言那段文字一次都没出现。这是唯一能验证可访问性树那条口子的地方，单测覆盖不到。

- [ ] 写失败用例并确认红；实现；全量检查加相关 E2E；变异验证；改架构文档与更新日志；提交 `fix(recording): keep rich-text prose out of element names`

---

### Task 4: 重算提示不再被后续刷新吃掉

**问题。** 读取时发现轨迹被手改过，会按日志重算并改写文件，列表这一次报 `recomputed`，下一次列表就不再报。提示放在详情面板里，而新建、删除、改名都会刷新列表，所以人先做了这些操作、再点开那份录制，就永远看不到「手工改动未保留」。

**Files:**

- Modify: `src/main/recording/library.ts`、`src/main/main.ts`、`src/shared/contracts.ts`、`src/renderer/SkillLibrary.tsx`
- Test: `tests/recording-library.test.ts`、`tests/electron.e2e.ts`
- Docs: `CHANGELOG.md` 的 `[未发布]`

**设计决定：**

1. **提示记在技能库对象里，直到人看过为止。** `RecordingLibrary` 持有一个待告知集合：`list()` 或 `read()` 发生重算时把 id 加进去；此后每次 `list()` 都对集合里的 id 报 `recomputed: true`，与那一次是否重算无关；新增 `acknowledgeRecompute(id)` 把它移出。只存在内存里：应用重启后提示消失是可以接受的，因为重算只在读取时发生，而重启前人有整个会话的时间看到它。
2. **看过的定义是点开那份录制。** 详情接口（`skillDetail`，对应 `IPC.skillsRead`）在返回里带上这份录制是否有待告知的提示，然后确认掉它并刷新列表。`SkillDetail` 契约增加可选的 `recomputed`。**不新增 preload 方法**。
3. **列表行上要看得出来**：有待告知提示的行显示一个短标记，人不用挨个点开也能找到是哪一份。详情面板里的那句话来自详情接口这一次的返回，而不是列表摘要；否则确认之后列表一刷新，那句话会一闪而过。

**验收用例**（每条做变异验证）：

- 技能库：手改一份录制的步骤后，第一次 `list()` 报 `recomputed`；接着新建另一份录制、改另一份的名字，再 `list()` 两次，那一份仍然报 `recomputed`；`acknowledgeRecompute` 之后不再报；确认一个不存在的 id 什么也不做。
- **E2E**：手改一份录制的 `trajectory.md` 步骤，触发一次列表刷新（例如改另一份录制的名字），再点开被手改的那一份，看到「步骤已按过程记录重算，手工改动未保留。」；关掉再点开，不再出现。

- [ ] 写失败用例并确认红；实现；全量检查加这条 E2E；变异验证；更新日志；提交 `fix(recording): keep the recompute notice until the person has seen it`

---

### Task 5: 日志读不出时说清原因，清扫残留的临时文件

**问题。** 其一，读日志的函数把所有错误都当成「没有日志」：权限不足、路径变成了目录，都会让一份有日志的录制被当成第一期的老录制，既跳过手改检测，又在过程视图里显示为空。列表之后日志被删掉，过程视图同样显示为空，看起来像什么都没发生。其二，临时文件名每次唯一之后，写入在重命名前崩溃留下的临时文件不会再被后续写入覆盖，会一直留到整份录制被删，而日志的临时文件里有人键入的内容。

**Files:**

- Modify: `src/main/recording/library.ts`、`src/main/main.ts`
- Test: `tests/recording-library.test.ts`
- Docs: `docs/architecture.md`（录制目录与文件的那段，补一句临时文件的清扫）、`CHANGELOG.md` 的 `[未发布]`

**设计决定：**

1. **只有「文件不存在」才等于没有日志。** 读日志时只对 `ENOENT` 返回 `undefined`；其它错误以中文说明抛出（「读不出过程记录：…」）。于是读取与列表都会把这份录制显示为带原因的错误行，而不是悄悄降级成老录制。
2. **过程视图要日志时，日志不在就报错。** 技能库新增一个在日志缺失时抛中文错误的读取方法（例如「找不到这份录制的过程记录，文件可能已被删除或移走」），过程视图的 IPC 处理函数改用它；过程视图已经会把错误原因显示出来（第三期 Task 9 的修复）。`readEvents` 本身保持「没有就是 `undefined`」的语义，提炼靠它区分新老录制。
3. **清扫只动过期的临时文件。** 技能库新增清扫方法：遍历每个录制目录，删除以 `.tmp` 结尾、修改时间早于阈值的文件，阈值十分钟。这个应用没有单实例锁，两个实例可能同时写同一个目录，所以不能删新鲜的临时文件；进行中的写入只持续几毫秒。启动时调用一次，失败只记日志不阻断启动。**绝不删除不以 `.tmp` 结尾的文件**；根目录不存在时什么也不做。

**验收用例**（每条做变异验证）：

- 把一份录制的 `events.jsonl` 换成一个目录：`read()` 以中文说明拒绝，`list()` 把它显示为带原因的错误行；日志文件确实不存在时，仍然按老录制读出、不报错。
- 日志缺失时，过程视图用的那个读取方法抛出中文错误。
- 清扫：修改时间早于阈值的 `.tmp` 被删，新鲜的 `.tmp` 保留，`trajectory.md`、`events.jsonl`、`skill.md` 一个都不碰，根目录不存在时不抛错。

- [ ] 写失败用例并确认红；实现；全量检查；变异验证；改架构文档与更新日志；提交 `fix(recording): surface an unreadable log and sweep stale temp files`
