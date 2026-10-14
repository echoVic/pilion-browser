# Pilion「Agent 对话面板」重设计 · 设计规范

**版本**：v1.1（2026-10-14，新增 §4.13 历史对话恢复三态与快照契约）
**适用范围**：Pilion 桌面浏览器右侧「Agent 对话面板」（Electron + React 19 + TypeScript）
**默认宽度**：368px ｜ **最窄宽度**：300px ｜ **可收起**
**主题**：深色 / 浅色 / 跟随系统（`prefers-color-scheme`）
**验收依据**：本规范 + 配套《验收清单》+ 高保真原型（`pilion-chat-panel-prototype.html`）与 24 张状态截图（16 张基础状态 + 2 张补充单图 + 6 张恢复场景）

---

## 1. 设计目标与原则

面向「人监督 Agent 操作浏览器」的持续在场场景，面板设计遵循四条原则：

1. **滚动区只放历史，一切"现在要做的决定"固定在滚动区外。** 审批、接管/继续/停止、排队管理永远钉在输入框上方，不随对话滚动消失。
2. **状态用色彩语义而非大面积色块表达。** 青 = Agent 在干活；琥珀 = 需要人；红 = 失败/危险。正文与容器保持中性色，只有指示器、图标、徽标承载彩色。
3. **信息密度分层。** 一眼要看的（状态条、工具行、审批按钮）用 12–13px 高对比；可以慢看的（时间戳、提示语）用 11px 低层级；绝不把正文压到 12px 以下。
4. **窄到 300px 不裁内容，只裁冗余。** 文字截断、芯片缩写、提示语隐藏均有明确规则，任何宽度下按钮与审批操作不折叠、不隐藏。

## 2. 强调色选型：蓝绿（Teal）及其理由

新设计弃用现有靛蓝（`--accent: #315cdb / #93adff`），改用 **蓝绿/青（HSL ≈ 174°）**：深色主题 `#2dd4bf`、浅色主题 `#0f766e`。

理由：

- **语义区隔**：面板内充满网页内容与 Markdown，链接惯例是蓝色；Agent 身份色若也用蓝/靛蓝，用户无法区分"这是链接还是 Agent 说的"。蓝绿与链接蓝、与 Chromium 系浏览器强调色都拉开了距离。
- **色彩心理**：蓝绿传递"自动执行 / 进程 / 可托付"，与"Agent 正在替你操作浏览器"的核心心智一致；同时它是现有靛蓝（色相约 230°）在色轮上的近邻迁移，不改变工具类产品的冷静调性，又完成了品牌区隔（用户明确排除大面积靛蓝/紫）。
- **三色语义系统干净**：青 = 机器在干活（运行中、工具 spinner、发送按钮）；琥珀 = 需要人（审批、人工接管）；红 = 危险（拒绝、停止、错误）。三种状态色互不抢占，且都不需要大面积填充即可达标。
- **无障碍可达**：`#2dd4bf` 在深色面板底上对比度 **9.53:1**，`#0f766e` 在浅色底上 **4.97–5.47:1**，`#0f766e` 上放白字 **5.47:1**——两套主题都满足 WCAG AA，无需加大色块。

## 3. 信息架构与区域分层

面板自上而下固定为 7 层，**层 1–3 与层 5–7 永不滚动**，仅层 4 滚动：

```
┌──────────────────────────────┐
│ 1 会话标签行 (40px)           │ ← 多会话切换、历史入口、新会话
├──────────────────────────────┤
│ 2 头部 (46px)                │ ← Agent 身份、连接状态、管理、收起面板
├──────────────────────────────┤
│ 3 状态条 (34px)              │ ← 对话/活动分段 + 运行状态文案
├──────────────────────────────┤
│                              │
│ 4 滚动区（flex:1，唯一滚动）    │ ← 消息、推理、工具行、计划、Markdown、
│   · 上/下边缘 14px 渐隐       │    工作中指示器、回到底部按钮、空态
│   · 底部居中"回到底部"悬浮钮    │
│                              │
├──────────────────────────────┤
│ 5 审批坞（条件渲染）           │ ← 固定于滚动区外，长详情内部滚动
├──────────────────────────────┤
│ 6 任务控制条（条件渲染）        │ ← 运行中：接管+停止；人工：继续任务+停止
├──────────────────────────────┤
│ 7 输入区                      │ ← 排队消息 / 技能提案 / 提示条 / 输入卡片
│   (含技能选择器浮层)           │    （权限芯片、模型芯片、附件、发送/停止）
│   + 底部信息行                │    + 页面上下文与快捷键提示
└──────────────────────────────┘
```

**层叠顺序（z-index）**：滚动区内容 0 → 边缘渐隐层 3 → 回到底部按钮 4 → 技能选择器浮层 10 → 调试/浮窗 99。

**收起态**：面板收起为左侧 44px 图标条（保留消息图标 + 未读审批角标），收起动画 240ms；收起时各会话草稿保留在应用状态并按会话 ID 隔离（沿用现有 `draft` 机制）。

### 3.1 会话标签行（新增）

- 结构：`[tabs-scroll（横向滚动，左右 8px 渐隐遮罩）][历史图标钮][新会话图标钮]`
- 会话标签 chip：高 28px，内边距 0 10px，圆角 6px，字号 12px/500，最大宽 132px（截断省略）；未读审批角标：高 15px 圆形，`--chat-warn-soft` 底 + `--chat-warn` 字，字号 10px/600
- 选中态：`--chat-accent-soft` 底 + `--chat-accent` 字（600）；悬停：`--chat-hover` 底
- 「历史对话」按时间倒序列出全部会话（Popover，复用浮层规格）；标签行只保留最近活跃会话，避免挤占
- 多会话并行：每会话独立 runtime（沿用 `key={activeConversationId}` 重建机制），跨会话审批在对应会话标签上以角标呈现

### 3.2 头部

- 高 46px，左：Agent 头像（26×26，圆角 8，`--chat-accent-soft` 底 + 青色图标）+ Agent 名（14px/600）+ 连接状态点（6px：绿=就绪 / 琥珀=连接中（呼吸动画 1.2s）/ 灰=未连接）+ 下拉箭头；点击展开 Agent 选择器（原生 select 触发，含"添加 Agent…"）
- 右：管理 Agent（28×28 图标钮）、收起面板（28×28 图标钮）
- Agent 安装进度条（`AdapterInstallProgress`）出现时，在头部下沿叠加 2px 进度条

### 3.3 状态条

- 左：分段控件（对话 / 活动），高 24px，容器 `--chat-input` 底圆角 6 内边距 2，选中项浮起（`--chat-surface` 底 + `--shadow-1` + 600 字重）；「活动」带待审批数徽标（琥珀）
- 右：运行状态文案 12px + 6px 状态点：就绪（灰）/ 正在工作（青，呼吸）/ 等待你的确认（琥珀）/ 等待继续（琥珀）/ 任务已停止（灰）
- 替代原 `panel-tabs` 行；活动视图为全宽列表（审批历史 + 事件流），入口在状态条

### 3.4 滚动区

- 内边距 12px 12px 16px，消息间距 12px；细滚动条（8px，滑块 `--chat-border`，悬停 `--chat-border-strong`）
- **自动滚动**：流式输出时贴底滚动；用户向上翻阅即暂停自动滚动（`ThreadPrimitive.Viewport autoScroll` 行为），此时显示「回到底部」悬浮钮（30×30 圆形，`--chat-raised` 底 + `--chat-border-strong` 边 + `--shadow-2`，底部居中、距底 14px；悬停上浮 1px）
- **上下边缘淡出**：贴滚动区视口顶/底的 14px 高渐变（`--chat-bg` → 透明），纯装饰、不拦截指针

---

## 4. 组件规格

所有交互态定义（除特别说明外）：hover = 背景加深一档；active = `scale(.98)`；focus-visible = 2px `--chat-focus` 焦点环，offset 2px；disabled = `opacity:.45` + `cursor:not-allowed`（不响应 hover）。

### 4.1 消息

**用户消息**（右对齐）
- 气泡：`--chat-user-bubble` 底 + 1px `--chat-user-bubble-border` 边，圆角 `10px 4px 10px 10px`（右上角小倒角指示方向），内边距 8px 12px，正文 13px/1.45，最大宽 88%（300px 宽度下 94%）
- 气泡时间戳：11px `--chat-text-subtle`，气泡下方右对齐

**Agent 消息**（全宽，无气泡）
- 作者行：18×18 头像（圆角 4）+ "Agent"（12px/600）+ 时间（11px subtle）
- 正文：13px/1.45，Markdown 渲染（GFM）；**悬停消息时**底部操作行淡入（`opacity 0→1`，120ms）：时间 + 复制按钮（22×22；成功后变青色对勾，`aria-label` 同步变「已复制」，1.6s 后还原；失败显示「复制失败，重试」）——流式输出中操作行隐藏（`hideWhenRunning`）

**系统消息（出错/接管提示）**
- 全宽卡片：`--chat-danger-soft` 底、1px `--chat-border` 边 + **3px 左色条**（错误红 / 接管琥珀）、圆角 8，内边距 8px 12px，12px 正文，图标 13px 同色；`role="alert"`（错误）或 `role="status"`（接管）

### 4.2 推理折叠（reasoning）

- `<details>` 实现，左侧 2px `--chat-border` 竖线 + 左内边距 8px
- 摘要行：✦图标 + "思考过程"（12px/500 `--chat-text-muted`）+ 右箭头（展开时旋转 90°，180ms）；流式进行中默认展开，完成后默认收起
- 正文：12px `--chat-text-muted`/1.55，最大高 180px，超出内部滚动

### 4.3 工具调用行

- 高 26px：状态图标 13px（spinner 青色 0.8s 线性旋转 → 完成=青色对勾 → 失败=红色感叹号）+ 工具名（12px/500 正文色，等宽字体感）+ 参数摘要（11px subtle，等宽）+ 右侧耗时（11px subtle）
- 运行中整行文字转青；同一 `toolCallId` 原地更新（不重复插入）

### 4.4 计划 / 任务列表卡

- 卡片：`--chat-surface` 底、1px `--chat-border` 边、圆角 8、内边距 8px 12px
- 头行：「任务计划」12px/600 + 右侧进度徽标（`2/3`，青字 + `--chat-accent-soft` 底，圆角 full）
- 条目：15px 方形复选框（1.5px `--chat-border-strong` 边）+ 12px 文字
  - done：青底 + 深青对勾，文字划线转灰
  - current：青边 + 青底环形（内缩 3px 留白）+ 文字 600
  - pending：灰边空框 + 灰字
- Markdown 任务列表（`- [ ]`）复用同一复选框规格，无卡片容器

### 4.5 Markdown 富文本

- **代码块**：圆角 8、1px `--chat-border` 边；头行 28px（深色代码底 `#121316`，语言标签 11px 等宽大写 + 右侧复制钮 22×22）；正文 `#121316` 底 + `#d9dce3` 字，12px 等宽/1.55，内边距 8px 12px，横向滚动。**两套主题统一使用深色代码底**（编辑器惯例，且对比度恒定 13.53:1）
- **行内代码**：`--chat-code-inline` 底 + 1px `--chat-border` 边、圆角 4、内边距 1px 5px、12px 等宽
- **表格**：12px，表头 `--chat-hover` 底 600 灰字，行线 1px `--chat-border`，圆角 8 外框，单元格内边距 6px 8px
- **链接**：青色 + 下划线（offset 2px），点击经受控浏览器打开（沿用现有 `markdown-link` 行为）

### 4.6 审批坞（InlineApproval 重设计）

- 固定在滚动区与任务控制条之间，**独立于对话滚动**；容器上边框 1px，内边距 8px 12px
- 卡片：`--chat-surface` 底、1px `--chat-border-strong` 边、**3px 琥珀左色条**、圆角 10、`--shadow-1`、内边距 12px
- 头行：🛡图标（13px 琥珀）+「需要确认操作」（13px/600）+ 右侧「N 项待确认」计数（11px/600 琥珀字 + `--chat-warn-soft` 底 + 1px `--chat-warn-border` 边，圆角 full）
- 工具行：等宽 12px，`--chat-input` 底圆角 6 单行截断
- **操作详情**：`<details>`（12px/500 青色"操作详情"+ 旋转箭头）；展开后等宽 11px 内容区，`--chat-input` 底、圆角 6、**最大高 120px 内部滚动**（长参数永不撑开审批坞）
- **按钮行**：两条等宽按钮（高 30px、圆角 6、flex:1）始终完整可见，不随详情展开移动到屏幕外：
  - 拒绝：ghost，1px `--chat-border-strong` 边 + `--chat-danger` 字 + ✕图标；hover 转 `--chat-danger-soft` 底 + 红边
  - 批准一次：`--chat-accent-btn` 实底 + `--chat-on-accent` 字 + ✓图标；hover 亮度 +8%
- 提交中两钮同时 `disabled(.5)`，防双击重复提交（保留 nonce/digest 校验链路）

### 4.7 任务控制条（接管 / 继续任务 / 停止）

固定在输入区正上方，两钮等宽（高 30px，圆角 6）：

| 面板状态 | 主按钮（青实底） | 次按钮（ghost） |
|---|---|---|
| Agent 运行中 | **接管**（user-check 图标）：转人工、撤销 attachment、保留进度 | **停止任务**（红字 + 边框转红于 hover） |
| 人工接管中 | **继续任务**（play 图标）：随附用户补充说明 | **停止任务** |
| 空闲 | —（不渲染本条） | — |

浏览器底部控制条继续保留同组按钮（口径一致：接管/继续=主按钮，停止=次按钮）。

### 4.8 排队消息（QueuedMessages）

- 位于输入卡片上方；标签行：「待发队列 · 本回合结束后自动合并发出」（11px/600）+ 时钟图标
- 行：`--chat-raised` 底、1px `--chat-border` 边、圆角 6、内边距 4px 8px；序号（16px 圆，青字 + soft 底）+ 文本（12px 单行截断；仅图片显示「(仅图片)」；带附件追加「 · N 张图」11px）+ 撤回钮 + 删除钮（各 22×22）
- `role="status"`；回合结束（成功/失败/取消均算结束）自动合并发出，不打断

### 4.9 技能提案草稿面板（SkillProposalPanel）

- 位于排队区之下、输入卡片之上；卡片：`--chat-surface` 底、**1px `--chat-accent-border` 青边**（区别于审批的琥珀）、圆角 8、内边距 12px
- 分支图标（青）+ 标题「Agent 提出技能修改：技能名」（12px/600）+ 说明（11px 灰，「写入前仍须通过编辑分权校验（不能新增动作）」）
- 操作行：目标技能下拉（高 26px，圆角 6）+「采用为修改」（青实底小按钮）+「丢弃」（ghost 小按钮）；未选目标时采用钮 disabled；右上角 22×22 关闭 = 丢弃提案；错误 `role="alert"` 红字显示

### 4.10 输入卡片（Composer）

- 容器：`--chat-input` 底、1px `--chat-border-strong` 边、圆角 12、内边距 8px 8px 4px
- **聚焦**：边框转青 + 3px `--chat-accent-soft` 外发光（120ms）；拖拽悬停：青色虚线边
- **附件条**：52×52 缩略图（圆角 8、1px 边），右上 18px 删除钮（半透明黑底白字）；条内横向滚动；右侧计数 `3/5`（11px subtle）；白名单 `image/png|jpeg|webp|gif`，**单张 >5MB 或总数 >5 张**显示错误提示条（红色 notice），按钮在 Agent 不支持图片时 disabled
- **文本域**：14px/1.5，3 行起步（min-height 60px，上限 180px 自增），透明底；占位符按状态切换（见 §5）
- **操作行**（输入卡内下沿）：
  - 图片钮 28×28 ghost
  - **权限芯片**：高 24px、圆角 6、12px：🛡图标 + 「完全访问 / 操作前确认」；当前值以青 soft 底 + 青字标识；点击弹出两项菜单（运行中锁定）
  - **模型芯片**：同规格，⚡图标 + 当前模型名（最大 130px 截断）；点击弹出模型列表（来自 ACP `configOptions`，仅列实际可选项）
  - **发送/停止钮**（右端 28×28、圆角 6）：空闲=青实底↑；运行中=红实底■（`aria-label`「停止任务」）；未连接 Agent=插头图标
- **技能选择器浮层**（输入以 `/` 开头且无空格时展开）：锚定输入卡片上沿（间距 8px），`--chat-raised` 底、1px `--chat-border-strong` 边、圆角 10、`--shadow-3`；头行「技能 · N」（11px 大写灰）；选项（名称 12px + 描述 11px，双行）选中项青 soft 底 + 青字；底栏快捷键提示「↑↓ 选择 · Enter 插入 · Esc 关闭」；`role="listbox"` + `aria-selected`
- **键盘**：Enter 发送；运行中 Enter = 入队并清空输入；⌘/Ctrl+Enter = 打断当前回合后立即合并发送（组合输入期间 `isComposing` 不触发）；Shift+Enter 换行；选择器展开时 ↑↓/Enter/Esc 归选择器

### 4.11 底部信息行

- 输入卡片下方（11px subtle）：🌐 图标 + 页面上下文（「已共享 N 个标签页」青字 + link 图标 / detached 时「浏览器由你掌控」+ unlink 图标）+ 当前页域名（可截断）+ 右侧快捷键提示「Enter 发送 · ⌘↵ 打断并发送 · / 技能」（300px 时隐藏）
- 上下文 chip 右侧挂 attach/detach 切换

### 4.12 空态

- 居中：44×44 圆角 12 青色 soft 底图标 + 「新对话」（16px/600）+ 副文案（12px 灰，最大宽 240px）
- 3 个建议卡片：全宽、`--chat-surface` 底、1px 边、圆角 8、内边距 10px 12px，左 13px 青色图标 + 12px/500 文案 + 右侧 + 号；hover：青边 + 青 soft 底；点击填充到输入框（未连 Agent 时聚焦 Agent 选择器并显示提示条）

### 4.13 历史对话恢复（resuming / agent-missing / resume-failed）

> **契约背景**：打开历史对话时，主进程按 `conversation.agentId` 自动连接该对话当时使用的 Agent 并恢复 ACP session，连接进度与结果写入快照新增状态字段。**前端只渲染主进程快照，不自行推断 Agent。**

**共用行为（三态一致）**：
- 头部 Agent 选择器显示**这条对话的 Agent 名称**（快照字段 `conversation.agentName`），而非上一条对话的 Agent；默认 Agent 入口在此三态隐藏
- 历史消息照常渲染、可滚动浏览（滚动区行为不变）
- 输入框禁用（`disabled`，自动移出 Tab 序），placeholder 按状态给出原因；输入卡片整体 opacity 0.72、textarea `cursor:not-allowed`
- 权限模式/模型芯片只读展示，不响应点击

**1) 正在连接原 Agent（resuming）**：
- 头部：Agent 名 + 名前 12px 青 spinner（0.8s 线性旋转）+ 琥珀脉冲连接点（`conn-dot.starting`）
- 状态条：spinner + 「正在连接 {AgentName} 并恢复对话…」（青，`role="status"` `aria-live="polite"`）
- 输入区上方 notice（中性底、`role="status"` `aria-live="polite"`）：「正在连接原 Agent 并恢复对话，历史消息可浏览；恢复完成后输入自动启用。」
- 输入框 placeholder：「正在连接原 Agent，恢复后即可继续输入…」
- 成功后由主进程快照驱动回到对应运行态，输入框自动启用，焦点移回输入框

**2) 原 Agent 已被删除或禁用（agent-missing）**：
- 头部：Agent 名 + 琥珀「不可用」标签（`--chat-warn` 字 / `--chat-warn-soft` 底 / `--chat-warn-border` 边，圆角 4、内距 1×5）
- 状态条：「原 Agent 不可用」（琥珀点 + 琥珀字）
- 输入区上方 warn 通知卡（`role="alert"`，`--chat-warn-soft` 底 + 左 3px `--chat-warn` 边）：
  - 标题：「原 Agent（{AgentName}）不可用」（12px/600）
  - 正文：「该 Agent 已被删除或禁用，无法自动恢复此对话。」
  - 操作：主按钮「选择其他 Agent…」——打开 Agent 选择器
  - 补充说明（11px muted）：「选择其他 Agent 将开始全新会话，不会带上此对话之前的上下文。」（必须出现，防止用户误以为上下文延续）
- 输入框 placeholder：「请先选择其他 Agent…」

**3) 连接/恢复失败或达到并发上限（resume-failed）**：
- 头部：Agent 名 + 红色连接点
- 状态条：「恢复失败」（红点 + 红字，`role="alert"`）
- 输入区上方 danger 通知卡（`role="alert"`，`--chat-danger-soft` 底 + 左 3px `--chat-danger` 边），**两种原因文案必须区分**（快照字段 `resumeFailure.reason`）：
  - `connection`：「无法连接 Agent 服务（连接超时）。请检查网络后重试。」
  - `concurrency_limit`：「已达该 Agent 的并发会话上限（{n}/{n}）。请先结束其他会话，或稍后重试。」
  - 操作：主按钮「重试」——触发主进程重新按 `conversation.agentId` 连接；重试期间回到 resuming 表现
- 输入框 placeholder：「恢复失败，暂不可发送…」

**组件规格（通知卡富结构）**：图标列 16px + 右侧 `notice-body`（flex column，行距 `--s-3xs`）：strong 12px/600 继承状态色 → 正文 p 12px/1.55 `--chat-text` → 按钮行（`notice-actions`，间距 `--s-2xs`，上距 `--s-3xs`）→ 补充说明 11px muted。通知卡内边距、圆角、边框复用 4.6 审批坞同款 token。

**键盘焦点顺序（三态）**：会话标签行 → 头部 Agent 入口 → 「对话/活动」分段 → 滚动区（`tabindex=0` 可聚焦浏览历史）→ 通知卡操作按钮（「选择其他 Agent…」/「重试」，此三态下它是最重要的可操作元素）→ 权限/模型芯片（只读不聚焦）→ 发送按钮（disabled，已移出 Tab 序）。恢复成功 / 选择其他 Agent 后，焦点移回输入框。

---

## 5. 关键状态说明

| 状态 | 触发 | 状态条 | 输入区表现 | 其他区域 |
|---|---|---|---|---|
| **空态** | 会话无消息 | 「就绪」灰点 | 占位「今天想完成什么？」；发送钮青色↑ | 滚动区显示空态引导 + 建议 |
| **流式中** | `agentStatus=running` | 「Agent 正在工作」青点呼吸 | 发送钮变红色■；运行中 Enter 提示「输入会加入待发队列…」 | 消息尾部 2×13px 青色闪烁光标（1s steps）；「Agent 正在工作」居中胶囊（spinner+12px，`aria-live=polite`）；回到底部钮在用户上翻时出现 |
| **工具执行中** | 工具行 running | 同上 | — | 工具行 spinner→对勾（0.8s 线性），失败转红色感叹号；同 turn 内同 ID 原地更新 |
| **等待审批** | `approvals.length>0` | 「等待你的确认」琥珀点；「活动」分段出现琥珀计数 | 发送钮红色■ | 审批坞钉在滚动区外；长详情展开不影响按钮可见性 |
| **人工接管** | `task.status=manual` | 「等待继续」琥珀点 | 占位「补充说明后发送，继续任务…」；Enter 直接发送补充说明（不带附件） | 任务控制条=「继续任务」主钮+「停止」ghost；琥珀提示条「补充一句你刚才做了什么…」；底部信息行「浏览器由你掌控」 |
| **出错** | 发送失败/工具失败 | 对应状态 | `MessageNotSentError` 时草稿回填输入框 | 红色系统消息卡（`role=alert`），不自动重发；工具失败行红色图标 |
| **排队中** | 运行中按 Enter | 同流式 | 队列区显示序号+文本+撤回/删除；回合结束自动合并发出 | ⌘/Ctrl+Enter 可打断并立即发送全部 |
| **多会话** | ≥2 会话 | 每会话独立状态 | 草稿按会话隔离；队列按会话隔离 | 标签行切换；待审批以角标标记在所属会话标签上 |
| **恢复中（resuming）** | 打开历史对话，主进程按 `conversation.agentId` 连接原 Agent | 「正在连接 {AgentName} 并恢复对话…」青 spinner，`role=status` `aria-live=polite` | 输入禁用（placeholder「正在连接原 Agent，恢复后即可继续输入…」），卡片 opacity 0.72 | 头部显示**该对话的 Agent**（名前青 spinner + 琥珀脉冲点）；历史照常可浏览；中性 notice 同文案 |
| **原 Agent 不可用（agent-missing）** | 快照标记 Agent 已删除/禁用 | 「原 Agent 不可用」琥珀点 | 输入禁用（placeholder「请先选择其他 Agent…」） | 头部 Agent 名 + 琥珀「不可用」标签；warn 通知卡（`role=alert`）含「选择其他 Agent…」按钮与「不会带上之前的上下文」说明；历史可浏览 |
| **恢复失败（resume-failed）** | 连接失败或并发上限（快照 `resumeFailure.reason` 区分） | 「恢复失败」红点，`role=alert` | 输入禁用（placeholder「恢复失败，暂不可发送…」） | danger 通知卡（`role=alert`）：连接超时 / 并发上限（n/n）两种文案必须区分 + 「重试」按钮；历史可浏览 |

**收起面板**：任意状态可收起（44px 图标条 + 审批角标提醒）；草稿与队列保留。

---

## 6. 尺寸与断点

| 档位 | 宽度 | 行为 |
|---|---|---|
| 默认 | 368px | 完整规格 |
| 窄 | 300px | 标签最大宽 96px；状态条只留状态点；芯片内距收窄、模型名截断；快捷键提示隐藏；用户气泡 94%；表格 11px；审批按钮纵排；各区域内边距 12→8px |
| 收起 | 44px | 仅图标条 |
| 窗口窄屏 | <900px | 面板优先保 300px；中间网页区让位；面板永不遮挡网页视口（沿用 ResizeObserver 边界同步） |

---

## 7. Design Token

### 7.1 间距 / 字号 / 圆角 / 阴影 / 动效

| Token | 值 | 用途 |
|---|---|---|
| `--s-3xs` | 2px | 图标与文字间距 |
| `--s-2xs` | 4px | 行内元素间距 |
| `--s-xs` | 6px | 图标组间距 |
| `--s-sm` | 8px | 组件内边距（小） |
| `--s-md` | 12px | 滚动区内边距、消息间距 |
| `--s-lg` | 16px | 滚动区底距 |
| `--s-xl` / `--s-2xl` | 20 / 24px | 空态内边距 |
| `--fs-11` | 11px | 时间戳、提示、徽标、代码标签 |
| `--fs-12` | 12px | 工具行、芯片、排队、审批标题、次要正文 |
| `--fs-13` | 13px | 消息正文、审批主标题 |
| `--fs-14` | 14px | 输入框文本、头部名称 |
| `--fs-16` / `--fs-20` | 16 / 20px | 空态标题 /（预留） |
| 行高 | 1.2（标题）/ 1.45（正文）/ 1.55（代码、推理） | |
| 字重 | 400 正文 / 500 次强调 / 600 标题与选中态 | |
| `--r-xs/sm/md/lg/xl/full` | 4 / 6 / 8 / 10 / 12px / 999px | 芯片内元素 / 芯片按钮 / 卡片 / 审批卡气泡 / 输入卡 / 徽标圆点 |
| `--shadow-1` | 浅：`0 1px 2px rgba(20,22,26,.06), 0 0 0 .5px rgba(20,22,26,.05)`<br>深：`0 1px 2px rgba(0,0,0,.35)` | 分段选中项、卡片微浮 |
| `--shadow-2` | 浅：`0 4px 16px rgba(20,22,26,.10), 0 1px 2px rgba(20,22,26,.06)`<br>深：`0 8px 24px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.3)` | 回到底部钮 |
| `--shadow-3` | 浅：`0 12px 32px rgba(20,22,26,.16), 0 2px 6px rgba(20,22,26,.08)`<br>深：`0 12px 32px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4)` | 技能选择器浮层 |
| `--t-fast` | 120ms | hover/焦点/淡入淡出 |
| `--t-med` | 180ms | 展开/收起（details 箭头旋转） |
| `--t-slow` | 240ms | 面板收起/展开 |
| `--ease` | `cubic-bezier(.2, 0, 0, 1)` | 全部过渡 |
| spinner | 0.8s linear 无限 | 工具行/工作指示 |
| 状态点呼吸 | 1.2s ease-in-out（opacity 1→.35→1） | 连接中/运行中 |
| 光标闪烁 | 1s steps(2,start) | 流式光标 |

### 7.2 颜色 Token（两套主题）

**深色主题（`[data-theme='dark']`）**

| Token | Hex | 用途 | 对比度（对 `--chat-bg #17181c`） |
|---|---|---|---|
| `--chat-bg` | `#17181c` | 面板底 | — |
| `--chat-surface` | `#1d1e22` | 卡片（计划、审批、提案） | 正文 14.13:1 |
| `--chat-raised` | `#23242a` | 浮层（技能选择器、排队行、工作胶囊） | 正文 13.13:1 |
| `--chat-input` | `#26272d` | 输入卡、下拉、代码头以外的浅容器 | 正文 12.64:1 |
| `--chat-text` | `#ececf0` | 正文 | **15.06:1** |
| `--chat-text-muted` | `#adaeb8` | 次要文字 | **8.04:1** |
| `--chat-text-subtle` | `#8b8d99` | 占位符、时间戳（仅 ≥11px 非关键信息） | **5.38:1**（对 input 底 4.51:1） |
| `--chat-border` | `#2d2e35` | 装饰性分隔线（不做 3:1 要求） | 1.2:1（装饰，豁免） |
| `--chat-border-strong` | `#767a8a` | 交互组件边界（输入卡、按钮、ghost 边） | **4.16:1**（对 input 3.49:1）✓ AA 图形 |
| `--chat-hover` | `#303139` | hover 底色 | — |
| `--chat-accent` | `#2dd4bf` | 青色：图标、选中文字、焦点环 | **9.53:1** |
| `--chat-accent-btn` | `#2dd4bf` | 实底按钮底 | — |
| `--chat-on-accent` | `#052e2a` | 实底按钮上的文字 | 对 accent 底 **7.89:1** |
| `--chat-accent-soft` | `#16302d` | 选中态底（标签、芯片、徽标） | — |
| `--chat-accent-border` | `#2f6f68` | 选中/hover 强调边（提案卡、建议卡 hover） | — |
| `--chat-user-bubble` | `#1f3330` | 用户气泡底 | 正文 **11.32:1** |
| `--chat-user-bubble-border` | `#5d8d83` | 用户气泡边 | 对气泡底 **3.56:1** ✓ AA 图形 |
| `--chat-warn` | `#fbbf24` | 琥珀文字/图标 | 9.53:1 级 |
| `--chat-warn-soft` | `#2b2413` | 琥珀提示底 | 字对底 **9.22:1** |
| `--chat-warn-border` | `#8a6d1f` | 琥珀提示边 | — |
| `--chat-danger` | `#e89189` | 危险文字 | **7.47:1** |
| `--chat-danger-btn` | `#e89189` | 停止钮底 | — |
| `--chat-danger-soft` | `#3b2725` | 错误提示底 | 字对底 **5.88:1** |
| `--chat-success` | `#34d399` | 成功图标、连接就绪点 | 对 surface **8.66:1** |
| `--chat-code-bg` | `#121316` | 代码块底（两主题统一） | 代码字 **13.53:1** |
| `--chat-code-text` | `#d9dce3` | 代码字 | 同上 |
| `--chat-code-inline` | `#2b2c33` | 行内代码底 | — |
| `--chat-focus` | `#2dd4bf` | 焦点环 | **9.53:1**（≥3:1）✓ |

**浅色主题（默认 `[data-theme='light']`，`auto` 时跟随系统）**

| Token | Hex | 用途 | 对比度（对 `--chat-bg #f3f4f6`） |
|---|---|---|---|
| `--chat-bg` | `#f3f4f6` | 面板底 | — |
| `--chat-surface` | `#ffffff` | 卡片、浮层 | 正文 16.07:1 |
| `--chat-raised` | `#ffffff` | 浮层 | 同上 |
| `--chat-input` | `#ffffff` | 输入卡 | 正文 16.07:1 |
| `--chat-text` | `#202126` | 正文 | **14.60:1** |
| `--chat-text-muted` | `#5c5e66` | 次要文字 | **5.87:1**（对白面 6.47:1） |
| `--chat-text-subtle` | `#6e717e` | 占位符、时间戳 | 对白底 **4.85:1** |
| `--chat-border` | `#e2e4e8` | 装饰性分隔线 | 装饰，豁免 |
| `--chat-border-strong` | `#828592` | 交互组件边界 | 对白 **3.67:1**、对 bg **3.34:1** ✓ AA 图形 |
| `--chat-hover` | `#e9eaee` | hover 底色 | — |
| `--chat-accent` | `#0f766e` | 青色文字/图标 | **4.97:1**（对白 5.47:1） |
| `--chat-accent-btn` | `#0f766e` | 实底按钮底 | — |
| `--chat-on-accent` | `#ffffff` | 实底按钮文字 | 对 accent 底 **5.47:1** |
| `--chat-accent-soft` | `#e0f2ef` | 选中态底 | — |
| `--chat-accent-border` | `#9ed9d0` | 强调边 | — |
| `--chat-user-bubble` | `#dcefeb` | 用户气泡底 | 字对底 **12.52:1** |
| `--chat-user-bubble-border` | `#43897c` | 用户气泡边 | 对气泡底 **3.44:1** ✓ AA 图形 |
| `--chat-warn` | `#92400e` | 琥珀文字 | 对 warn-soft **6.35:1** |
| `--chat-warn-soft` | `#fdf1dd` | 琥珀提示底 | — |
| `--chat-warn-border` | `#c8963f` | 琥珀提示边 | — |
| `--chat-danger` | `#ba4c4c` | 危险文字 | **4.52:1**（对 danger-soft 4.58:1） |
| `--chat-danger-btn` | `#ba4c4c` | 停止钮底 | 白字 4.58:1 |
| `--chat-danger-soft` | `#fff3f2` | 错误提示底 | — |
| `--chat-success` | `#15803d` | 成功图标 | 对白 **5.02:1** |
| `--chat-code-bg` / `--chat-code-text` | `#121316` / `#d9dce3` | 代码块（两主题统一深底） | **13.53:1** |
| `--chat-code-inline` | `#f0f1f4` | 行内代码底 | — |
| `--chat-focus` | `#0f766e` | 焦点环 | 5.47:1 ✓ |

> **对比度声明**：以上正文/文字对比度全部 ≥ 4.5:1（WCAG 2.2 AA），图形与组件边界 ≥ 3:1（WCAG 1.4.11）。装饰性分隔线 `--chat-border` 刻意低对比，不承载识别信息（相邻元素以背景差与文字层级区分），按 WCAG 豁免条款处理。数值由脚本对实际 hex 实算得出，非估计值。

### 7.3 与现有 `theme.css` 的映射

新 token 以 `--chat-*` 前缀独立成组，不破坏应用其余界面（`--surface`、`--chrome` 等保持原值），面板组件只引用 `--chat-*`。接入方式：在 `theme.css` 中追加两套 `--chat-*` 定义（`:root` 与 `:root[data-theme='dark']`、`prefers-color-scheme` 媒体查询），组件替换引用即可。

---

## 8. 键盘与无障碍

**键盘路径**（全部可见焦点环，Tab 顺序 = 视觉顺序：标签行 → 头部 → 状态条 → 滚动区（`tabindex=0` 可聚焦滚动）→ 审批坞 → 控制条 → 输入区）：

- `Tab/Shift+Tab` 全区域可达；`aria-label` 覆盖所有图标钮
- 输入框：Enter 发送 / 运行中 Enter 入队 / ⌘Ctrl+Enter 打断并发送 / Shift+Enter 换行 / `/` 唤起技能选择器 → ↑↓ 选择、Enter 插入、Esc 关闭（展开期间按键不落入发送逻辑；中文输入法 `isComposing` 期间全部快捷键不触发）
- 审批坞：拒绝/批准为标准按钮，Enter/Space 触发；提交中禁用防回车重放
- 推理与操作详情：原生 `<details>`，Enter/Space 展开收起
- Esc：关闭技能选择器/浮层（不清空草稿）

**读屏（aria）**：

- 面板区域 `role="region" aria-label="Agent 对话面板"`；标签行 `role="tablist"` 语义、`aria-selected`；分段控件 `aria-pressed`
- 工作中胶囊、排队列表、提示条：`role="status"`（`aria-live` 区域）；错误消息 `role="alert"`
- 技能选择器：`role="listbox"` / `role="option"` + `aria-selected`；操作详情 `aria-expanded` 由 details 原生携带
- 复制按钮：`aria-label` 随状态切换（复制回复 → 已复制 / 复制失败，重试）
- 所有颜色对比满足 AA（§7.2）；焦点环 2px ≥ 3:1；禁止纯颜色传达状态（运行中除青点外始终有文字「Agent 正在工作」；审批除琥珀外有图标+标题）
- **恢复三态（§4.13）**：resuming 的状态条与 notice 用 `role="status"` + `aria-live="polite"`（连接进度允许延迟播报）；agent-missing 与 resume-failed 的通知卡用 `role="alert"`（隐含 assertive，立即播报）；播报内容含 Agent 名称与失败原因，屏幕阅读器用户不切会话也能获知「连的是哪条对话的 Agent、为什么不能发」；输入框 `disabled` 后自动移出 Tab 序，`aria-disabled` 不额外添加
- **恢复三态焦点顺序**（详见 §4.13 末尾）：标签行 → 头部 Agent 入口 → 视图分段 → 滚动区 → 通知卡操作按钮（「选择其他 Agent…」/「重试」）→ 输入框（disabled，跳过）；重试或恢复成功后焦点移回输入框

**减少动态效果（`prefers-reduced-motion: reduce`）**：spinner 改静态环形、呼吸/闪烁停用、过渡 ≤ 100ms 保留位移。

---

## 9. 前端落地要点

1. 沿用 `@assistant-ui/react` ExternalStoreRuntime 与 `ThreadPrimitive`：`Viewport autoScroll`（自动滚动）、`ScrollToBottom`（回到底部）、`ComposerPrimitive`（提交/停止）一一对应新视觉，不需要替换数据层。
2. 审批坞、任务控制条、排队区、提案面板均为输入区上方的条件渲染块，天然独立于滚动区，**不要放进 Viewport**。
3. 工具行更新依赖现有 `toolCallId` 同 turn 去重逻辑，视觉层只需按 `running/done/failed` 三态渲染。
4. 边缘淡隐用 `position:sticky` 贴边层或滚动容器外绝对定位渐变实现，`pointer-events:none`。
5. 窄宽适配用容器查询（`@container`）或沿用现有 ResizeObserver 通道，规则见 §6；断点只有 300px 一档，无中间档。
6. 所有图标内联 SVG（lucide 风格，stroke 1.75–2px），无外部图标库请求。

---

## 10. 配套交付物

- 原型：`pilion-chat-panel-prototype.html`（可交互：右下角调试条或 URL 参数 `?state=empty|streaming|approval|manual|queued|picker|proposal|narrow|resuming|agent-missing|resume-failed&theme=dark|light&reason=conn|limit&ui=1` 切换状态；`reason` 仅对 resume-failed 生效，区分连接失败/并发上限两种文案）
- 截图：24 张 = 16 张基础（8 状态 × 深/浅）+ 2 张补充单图（`attach-error-dark.png`、`history-light.png`）+ 6 张恢复场景（`resuming` / `agent-missing` / `resume-failed` × 深/浅；其中 resume-failed 深色演示连接超时文案、浅色演示并发上限文案，覆盖两种失败原因）
- 验收清单：`pilion-chat-panel-验收清单.md`（另行交付）
