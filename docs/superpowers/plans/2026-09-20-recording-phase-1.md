# 录制与技能 第一期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 人能在 Pilion 里录制一段浏览器操作、存成一份可移植的轨迹文件，并且在不连任何 Agent 的情况下自己回放它。

**Architecture:** 录制靠注入隔离世界的固定脚本采集 `isTrusted` 事件，归一化在主进程完成；产物是 `recordings/<slug>/trajectory.md` 里的一个 fenced json 块。回放不新增元素身份通道 —— player 只是主进程里的一个 `ToolRequest` 调用方，走 `browser.observe` → `resolve()` → `browser.click` 这条既有路径，因此白拿 Intent 台账、指纹重校验、epoch fencing、蒙层和取消链路。人工回放需要一个 Host 本地 principal（`local-user` 的 session + attachment），浏览器 ACL 侧的 `USER_PRINCIPAL` 已经存在。

**Tech Stack:** TypeScript 5.9 / Electron 44 / React 19 / zod 4 / vitest 5 / Playwright（Electron E2E）/ `node:sqlite`

**Spec:** `docs/superpowers/specs/2026-09-20-recording-and-skills-design.md`

## Global Constraints

- **不新增运行时依赖。** 运行时只允许 `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod` 三个（0.1.1 专门砍过）。不引入 YAML 解析器、不引入 jsdom、不引入选择器库
- **`src/` 内部 import 必须带 `.js` 扩展名**（ESM），例如 `from './types.js'`；`tests/` 内 import 不带扩展名，例如 `from '../src/main/recording/format'`
- **界面文案中文**，与 `main.tsx`、`CHANGELOG.md` 一致。错误消息中文
- **commit message 英文**，conventional commits，与 `git log` 现有风格一致（例：`feat(handover): let any Agent ask for a person and tell it what they did`）
- **文件权限 `0o600`**，写入用临时文件 + `rename`，与 `main/workspace.ts` 一致
- **不接受任何调用方或 Agent 提供的脚本。** `recorder-script.ts` 是随包发布的固定字符串常量
- **Agent 侧在第一期完全不存在。** 不加 MCP 工具、不加 `ToolNameSchema` 条目、不做提炼。这些是第二期
- **`type` 步骤一律 `replace: true`**；`onUrl` 出现在除 `navigate` 与 `note` 外的每个步骤上
- 命令：`pnpm test`（vitest）、`pnpm typecheck`、`pnpm lint`、`pnpm test:e2e`
- 单测跑单个文件：`pnpm vitest run tests/recording-format.test.ts`

## 文件结构

新增：

| 文件 | 职责 |
| --- | --- |
| `src/main/recording/types.ts` | 步骤、轨迹、技能的 zod schema 与类型。不含逻辑 |
| `src/main/recording/format.ts` | md 的 parse / serialize：定位 fenced block、校验、规范化写回、错误带行号 |
| `src/main/recording/resolve.ts` | 纯函数：`StepTarget` × `Observation` → 唯一 `ElementRef` 或失败原因 |
| `src/main/recording/library.ts` | `recordings/` 目录的枚举、读、原子写、slug、删除、改名 |
| `src/main/recording/recorder-script.ts` | 固定的隔离世界脚本源码字符串 |
| `src/main/recording/recorder.ts` | 原始事件 → 步骤的归一化与超纲标记。纯函数，无 Electron |
| `src/main/recording/player.ts` | 回放状态机。依赖注入 `execute`，无 Electron |
| `src/main/recording/index.ts` | 重导出，模式同 `main/browser/index.ts` |
| `tests/recording-format.test.ts` | Task 1 |
| `tests/recording-resolve.test.ts` | Task 2 |
| `tests/recording-library.test.ts` | Task 3 |
| `tests/recording-script.test.ts` | Task 4 |
| `tests/recording-recorder.test.ts` | Task 5 |
| `tests/recording-page-channel.test.ts` | Task 6 |
| `tests/recording-player.test.ts` | Task 8 |
| `src/renderer/SkillLibrary.tsx` | 技能库界面（列表 + 详情 + 步骤行 + 播放） |

修改：

| 文件 | 改动 |
| --- | --- |
| `src/main/browser/types.ts` | `BrowserPagePort` 新增两个可选方法 `startRecording` / `stopRecording` |
| `src/main/browser/electron-page-adapter.ts` | 实现录制通道的固定 CDP 命令 |
| `src/main/browser/index.ts` | 导出新增类型 |
| `src/shared/contracts.ts` | `AppState.recording`、`RecordingNoteSchema`、`SkillPlayInputSchema`、`IPC` 五个新 channel |
| `src/preload/index.ts` | `recording` 与 `skills` 两组白名单方法 |
| `src/main/main.ts` | 录制编排、互斥、本地 principal、`runTool` 的 principal 类型收窄、IPC handler |
| `src/renderer/main.tsx` | `Surface` 加 `'skills'`、左栏入口、工具栏录制控件、网页区红框 |
| `src/main/host/durable-store.ts` | 加一个公开的 `recordEvent()`，包一层私有 `event()`；本地 principal 用现有 `createSession` / `createAttachment` |
| `docs/architecture.md` | 新增一节；改「当前边界」里 preload 那句 |
| `CHANGELOG.md` | 未发布段落 |

第二期（不在本计划内）：`distill.ts`、提炼四条对账、专属提炼会话、`browser.skills.list` / `browser.skills.play`、首次回放审批、`skill.md` 的生成与编辑分权。

---

### Task 1: 步骤类型与 md 格式

**Files:**
- Create: `src/main/recording/types.ts`
- Create: `src/main/recording/format.ts`
- Create: `src/main/recording/index.ts`
- Test: `tests/recording-format.test.ts`

**Interfaces:**
- Consumes: `PressKeySchema`、`PressModifierSchema`（`src/shared/contracts.ts` 已有）
- Produces:
  - `StepTargetSchema` / `StepTarget`
  - `StepSchema` / `Step`（discriminated union on `kind`）
  - `TrajectorySchema` / `Trajectory`，`TrajectoryEntry`
  - `RecordingFormatError`（带 `line: number`）
  - `parseTrajectory(md: string): Trajectory`
  - `serializeTrajectory(value: Trajectory): string`
  - `describeStep(step: Step): string` —— 把一个步骤渲染成一行中文，界面与回放交还共用

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  RecordingFormatError,
  describeStep,
  parseTrajectory,
  serializeTrajectory,
  type Trajectory,
} from '../src/main/recording/index';

const sample: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    {
      kind: 'page',
      at: '2026-09-20T14:03:12+08:00',
      url: 'https://report.example.com/login',
      title: '登录',
      text: '请输入邮箱和密码',
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:20+08:00',
      step: { kind: 'navigate', url: 'https://report.example.com/login' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:25+08:00',
      step: {
        kind: 'type',
        onUrl: 'https://report.example.com/login',
        target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
        text: 'me@x.com',
        replace: true,
      },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:31+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/login', reason: '填写密码' },
    },
  ],
};

describe('trajectory format', () => {
  it('serialize 后再 parse 得到同一个值', () => {
    expect(parseTrajectory(serializeTrajectory(sample))).toEqual(sample);
  });

  it('序列化结果里有人读得懂的时间线和一个 fenced block', () => {
    const md = serializeTrajectory(sample);
    expect(md).toContain('```json pilion-trajectory');
    expect(md).toContain('输入 "邮箱"');
    expect(md).toContain('需要我：填写密码');
  });

  it('没有 fenced block 时报错并指出行号', () => {
    expect(() => parseTrajectory('# 月度导出\n\n什么都没有\n')).toThrow(RecordingFormatError);
    try {
      parseTrajectory('# 月度导出\n\n什么都没有\n');
    } catch (error) {
      expect((error as RecordingFormatError).line).toBe(1);
      expect((error as RecordingFormatError).message).toContain('pilion-trajectory');
    }
  });

  it('json 语法错误时报出 block 内的行号', () => {
    const md = ['# x', '', '```json pilion-trajectory', '{', '  "meta": {,', '}', '```', ''].join('\n');
    try {
      parseTrajectory(md);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingFormatError);
      expect((error as RecordingFormatError).line).toBeGreaterThanOrEqual(4);
    }
  });

  it('未知步骤类型被拒绝', () => {
    const md = serializeTrajectory(sample).replace('"navigate"', '"evaluate"');
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('type 步骤的 replace 必须是 true', () => {
    const md = serializeTrajectory(sample).replace('"replace": true', '"replace": false');
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('navigate 之外的步骤缺 onUrl 被拒绝', () => {
    const md = serializeTrajectory(sample).replace(
      '"onUrl": "https://report.example.com/login",\n        "reason"',
      '"reason"',
    );
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('describeStep 把每种步骤渲染成一行中文', () => {
    expect(describeStep({ kind: 'navigate', url: 'https://a.com/' })).toBe('打开 https://a.com/');
    expect(
      describeStep({
        kind: 'click',
        onUrl: 'https://a.com/',
        target: { role: 'button', name: '导出 CSV', tagName: 'button', nth: 2 },
      }),
    ).toBe('点击 "导出 CSV"（button，第 2 个）');
    expect(
      describeStep({
        kind: 'select',
        onUrl: 'https://a.com/',
        target: { role: 'combobox', name: '月份', tagName: 'select' },
        value: '2026-09',
      }),
    ).toBe('选择 "月份" = "2026-09"');
    expect(describeStep({ kind: 'note', text: '这里要选上个月' })).toBe('备注：这里要选上个月');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-format.test.ts`
Expected: FAIL，`Cannot find module '../src/main/recording/index'`

- [ ] **Step 3: 写 `src/main/recording/types.ts`**

```ts
import { z } from 'zod';
import { PressKeySchema, PressModifierSchema } from '../../shared/contracts.js';

const url = z.string().min(1).max(8192);

export const StepTargetSchema = z
  .object({
    role: z.string().min(1).max(120),
    name: z.string().max(400),
    tagName: z.string().min(1).max(40),
    inputType: z.string().max(40).optional(),
    optionValues: z.array(z.string().max(10_000)).max(200).optional(),
    /** 只在 role + name + tagName 完全相同的候选多于一个时出现，按文档顺序第几个，从 1 起。 */
    nth: z.number().int().min(1).max(200).optional(),
    /** localFingerprint 的前 8 位十六进制，匹配的第 0 层。 */
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .optional(),
  })
  .strict();
export type StepTarget = z.infer<typeof StepTargetSchema>;

export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url }).strict(),
  z.object({ kind: z.literal('click'), onUrl: url, target: StepTargetSchema }).strict(),
  z
    .object({
      kind: z.literal('type'),
      onUrl: url,
      target: StepTargetSchema,
      text: z.string().max(100_000),
      /** 录制记的是字段最终值而非增量，回放整体覆盖。 */
      replace: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      onUrl: url,
      target: StepTargetSchema,
      value: z.string().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      onUrl: url,
      target: StepTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('press'),
      onUrl: url,
      target: StepTargetSchema,
      key: PressKeySchema,
      modifiers: z.array(PressModifierSchema).max(1).default([]),
    })
    .strict(),
  z
    .object({ kind: z.literal('human'), onUrl: url, reason: z.string().min(1).max(500) })
    .strict(),
  z
    .object({
      kind: z.literal('note'),
      onUrl: url.optional(),
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export const UNSUPPORTED_REASONS = [
  'iframe',
  'out-of-scope',
  'gesture',
  'beyond-observe-limit',
] as const;

export const PageEntrySchema = z
  .object({
    kind: z.literal('page'),
    at: z.string().min(1).max(64),
    url,
    title: z.string().max(400),
    text: z.string().max(2000),
  })
  .strict();

export const RecordedStepSchema = z
  .object({
    kind: z.literal('step'),
    at: z.string().min(1).max(64),
    step: StepSchema,
    /** 录制当场判定：这一步回放不了，原因是什么。 */
    unsupported: z.enum(UNSUPPORTED_REASONS).optional(),
    /** 录制当时那份 observe 里这个描述就不唯一。 */
    ambiguous: z.boolean().optional(),
  })
  .strict();

export const TrajectoryEntrySchema = z.discriminatedUnion('kind', [
  PageEntrySchema,
  RecordedStepSchema,
]);
export type TrajectoryEntry = z.infer<typeof TrajectoryEntrySchema>;

export const TrajectorySchema = z
  .object({
    meta: z
      .object({
        app: z.literal('pilion'),
        version: z.literal(1),
        name: z.string().min(1).max(120),
        recordedAt: z.string().min(1).max(64),
      })
      .strict(),
    entries: z.array(TrajectoryEntrySchema).max(2000),
  })
  .strict();
export type Trajectory = z.infer<typeof TrajectorySchema>;
```

- [ ] **Step 4: 写 `src/main/recording/format.ts`**

```ts
import { TrajectorySchema, type Step, type Trajectory, type TrajectoryEntry } from './types.js';

/** 手改过的文件是不可信输入，报错必须能指到行。 */
export class RecordingFormatError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = 'RecordingFormatError';
  }
}

const TRAJECTORY_TAG = 'pilion-trajectory';

function locateBlock(md: string, tag: string): { body: string; startLine: number } {
  const lines = md.split('\n');
  const open = lines.findIndex((line) => line.trim() === `\`\`\`json ${tag}`);
  if (open < 0)
    throw new RecordingFormatError(1, `文件里找不到 \`\`\`json ${tag} 代码块，无法读取`);
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```');
  if (close < 0)
    throw new RecordingFormatError(open + 1, `\`\`\`json ${tag} 代码块没有闭合`);
  return { body: lines.slice(open + 1, close).join('\n'), startLine: open + 2 };
}

function parseBlock(md: string, tag: string): unknown {
  const { body, startLine } = locateBlock(md, tag);
  try {
    return JSON.parse(body);
  } catch (error) {
    const offset = /position (\d+)/.exec(String(error))?.[1];
    const before = offset ? body.slice(0, Number(offset)).split('\n').length - 1 : 0;
    throw new RecordingFormatError(startLine + before, `代码块里的 JSON 无法解析：${String(error)}`);
  }
}

export function parseTrajectory(md: string): Trajectory {
  const raw = parseBlock(md, TRAJECTORY_TAG);
  const result = TrajectorySchema.safeParse(raw);
  if (!result.success) {
    const { startLine } = locateBlock(md, TRAJECTORY_TAG);
    const issue = result.error.issues[0];
    throw new RecordingFormatError(
      startLine,
      `轨迹内容不合法：${issue.path.join('.')} ${issue.message}`,
    );
  }
  return result.data;
}

export function describeStep(step: Step): string {
  if (step.kind === 'navigate') return `打开 ${step.url}`;
  if (step.kind === 'note') return `备注：${step.text}`;
  if (step.kind === 'human') return `需要我：${step.reason}`;
  const { role, name, nth } = step.target;
  // 点击与勾选的目标歧义才是人需要看见的，所以只有它们带 role 与 nth。
  const where = nth ? `（${role}，第 ${nth} 个）` : `（${role}）`;
  const subject = `"${name}"${where}`;
  if (step.kind === 'click') return `点击 ${subject}`;
  if (step.kind === 'check') return `${step.checked ? '勾选' : '取消勾选'} ${subject}`;
  if (step.kind === 'type') return `输入 "${name}" = "${step.text}"`;
  if (step.kind === 'select') return `选择 "${name}" = "${step.value}"`;
  const modifiers = step.modifiers.length ? `${step.modifiers.join('+')}+` : '';
  return `按键 ${modifiers}${step.key} 于 ${subject}`;
}

function describeEntry(entry: TrajectoryEntry): string {
  if (entry.kind === 'page') return `**${entry.title || entry.url}** — ${entry.url}`;
  const marks = [
    entry.unsupported ? `⚠ 回放不了：${entry.unsupported}` : '',
    entry.ambiguous ? '⚠ 目标描述不唯一' : '',
  ].filter(Boolean);
  return [describeStep(entry.step), ...marks].join(' · ');
}

/**
 * 时间线是从 json 块渲染出来的装饰，加载时直接忽略；json 块是唯一真相。
 */
export function serializeTrajectory(value: Trajectory): string {
  const parsed = TrajectorySchema.parse(value);
  const timeline = parsed.entries.map((entry) => `- ${describeEntry(entry)}`);
  return [
    `# ${parsed.meta.name}`,
    '',
    `录制于 ${parsed.meta.recordedAt}。以下时间线由下方代码块渲染，加载时忽略；代码块是唯一真相。`,
    '',
    ...timeline,
    '',
    `\`\`\`json ${TRAJECTORY_TAG}`,
    JSON.stringify(parsed, null, 2),
    '```',
    '',
  ].join('\n');
}
```

- [ ] **Step 5: 写 `src/main/recording/index.ts`**

```ts
export * from './format.js';
export * from './types.js';
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-format.test.ts`
Expected: PASS，9 个断言全绿

- [ ] **Step 7: 类型检查与格式化**

Run: `pnpm typecheck && pnpm lint && pnpm format`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/main/recording tests/recording-format.test.ts
git commit -m "feat(recording): define the step vocabulary and the trajectory file format

A trajectory is one markdown file whose fenced json block is the only
truth; the timeline above it is rendered from that block and ignored on
load. Parse errors carry the line they happened on, because a
hand-edited file is untrusted input."
```

---

### Task 2: 目标匹配 `resolve.ts`

**Files:**
- Create: `src/main/recording/resolve.ts`
- Modify: `src/main/recording/index.ts`（加一行 `export * from './resolve.js';`）
- Test: `tests/recording-resolve.test.ts`

**Interfaces:**
- Consumes: `Observation`、`ObservedElement`、`ElementRef`（`src/main/browser/types.ts`）；`StepTarget`（Task 1）
- Produces:
  - `resolveTarget(target: StepTarget, observation: Observation): ResolveResult`
  - `type ResolveResult = { ok: true; ref: ElementRef; level: ResolveLevel } | { ok: false; reason: 'NO_MATCH' | 'AMBIGUOUS'; candidates: number }`
  - `type ResolveLevel = 'fingerprint' | 'exact' | 'normalized' | 'nth' | 'options'`
  - `toStepTarget(element, all): { target: StepTarget; duplicates: number }` —— 录制端把一行 observe 结果变成可存的目标描述（Task 5 用）
  - `normalizeName(name: string): string`

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-resolve.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation, ObservedElement } from '../src/main/browser/index';
import { resolveTarget, toStepTarget } from '../src/main/recording/index';

let counter = 0;
function element(
  partial: Partial<Omit<ObservedElement, 'ref'>> & { fingerprint?: string },
): ObservedElement {
  counter += 1;
  const ref: ElementRef = {
    id: `ref-${counter}`,
    tabId: 'tab-1',
    frameId: 'main',
    documentEpoch: 3,
    frameEpoch: 0,
    localFingerprint: partial.fingerprint ?? 'f'.repeat(64),
  };
  return {
    ref,
    role: partial.role ?? 'button',
    name: partial.name ?? 'Save',
    disabled: partial.disabled ?? false,
    tagName: partial.tagName ?? 'button',
    inputType: partial.inputType,
    optionValues: partial.optionValues,
    checked: partial.checked,
  };
}
function observation(elements: ObservedElement[]): Observation {
  return { observationId: 'obs-1', tabId: 'tab-1', documentEpoch: 3, elements };
}

describe('resolveTarget', () => {
  it('role + name + tagName 精确唯一命中', () => {
    const save = element({ name: '保存' });
    const result = resolveTarget(
      { role: 'button', name: '保存', tagName: 'button' },
      observation([element({ name: '取消' }), save]),
    );
    expect(result).toEqual({ ok: true, ref: save.ref, level: 'exact' });
  });

  it('指纹前缀优先于名字，页面改了按钮文案仍能命中', () => {
    const fp = 'a1b2c3d4' + '0'.repeat(56);
    const renamed = element({ name: '导出（新）', fingerprint: fp });
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button', fingerprint: 'a1b2c3d4' },
      observation([element({ name: '取消' }), renamed]),
    );
    expect(result).toEqual({ ok: true, ref: renamed.ref, level: 'fingerprint' });
  });

  it('指纹命中但 role 或 tagName 变了不算', () => {
    const fp = 'a1b2c3d4' + '0'.repeat(56);
    const link = element({ name: '导出', role: 'link', tagName: 'a', fingerprint: fp });
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button', fingerprint: 'a1b2c3d4' },
      observation([link]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 0 });
  });

  it('名字只差空白与大小写时按归一化命中', () => {
    const target = element({ name: '  Export   CSV ' });
    const result = resolveTarget(
      { role: 'button', name: 'export csv', tagName: 'button' },
      observation([element({ name: 'Cancel' }), target]),
    );
    expect(result).toEqual({ ok: true, ref: target.ref, level: 'normalized' });
  });

  it('同名多个且没有 nth 时报 AMBIGUOUS', () => {
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button' },
      observation([element({ name: '查看' }), element({ name: '查看' }), element({ name: '查看' })]),
    );
    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS', candidates: 3 });
  });

  it('同名多个且有 nth 时按文档顺序取第 nth 个', () => {
    const second = element({ name: '查看' });
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button', nth: 2 },
      observation([element({ name: '查看' }), second, element({ name: '查看' })]),
    );
    expect(result).toEqual({ ok: true, ref: second.ref, level: 'nth' });
  });

  it('nth 超出候选数时报 NO_MATCH', () => {
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button', nth: 5 },
      observation([element({ name: '查看' }), element({ name: '查看' })]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 2 });
  });

  it('inputType 参与精确匹配', () => {
    const email = element({ role: 'textbox', name: '', tagName: 'input', inputType: 'email' });
    const result = resolveTarget(
      { role: 'textbox', name: '', tagName: 'input', inputType: 'email' },
      observation([
        element({ role: 'textbox', name: '', tagName: 'input', inputType: 'text' }),
        email,
      ]),
    );
    expect(result).toEqual({ ok: true, ref: email.ref, level: 'exact' });
  });

  it('select 名字变了但选项集合有交集时命中', () => {
    const month = element({
      role: 'combobox',
      name: '统计月份',
      tagName: 'select',
      optionValues: ['2026-08', '2026-09', '2026-10'],
    });
    const result = resolveTarget(
      {
        role: 'combobox',
        name: '月份',
        tagName: 'select',
        optionValues: ['2026-07', '2026-08', '2026-09'],
      },
      observation([element({ role: 'combobox', name: '地区', tagName: 'select', optionValues: ['cn'] }), month]),
    );
    expect(result).toEqual({ ok: true, ref: month.ref, level: 'options' });
  });

  it('一无所获时报 NO_MATCH', () => {
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button' },
      observation([element({ name: '取消' })]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 0 });
  });
});

describe('toStepTarget', () => {
  it('唯一元素不带 nth，指纹取前 8 位小写', () => {
    const fp = 'ABCDEF01' + '0'.repeat(56);
    const only = element({ name: '保存', fingerprint: fp });
    expect(toStepTarget(only, [element({ name: '取消' }), only])).toEqual({
      target: { role: 'button', name: '保存', tagName: 'button', fingerprint: 'abcdef01' },
      duplicates: 1,
    });
  });

  it('同描述多个时带 nth，并报出重复数', () => {
    const first = element({ name: '查看' });
    const second = element({ name: '查看' });
    expect(toStepTarget(second, [first, second]).target.nth).toBe(2);
    expect(toStepTarget(second, [first, second]).duplicates).toBe(2);
  });

  it('非 sha256 形态的指纹不写入', () => {
    const odd = element({ name: '保存', fingerprint: 'button:save:1' });
    expect(toStepTarget(odd, [odd]).target.fingerprint).toBeUndefined();
  });

  it('select 带上 optionValues，input 带上 inputType', () => {
    const select = element({
      role: 'combobox',
      name: '月份',
      tagName: 'select',
      optionValues: ['a', 'b'],
    });
    expect(toStepTarget(select, [select]).target.optionValues).toEqual(['a', 'b']);
    const input = element({ role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' });
    expect(toStepTarget(input, [input]).target.inputType).toBe('email');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-resolve.test.ts`
Expected: FAIL，`resolveTarget is not a function` 或找不到导出

- [ ] **Step 3: 写 `src/main/recording/resolve.ts`**

```ts
import type { ElementRef, Observation, ObservedElement } from '../browser/types.js';
import type { StepTarget } from './types.js';

export type ResolveLevel = 'fingerprint' | 'exact' | 'normalized' | 'nth' | 'options';
export type ResolveResult =
  | { ok: true; ref: ElementRef; level: ResolveLevel }
  | { ok: false; reason: 'NO_MATCH' | 'AMBIGUOUS'; candidates: number };

type Row = Omit<ObservedElement, 'ref'> & { ref?: ElementRef };

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameKind(target: StepTarget, row: Row): boolean {
  return row.role === target.role && row.tagName === target.tagName;
}
function sameInputType(target: StepTarget, row: Row): boolean {
  return target.inputType === undefined || row.inputType === target.inputType;
}

/**
 * 按序降级，每一级都要求唯一命中；命中后仍交叉校验 role 与 tagName，
 * 所以 8 位指纹前缀撞车也撞不出问题。全部落空就交还，交还正好是 Agent 接手的时机。
 */
export function resolveTarget(target: StepTarget, observation: Observation): ResolveResult {
  const rows = observation.elements;

  if (target.fingerprint) {
    const byFingerprint = rows.filter(
      (row) =>
        row.ref.localFingerprint.slice(0, 8).toLowerCase() === target.fingerprint &&
        sameKind(target, row),
    );
    if (byFingerprint.length === 1) return { ok: true, ref: byFingerprint[0].ref, level: 'fingerprint' };
  }

  const exact = rows.filter(
    (row) => sameKind(target, row) && sameInputType(target, row) && row.name === target.name,
  );
  if (exact.length === 1) return { ok: true, ref: exact[0].ref, level: 'exact' };

  const wanted = normalizeName(target.name);
  const normalized = rows.filter(
    (row) =>
      sameKind(target, row) && sameInputType(target, row) && normalizeName(row.name) === wanted,
  );
  if (exact.length === 0 && normalized.length === 1)
    return { ok: true, ref: normalized[0].ref, level: 'normalized' };

  const duplicates = exact.length > 1 ? exact : normalized;
  if (duplicates.length > 1) {
    if (target.nth === undefined)
      return { ok: false, reason: 'AMBIGUOUS', candidates: duplicates.length };
    const picked = duplicates[target.nth - 1];
    if (!picked) return { ok: false, reason: 'NO_MATCH', candidates: duplicates.length };
    return { ok: true, ref: picked.ref, level: 'nth' };
  }

  if (target.tagName === 'select' && target.optionValues?.length) {
    const recorded = new Set(target.optionValues);
    const overlapping = rows.filter(
      (row) => sameKind(target, row) && (row.optionValues ?? []).some((value) => recorded.has(value)),
    );
    if (overlapping.length === 1) return { ok: true, ref: overlapping[0].ref, level: 'options' };
  }

  return { ok: false, reason: 'NO_MATCH', candidates: 0 };
}

/** 录制端：把 observe 的一行变成可存的目标描述。序号与指纹都从这一份 observe 里来。 */
export function toStepTarget(
  element: Row,
  all: ReadonlyArray<Row>,
): { target: StepTarget; duplicates: number } {
  const same = all.filter(
    (row) =>
      row.role === element.role && row.name === element.name && row.tagName === element.tagName,
  );
  const fingerprint = element.ref?.localFingerprint;
  const target: StepTarget = {
    role: element.role,
    name: element.name,
    tagName: element.tagName,
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.optionValues?.length ? { optionValues: [...element.optionValues] } : {}),
    ...(same.length > 1 ? { nth: same.indexOf(element) + 1 } : {}),
    ...(fingerprint && /^[a-f0-9]{64}$/i.test(fingerprint)
      ? { fingerprint: fingerprint.slice(0, 8).toLowerCase() }
      : {}),
  };
  return { target, duplicates: same.length };
}
```

- [ ] **Step 4: 在 `src/main/recording/index.ts` 加导出**

```ts
export * from './format.js';
export * from './resolve.js';
export * from './types.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-resolve.test.ts`
Expected: PASS，14 个用例全绿

- [ ] **Step 6: Commit**

```bash
git add src/main/recording tests/recording-resolve.test.ts
git commit -m "feat(recording): resolve a recorded target against a fresh observation

Five levels, each requiring a unique hit: fingerprint prefix, exact
role/name/tag, whitespace-and-case-normalised name, nth among
duplicates, then option overlap for selects. Anything else hands over."
```

---

### Task 3: 技能库目录 `library.ts`

**Files:**
- Create: `src/main/recording/library.ts`
- Modify: `src/main/recording/index.ts`（加 `export * from './library.js';`）
- Test: `tests/recording-library.test.ts`

**Interfaces:**
- Consumes: `parseTrajectory` / `serializeTrajectory` / `Trajectory`（Task 1）
- Produces:
  - `class RecordingLibrary { constructor(root: string) }`
  - `list(): Promise<RecordingSummary[]>`
  - `read(id): Promise<{ trajectory: Trajectory; markdown: string }>`
  - `create(name, trajectory): Promise<string>` —— 返回 id（slug，撞名自动加 `-2`）
  - `write(id, trajectory): Promise<void>`
  - `rename(id, name): Promise<void>` —— 只改 `meta.name`，id 不变
  - `remove(id): Promise<void>`
  - `path(id): string` —— `trajectory.md` 的绝对路径（给「在 Finder 中显示」）
  - `slugify(name: string): string`
  - `interface RecordingSummary { id; name; steps; unsupported; needsHuman; recordedAt }`

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-library.test.ts`：

```ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingLibrary, slugify, type Trajectory } from '../src/main/recording/index';

const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    {
      kind: 'step',
      at: '2026-09-20T14:03:20+08:00',
      step: { kind: 'navigate', url: 'https://report.example.com/' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:31+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/', reason: '填写密码' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:40+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/', reason: '拖拽 "滑块"' },
      unsupported: 'gesture',
    },
  ],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilion-recordings-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('slugify', () => {
  it('保留中文，空白变连字符，去掉路径字符', () => {
    expect(slugify('月度 导出 / 2026')).toBe('月度-导出-2026');
    expect(slugify('  Export   CSV  ')).toBe('export-csv');
    expect(slugify('../../etc')).toBe('etc');
    expect(slugify('!!!')).toBe('recording');
  });
});

describe('RecordingLibrary', () => {
  it('create 后能 list、read，文件是 0600 且在自己的目录里', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    expect(id).toBe('月度导出');
    expect(await library.list()).toEqual([
      {
        id: '月度导出',
        name: '月度导出',
        steps: 3,
        unsupported: 1,
        needsHuman: 2,
        recordedAt: '2026-09-20T14:03:11+08:00',
      },
    ]);
    const loaded = await library.read(id);
    expect(loaded.trajectory).toEqual(trajectory);
    expect(loaded.markdown).toContain('```json pilion-trajectory');
    const mode = (await stat(join(root, id, 'trajectory.md'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('同名再建时 id 加序号', async () => {
    const library = new RecordingLibrary(root);
    await library.create('月度导出', trajectory);
    expect(await library.create('月度导出', trajectory)).toBe('月度导出-2');
    expect(await library.create('月度导出', trajectory)).toBe('月度导出-3');
  });

  it('rename 只改名字不改 id，remove 删掉整个目录', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('旧名', trajectory);
    await library.rename(id, '新名');
    expect((await library.read(id)).trajectory.meta.name).toBe('新名');
    expect((await library.list())[0]).toMatchObject({ id: '旧名', name: '新名' });
    await library.remove(id);
    expect(await library.list()).toEqual([]);
  });

  it('坏文件在 list 里带 error 而不是让整个列表失败', async () => {
    const library = new RecordingLibrary(root);
    await library.create('好的', trajectory);
    await library.write('好的', trajectory);
    await writeFile(join(root, '好的', 'trajectory.md'), '# 手改坏了\n没有代码块\n');
    const rows = await library.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '好的', error: expect.stringContaining('pilion-trajectory') });
    await expect(library.read('好的')).rejects.toThrow(/pilion-trajectory/);
  });

  it('拒绝带路径分隔或点点的 id', async () => {
    const library = new RecordingLibrary(root);
    await expect(library.read('../x')).rejects.toThrow(/id/);
    await expect(library.remove('a/b')).rejects.toThrow(/id/);
    await expect(library.rename('..', 'x')).rejects.toThrow(/id/);
  });

  it('write 走临时文件再 rename，目录里不留 tmp', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('x', trajectory);
    await library.write(id, trajectory);
    const md = await readFile(join(root, id, 'trajectory.md'), 'utf8');
    expect(md).toContain('"name": "x"');
    await expect(stat(join(root, id, 'trajectory.md.tmp'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-library.test.ts`
Expected: FAIL，找不到 `RecordingLibrary`

- [ ] **Step 3: 写 `src/main/recording/library.ts`**

```ts
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTrajectory, serializeTrajectory } from './format.js';
import type { Trajectory } from './types.js';

export interface RecordingSummary {
  id: string;
  name: string;
  steps: number;
  unsupported: number;
  needsHuman: number;
  recordedAt: string;
  /** 文件读不出来时的原因；有它的行不能播放，但仍然列出来让人去修。 */
  error?: string;
}

const FILE = 'trajectory.md';
const ID_PATTERN = /^[\p{L}\p{N}-]{1,60}$/u;

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'recording';
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id) || id === '.' || id === '..')
    throw new Error(`不合法的录制 id：${id}`);
}

function summarize(id: string, trajectory: Trajectory): RecordingSummary {
  const steps = trajectory.entries.filter((entry) => entry.kind === 'step');
  return {
    id,
    name: trajectory.meta.name,
    steps: steps.length,
    unsupported: steps.filter((entry) => entry.unsupported).length,
    needsHuman: steps.filter((entry) => entry.step.kind === 'human').length,
    recordedAt: trajectory.meta.recordedAt,
  };
}

/** 一份录制一个目录；只有 Pilion 与人写得进来，Agent 只能通过第二期的 MCP 工具读与播。 */
export class RecordingLibrary {
  constructor(private readonly root: string) {}

  path(id: string): string {
    assertId(id);
    return join(this.root, id, FILE);
  }

  async list(): Promise<RecordingSummary[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const rows = await Promise.all(
      names.map(async (id) => {
        try {
          return summarize(id, (await this.read(id)).trajectory);
        } catch (error) {
          return {
            id,
            name: id,
            steps: 0,
            unsupported: 0,
            needsHuman: 0,
            recordedAt: '',
            error: error instanceof Error ? error.message : String(error),
          } satisfies RecordingSummary;
        }
      }),
    );
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async read(id: string): Promise<{ trajectory: Trajectory; markdown: string }> {
    const markdown = await readFile(this.path(id), 'utf8');
    return { trajectory: parseTrajectory(markdown), markdown };
  }

  async write(id: string, trajectory: Trajectory): Promise<void> {
    const target = this.path(id);
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
    await writeFile(`${target}.tmp`, serializeTrajectory(trajectory), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  async create(name: string, trajectory: Trajectory): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const base = slugify(name);
    const taken = new Set(await readdir(this.root));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    await this.write(id, { ...trajectory, meta: { ...trajectory.meta, name } });
    return id;
  }

  async rename(id: string, name: string): Promise<void> {
    const { trajectory } = await this.read(id);
    await this.write(id, { ...trajectory, meta: { ...trajectory.meta, name } });
  }

  async remove(id: string): Promise<void> {
    assertId(id);
    await rm(join(this.root, id), { recursive: true, force: true });
  }
}
```

注意 `rename(id, name)` 是先 `read` 再 `write`，`read` 内部走 `path()`，所以 `..` 之类的 id 在 `read` 处就被 `assertId` 拒绝，测试里 `rename('..', 'x')` 因此报 `id` 错误。

- [ ] **Step 4: 在 `src/main/recording/index.ts` 加 `export * from './library.js';`**

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-library.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/recording tests/recording-library.test.ts
git commit -m "feat(recording): store one trajectory per directory under recordings/

Ids are slugs validated on every call so a hand-typed id can never
leave the library root; writes go through a temp file and rename like
the workspace store; a file that fails to parse is listed with its
error rather than hiding the whole library."
```

---

### Task 4: 隔离世界录制脚本 `recorder-script.ts`

**Files:**
- Modify: `src/main/browser/types.ts`（新增 `export const OBSERVE_SELECTOR`）
- Modify: `src/main/browser/electron-page-adapter.ts:16`（删除私有 `SELECTOR`，改用 `OBSERVE_SELECTOR`）
- Create: `src/main/recording/recorder-script.ts`
- Modify: `src/main/recording/index.ts`（加 `export * from './recorder-script.js';`）
- Test: `tests/recording-script.test.ts`

**Interfaces:**
- Consumes: `PRESS_KEYS`、`OBSERVE_SELECTOR`（`src/main/browser/types.ts`）
- Produces:
  - `RECORDER_WORLD = 'pilion-recorder'`
  - `buildRecorderScript(bindingName: string): string` —— 返回完整 JS 源码；`bindingName` 必须匹配 `/^pilion_[a-f0-9]{16}$/`，否则抛错
  - 脚本发出的消息是 JSON 字符串，形状由 Task 5 的 `RawEventSchema` 定义。本任务先把形状写在脚本注释里，Task 5 用同一形状写 schema

脚本只做三件事：`isTrusted` 过滤、密码判断、算元素的可移植描述。它永不 `preventDefault`，永不等主进程。所有归一化都在主进程。

**为什么把 `SELECTOR` 挪到 `types.ts`**：录制脚本要算「被点元素是 `querySelectorAll(OBSERVE_SELECTOR)` 的第几个」，这个序号只在运行时用来和预取的 observe 结果对上（不落盘），但两边的选择器必须同源。挪到 `types.ts` 后两边 import 同一个常量，测试断言脚本源码里确实内嵌了它。

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-script.test.ts`。用 `node:vm` 跑脚本，给它一个最小的假 `document`。不引入 jsdom（运行时依赖不能加，开发依赖也不为此加）：

```ts
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OBSERVE_SELECTOR } from '../src/main/browser/index';
import { RECORDER_WORLD, buildRecorderScript } from '../src/main/recording/index';

const BINDING = 'pilion_0123456789abcdef';

type Listener = (event: Record<string, unknown>) => void;

function fakeElement(spec: {
  tagName: string;
  attributes?: Record<string, string>;
  text?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  matches?: boolean;
}) {
  const attributes = spec.attributes ?? {};
  const element: Record<string, unknown> = {
    tagName: spec.tagName.toUpperCase(),
    type: spec.type,
    value: spec.value ?? '',
    checked: spec.checked,
    textContent: spec.text ?? '',
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    closest: () => (spec.matches === false ? null : element),
    options: spec.options?.map((value) => ({ value })),
    labels: [],
    ownerDocument: undefined as unknown,
  };
  return element;
}

function harness(elements: Record<string, unknown>[]) {
  const listeners = new Map<string, Listener[]>();
  const payloads: unknown[] = [];
  const document = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    querySelectorAll: () => elements,
    activeElement: null,
  };
  for (const element of elements) element.ownerDocument = document;
  const sandbox: Record<string, unknown> = {
    document,
    location: { href: 'https://report.example.com/login' },
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Math,
    Set,
    Boolean,
    RegExp,
    [BINDING]: (payload: string) => payloads.push(JSON.parse(payload)),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  runInNewContext(buildRecorderScript(BINDING), sandbox);
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) listener({ isTrusted: true, ...event });
  };
  return { fire, payloads, listeners, sandbox };
}

describe('buildRecorderScript', () => {
  it('拒绝不合规的 binding 名', () => {
    expect(() => buildRecorderScript('alert(1)')).toThrow(/binding/);
  });

  it('内嵌的选择器与 observe 用的是同一个常量', () => {
    expect(buildRecorderScript(BINDING)).toContain(JSON.stringify(OBSERVE_SELECTOR));
    expect(RECORDER_WORLD).toBe('pilion-recorder');
  });

  it('只上报 isTrusted 事件，页面派发的合成事件被忽略', () => {
    const button = fakeElement({ tagName: 'button', text: ' 登录 ' });
    const { fire, payloads } = harness([button]);
    fire('click', { target: button, button: 0, isTrusted: false });
    expect(payloads).toEqual([]);
    fire('click', { target: button, button: 0 });
    expect(payloads).toEqual([
      {
        kind: 'click',
        url: 'https://report.example.com/login',
        index: 0,
        el: { tagName: 'button', role: 'button', name: '登录' },
        at: expect.any(Number),
      },
    ]);
  });

  it('pointerdown 也上报，供主进程与随后的导航合成点击', () => {
    const link = fakeElement({ tagName: 'a', text: 'Learn more', attributes: { href: '/x' } });
    const { fire, payloads } = harness([link]);
    fire('pointerdown', { target: link, button: 0 });
    expect(payloads[0]).toMatchObject({ kind: 'pointer', index: 0, el: { tagName: 'a', role: 'link' } });
  });

  it('input 上报当前值，密码框只上报 secret 且不带值', () => {
    const email = fakeElement({
      tagName: 'input',
      type: 'email',
      value: 'me@x.com',
      attributes: { 'aria-label': '邮箱' },
    });
    const password = fakeElement({ tagName: 'input', type: 'password', value: 'hunter2' });
    const { fire, payloads } = harness([email, password]);
    fire('input', { target: email });
    fire('focusin', { target: password });
    fire('input', { target: password });
    // focusin 与 input 各报一次 secret；连续同一字段的去重是主进程（Task 5）的事。
    expect(payloads).toEqual([
      expect.objectContaining({ kind: 'input', index: 0, value: 'me@x.com', el: expect.objectContaining({ inputType: 'email', name: '邮箱' }) }),
      expect.objectContaining({ kind: 'secret', index: 1, otp: false }),
      expect.objectContaining({ kind: 'secret', index: 1, otp: false }),
    ]);
    expect(JSON.stringify(payloads)).not.toContain('hunter2');
  });

  it('一次性验证码按 secret 上报并标 otp', () => {
    const code = fakeElement({
      tagName: 'input',
      type: 'text',
      attributes: { autocomplete: 'one-time-code' },
    });
    const { fire, payloads } = harness([code]);
    fire('focusin', { target: code });
    expect(payloads[0]).toMatchObject({ kind: 'secret', otp: true });
  });

  it('select 与 checkbox 的 change 分别上报 select 与 check', () => {
    const month = fakeElement({
      tagName: 'select',
      value: '2026-09',
      options: ['2026-08', '2026-09'],
      attributes: { 'aria-label': '月份' },
    });
    const agree = fakeElement({ tagName: 'input', type: 'checkbox', checked: true });
    const { fire, payloads } = harness([month, agree]);
    fire('change', { target: month });
    fire('change', { target: agree });
    expect(payloads[0]).toMatchObject({
      kind: 'select',
      value: '2026-09',
      el: { optionValues: ['2026-08', '2026-09'], role: 'combobox' },
    });
    expect(payloads[1]).toMatchObject({ kind: 'check', checked: true, el: { role: 'checkbox' } });
  });

  it('文本框里只有 Enter 与 Escape 算按键，其它键已体现在最终值里', () => {
    const box = fakeElement({ tagName: 'input', type: 'text' });
    const { fire, payloads } = harness([box]);
    fire('keydown', { target: box, key: 'Backspace' });
    fire('keydown', { target: box, key: 'a' });
    fire('keydown', { target: box, key: 'Enter' });
    expect(payloads).toEqual([expect.objectContaining({ kind: 'key', key: 'Enter', shift: false })]);
  });

  it('空格键上报为 Space，按钮上的方向键也上报', () => {
    const button = fakeElement({ tagName: 'button', text: '下一页' });
    const { fire, payloads } = harness([button]);
    fire('keydown', { target: button, key: ' ' });
    fire('keydown', { target: button, key: 'ArrowDown', shiftKey: true });
    expect(payloads.map((p) => (p as { key: string; shift: boolean }).key)).toEqual(['Space', 'ArrowDown']);
    expect((payloads[1] as { shift: boolean }).shift).toBe(true);
  });

  it('选择器范围外的点击上报 unsupported/out-of-scope', () => {
    const div = fakeElement({ tagName: 'div', text: '一块区域', matches: false });
    const { fire, payloads } = harness([]);
    fire('click', { target: div, button: 0 });
    expect(payloads[0]).toMatchObject({ kind: 'unsupported', reason: 'out-of-scope' });
  });

  it('拖拽与右键上报 unsupported/gesture', () => {
    const handle = fakeElement({ tagName: 'button', text: '滑块' });
    const { fire, payloads } = harness([handle]);
    fire('dragstart', { target: handle });
    fire('contextmenu', { target: handle });
    expect(payloads.map((p) => (p as { reason: string }).reason)).toEqual(['gesture', 'gesture']);
  });

  it('重复注入不会重复注册监听', () => {
    const button = fakeElement({ tagName: 'button', text: 'x' });
    const { listeners, sandbox } = harness([button]);
    runInNewContext(buildRecorderScript(BINDING), sandbox);
    expect(listeners.get('click')?.length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-script.test.ts`
Expected: FAIL，找不到 `OBSERVE_SELECTOR` / `buildRecorderScript`

- [ ] **Step 3: 把选择器挪到 `src/main/browser/types.ts`**

在 `PRESS_KEYS` 定义上方加：

```ts
/** observe 与录制脚本共用；改它会让所有已存录制的 nth 语义漂移，所以它只在这里出现一次。 */
export const OBSERVE_SELECTOR = 'a,button,input,textarea,select,[role]';
```

在 `src/main/browser/electron-page-adapter.ts` 删除第 16 行 `const SELECTOR = 'a,button,input,textarea,select,[role]';`，import 行改为：

```ts
import { OBSERVE_SELECTOR, PRESS_KEYS } from './types.js';
```

文件内两处 `SELECTOR` 用法（`observeElements` 的 `DOM.querySelectorAll` 参数，以及可能的其它引用，用 `grep -n "SELECTOR" src/main/browser/electron-page-adapter.ts` 确认）改为 `OBSERVE_SELECTOR`。

- [ ] **Step 4: 写 `src/main/recording/recorder-script.ts`**

```ts
import { OBSERVE_SELECTOR, PRESS_KEYS } from '../browser/types.js';

export const RECORDER_WORLD = 'pilion-recorder';
const BINDING_PATTERN = /^pilion_[a-f0-9]{16}$/;

/**
 * 隔离世界里跑的固定脚本。它与页面共享 DOM，但页面 JS 看不到它的变量，也调用不了它的 binding；
 * isTrusted 过滤让页面伪造不出「人类动作」。
 *
 * 发出的消息（JSON 字符串）：
 *   { kind: 'pointer' | 'click', url, index, el, at }
 *   { kind: 'input',  url, index, el, value, at }
 *   { kind: 'select', url, index, el, value, at }
 *   { kind: 'check',  url, index, el, checked, at }
 *   { kind: 'key',    url, index, el, key, shift, at }
 *   { kind: 'secret', url, index, el, otp, at }           // 值与长度都不发
 *   { kind: 'unsupported', url, reason: 'iframe' | 'out-of-scope' | 'gesture', el?, at }
 * el = { tagName, role, name, inputType?, optionValues?, checked?, duplicates?, position? }
 * index = 元素在 document.querySelectorAll(OBSERVE_SELECTOR) 里的序号，-1 表示不在其中。
 */
export function buildRecorderScript(bindingName: string): string {
  if (!BINDING_PATTERN.test(bindingName)) throw new Error('录制 binding 名不合规');
  return `(() => {
  const w = typeof window !== 'undefined' ? window : globalThis;
  if (w.__pilionRecorder) return;
  w.__pilionRecorder = true;
  const SELECTOR = ${JSON.stringify(OBSERVE_SELECTOR)};
  const KEYS = new Set(${JSON.stringify(PRESS_KEYS)});
  const send = (payload) => {
    try { globalThis[${JSON.stringify(bindingName)}](JSON.stringify(payload)); } catch (_) {}
  };
  const now = () => Date.now();
  const href = () => { try { return String(location.href); } catch (_) { return ''; } };
  const inFrame = (() => { try { return w.top !== w; } catch (_) { return true; } })();
  const text = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
  const lower = (s) => String(s || '').toLowerCase();

  const implicitRole = (el) => {
    const tag = lower(el.tagName);
    const type = lower(el.type);
    if (tag === 'a') return el.getAttribute && el.getAttribute('href') !== null ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return 'generic';
  };
  const labelText = (el) => {
    try {
      const id = el.getAttribute('aria-labelledby');
      if (id && el.ownerDocument && el.ownerDocument.getElementById) {
        const parts = id.split(/\\s+/).map((one) => el.ownerDocument.getElementById(one)).filter(Boolean);
        if (parts.length) return parts.map((p) => p.textContent).join(' ');
      }
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent).join(' ');
    } catch (_) {}
    return '';
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return text(aria);
    const labelled = text(labelText(el));
    if (labelled) return labelled;
    const tag = lower(el.tagName);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = lower(el.type);
      if (type === 'button' || type === 'submit' || type === 'reset') return text(el.value);
      return text(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    return text(el.textContent) || text(el.getAttribute('title')) || text(el.getAttribute('alt'));
  };
  const describe = (el) => {
    const tagName = lower(el.tagName);
    const out = { tagName, role: el.getAttribute('role') || implicitRole(el), name: accessibleName(el) };
    if (tagName === 'input') out.inputType = lower(el.type) || 'text';
    if (tagName === 'select' && el.options) out.optionValues = Array.from(el.options, (o) => String(o.value)).slice(0, 200);
    if (tagName === 'input' && (out.inputType === 'checkbox' || out.inputType === 'radio')) out.checked = Boolean(el.checked);
    try {
      const all = Array.from(document.querySelectorAll(SELECTOR));
      const same = all.filter((other) => lower(other.tagName) === tagName && (other.getAttribute('role') || implicitRole(other)) === out.role && accessibleName(other) === out.name);
      if (same.length > 1) { out.duplicates = same.length; out.position = same.indexOf(el) + 1; }
    } catch (_) {}
    return out;
  };
  const indexOf = (el) => {
    try { return Array.prototype.indexOf.call(document.querySelectorAll(SELECTOR), el); } catch (_) { return -1; }
  };
  const scoped = (target) => {
    if (!target || typeof target.closest !== 'function') return null;
    try { return target.closest(SELECTOR); } catch (_) { return null; }
  };
  const isSecret = (el) => {
    if (lower(el.tagName) !== 'input') return false;
    if (lower(el.type) === 'password') return true;
    return lower(el.getAttribute('autocomplete')).indexOf('one-time-code') >= 0;
  };
  const isOtp = (el) => lower(el.getAttribute('autocomplete')).indexOf('one-time-code') >= 0;
  const emit = (kind, el, extra) => send(Object.assign({ kind, url: href(), index: indexOf(el), el: describe(el), at: now() }, extra || {}));
  const unsupported = (reason, el) => send({ kind: 'unsupported', url: href(), reason, el: el ? describe(el) : undefined, at: now() });
  const on = (type, handler) => document.addEventListener(type, (event) => {
    if (!event || !event.isTrusted) return;
    try { handler(event); } catch (_) {}
  }, { capture: true, passive: true });

  const pointerLike = (kind) => (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (inFrame) { unsupported('iframe'); return; }
    const el = scoped(event.target);
    if (!el) { if (kind === 'click') unsupported('out-of-scope', event.target); return; }
    emit(kind, el);
  };
  on('pointerdown', pointerLike('pointer'));
  on('click', pointerLike('click'));

  on('focusin', (event) => {
    const el = scoped(event.target);
    if (el && isSecret(el)) emit('secret', el, { otp: isOtp(el) });
  });
  on('input', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const tag = lower(el.tagName);
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = lower(el.type);
    if (type === 'checkbox' || type === 'radio' || type === 'file') return;
    if (isSecret(el)) { emit('secret', el, { otp: isOtp(el) }); return; }
    emit('input', el, { value: String(el.value).slice(0, 100000) });
  });
  on('change', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const tag = lower(el.tagName);
    if (tag === 'select') { emit('select', el, { value: String(el.value) }); return; }
    if (tag === 'input') {
      const type = lower(el.type);
      if (type === 'checkbox' || type === 'radio') emit('check', el, { checked: Boolean(el.checked) });
    }
  });
  on('keydown', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const key = event.key === ' ' ? 'Space' : event.key;
    if (!KEYS.has(key)) return;
    const tag = lower(el.tagName);
    const editable = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(lower(el.type)));
    if (editable && key !== 'Enter' && key !== 'Escape') return;
    emit('key', el, { key, shift: Boolean(event.shiftKey) });
  });
  on('dragstart', (event) => unsupported('gesture', scoped(event.target) || event.target));
  on('contextmenu', (event) => unsupported('gesture', scoped(event.target) || event.target));
})();`;
}
```

- [ ] **Step 5: 在 `src/main/recording/index.ts` 加 `export * from './recorder-script.js';`**

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-script.test.ts tests/browser-service.test.ts`
Expected: 两个文件全部 PASS（后者验证 `SELECTOR` 重命名没有破坏 observe）

- [ ] **Step 7: 类型检查**

Run: `pnpm typecheck && pnpm lint`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/main/browser/types.ts src/main/browser/electron-page-adapter.ts src/main/recording tests/recording-script.test.ts
git commit -m "feat(recording): fixed isolated-world script that reports trusted user actions

The script does three things only: drop untrusted events, refuse to
read password and one-time-code fields, and describe the target in
portable terms. It never waits on the main process and never prevents
default. The observe selector moves to browser/types so the script and
observe() share one constant."
```

---

### Task 5: 归一化 `recorder.ts`

**Files:**
- Create: `src/main/recording/recorder.ts`
- Modify: `src/main/recording/index.ts`（加 `export * from './recorder.js';`）
- Test: `tests/recording-recorder.test.ts`

**Interfaces:**
- Consumes: `toStepTarget`（Task 2）、`Observation`（browser/types）、`PressKeySchema`（contracts）
- Produces:
  - `RawEventSchema` / `RawEvent` —— Task 4 脚本消息的 zod 形状；主进程在 binding 边界上 parse
  - `class TrajectoryRecorder`
    - `constructor(options: { name: string; now?: () => Date })`
    - `page(entry: { url: string; title: string; text: string }): void`
    - `navigate(url: string): void` —— 人在地址栏输入的导航（主进程知道，脚本不知道）
    - `note(text: string): void`
    - `raw(event: RawEvent, observed?: Observation): void` —— `observed` 是该文档预取的 observe 结果，用 `event.index` 对上一行取词
    - `finish(): Trajectory`
    - `get counts(): { steps: number; unsupported: number }` —— 给录制状态条实时显示

归一化规则（每条一个测试）：

1. `page` 产出 `PageEntry`，并 flush 挂起的输入
2. 同一 index 连续 `input` 合并成一条 `type`（最终值），在下列时刻提交：其它元素的任何事件、`select` / `check` / `key` / `click`、`page`、`finish()`
3. `pointer` 后同 index 的 `click` → 一条 `click`（在 click 时产出）；`pointer` 之后没有任何其它事件、直接出现另一 URL 的 `page` → 一条 `click`（页面在 mousedown 就跳走了）；其余情况的 `pointer` 丢弃。不用时间窗：任何别的事件都会清掉挂着的 pointer
4. 同 index 400ms 内的两次 `click` 折叠成一次
5. `secret` → `human` 步骤（`填写密码` 或 `填写验证码`），同 index 连续的只留一条
6. `key` 若目标有挂起的 `type`，先 flush 再产出 `press`
7. `unsupported` → 一条 `human` 步骤，`reason` 说明原来是什么动作，`unsupported` 字段说明原因
8. 对上 `observed` 时（`observed.elements[event.index]` 存在且 `tagName` 一致），目标描述取 observe 那一行（`toStepTarget`），`duplicates > 1` 标 `ambiguous`；否则退回脚本描述，`el.duplicates > 1` 时 `nth = el.position`
9. `event.index >= 200` → `unsupported: 'beyond-observe-limit'`
10. `onUrl` 取最近一条 `page` 的 url；没有则取事件自带的 url

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-recorder.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import { TrajectoryRecorder, type RawEvent } from '../src/main/recording/index';

const URL = 'https://report.example.com/login';
let t = 1_000;
const tick = (ms = 10) => (t += ms);
function recorder() {
  let n = 0;
  return new TrajectoryRecorder({
    name: 'x',
    now: () => new Date(Date.UTC(2026, 8, 20, 6, 3, (n += 1))),
  });
}
const button = { tagName: 'button', role: 'button', name: '登录' };
const email = { tagName: 'input', role: 'textbox', name: '邮箱', inputType: 'email' };
const click = (index: number, el = button, at = tick()): RawEvent => ({ kind: 'click', url: URL, index, el, at });
const pointer = (index: number, el = button, at = tick()): RawEvent => ({ kind: 'pointer', url: URL, index, el, at });
const input = (index: number, value: string, el = email): RawEvent => ({ kind: 'input', url: URL, index, el, value, at: tick() });
function steps(r: TrajectoryRecorder) {
  return r.finish().entries.filter((e) => e.kind === 'step');
}
function observed(rows: { role: string; name: string; tagName: string; inputType?: string; fingerprint?: string }[]): Observation {
  return {
    observationId: 'o',
    tabId: 'tab',
    documentEpoch: 1,
    elements: rows.map((row, i) => {
      const ref: ElementRef = {
        id: `r${i}`,
        tabId: 'tab',
        frameId: 'main',
        documentEpoch: 1,
        frameEpoch: 0,
        localFingerprint: row.fingerprint ?? 'e'.repeat(64),
      };
      return { ref, role: row.role, name: row.name, disabled: false, tagName: row.tagName, inputType: row.inputType };
    }),
  };
}

describe('TrajectoryRecorder', () => {
  it('page 产出页面条目，navigate 与 note 直接成步骤', () => {
    const r = recorder();
    r.navigate(URL);
    r.page({ url: URL, title: '登录', text: '请输入' });
    r.note('这里要用公司邮箱');
    const entries = r.finish().entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page', 'step']);
    expect(entries[0]).toMatchObject({ step: { kind: 'navigate', url: URL } });
    expect(entries[1]).toMatchObject({ kind: 'page', url: URL, title: '登录', text: '请输入' });
    expect(entries[2]).toMatchObject({ step: { kind: 'note', text: '这里要用公司邮箱', onUrl: URL } });
  });

  it('同一输入框的连续 input 合并成一条 type，只留最终值，且 replace 为 true', () => {
    const r = recorder();
    r.page({ url: URL, title: '', text: '' });
    r.raw(input(0, 'm'));
    r.raw(input(0, 'me'));
    r.raw(input(0, 'me@x.com'));
    const result = steps(r);
    expect(result).toHaveLength(1);
    expect(result[0].step).toEqual({
      kind: 'type',
      onUrl: URL,
      target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
      text: 'me@x.com',
      replace: true,
    });
  });

  it('换到别的元素时先提交挂起的输入，顺序保持', () => {
    const r = recorder();
    r.raw(input(0, 'me@x.com'));
    r.raw(click(1));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['type', 'click']);
  });

  it('pointer 紧跟 click 只产出一条 click', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.raw(click(1));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['click']);
  });

  it('pointer 后页面直接跳走也算一次 click', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.page({ url: 'https://report.example.com/dashboard', title: '仪表盘', text: '' });
    const entries = r.finish().entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page']);
    expect(entries[0]).toMatchObject({ step: { kind: 'click', onUrl: URL, target: { name: '登录' } } });
  });

  it('孤立的 pointer 被丢弃', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.raw(input(0, 'a'));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['type']);
  });

  it('400ms 内的双击折叠成一次', () => {
    const r = recorder();
    r.raw(click(1, button, 5_000));
    r.raw(click(1, button, 5_200));
    r.raw(click(1, button, 9_000));
    expect(steps(r)).toHaveLength(2);
  });

  it('secret 产出「需要我」步骤，连续的只留一条，且从不带值', () => {
    const r = recorder();
    const password = { tagName: 'input', role: 'textbox', name: '密码', inputType: 'password' };
    r.raw({ kind: 'secret', url: URL, index: 2, el: password, otp: false, at: tick() });
    r.raw({ kind: 'secret', url: URL, index: 2, el: password, otp: false, at: tick() });
    r.raw({ kind: 'secret', url: URL, index: 3, el: { ...password, name: '验证码', inputType: 'text' }, otp: true, at: tick() });
    const result = steps(r);
    expect(result.map((e) => e.step)).toEqual([
      { kind: 'human', onUrl: URL, reason: '填写密码' },
      { kind: 'human', onUrl: URL, reason: '填写验证码' },
    ]);
  });

  it('Enter 先提交挂起输入再产出 press', () => {
    const r = recorder();
    r.raw(input(0, 'hello'));
    r.raw({ kind: 'key', url: URL, index: 0, el: email, key: 'Enter', shift: false, at: tick() });
    const result = steps(r);
    expect(result.map((e) => e.step.kind)).toEqual(['type', 'press']);
    expect(result[1].step).toMatchObject({ key: 'Enter', modifiers: [] });
  });

  it('Shift 作为唯一支持的修饰键写入 modifiers', () => {
    const r = recorder();
    r.raw({ kind: 'key', url: URL, index: 1, el: button, key: 'Tab', shift: true, at: tick() });
    expect(steps(r)[0].step).toMatchObject({ kind: 'press', key: 'Tab', modifiers: ['Shift'] });
  });

  it('unsupported 变成带原因的「需要我」步骤', () => {
    const r = recorder();
    r.raw({ kind: 'unsupported', url: URL, reason: 'gesture', el: { tagName: 'button', role: 'button', name: '滑块' }, at: tick() });
    r.raw({ kind: 'unsupported', url: URL, reason: 'iframe', at: tick() });
    const result = steps(r);
    expect(result[0]).toMatchObject({ unsupported: 'gesture', step: { kind: 'human', reason: expect.stringContaining('滑块') } });
    expect(result[1]).toMatchObject({ unsupported: 'iframe', step: { kind: 'human' } });
    expect(r.counts).toEqual({ steps: 2, unsupported: 2 });
  });

  it('对上预取的 observe 时用它那一行取词，并带上指纹与 nth', () => {
    const r = recorder();
    const obs = observed([
      { role: 'button', name: '查看', tagName: 'button' },
      { role: 'button', name: '查看', tagName: 'button', fingerprint: 'abcd1234' + '0'.repeat(56) },
    ]);
    r.raw(click(1, { tagName: 'button', role: 'button', name: '看' }), obs);
    const [entry] = steps(r);
    expect(entry.step).toMatchObject({
      kind: 'click',
      target: { role: 'button', name: '查看', tagName: 'button', nth: 2, fingerprint: 'abcd1234' },
    });
    expect(entry.ambiguous).toBe(true);
  });

  it('observe 行的 tagName 对不上时退回脚本描述', () => {
    const r = recorder();
    const obs = observed([{ role: 'link', name: '首页', tagName: 'a' }]);
    r.raw(click(0, button), obs);
    expect(steps(r)[0].step).toMatchObject({ target: { role: 'button', name: '登录', tagName: 'button' } });
  });

  it('脚本描述里的 duplicates/position 变成 nth', () => {
    const r = recorder();
    r.raw(click(3, { ...button, name: '查看', duplicates: 4, position: 3 }));
    expect(steps(r)[0].step).toMatchObject({ target: { name: '查看', nth: 3 } });
    expect(steps(r)[0].step).not.toHaveProperty('target.duplicates');
  });

  it('序号超出 observe 上限标 beyond-observe-limit', () => {
    const r = recorder();
    r.raw(click(250));
    expect(steps(r)[0]).toMatchObject({ unsupported: 'beyond-observe-limit' });
    expect(r.counts.unsupported).toBe(1);
  });

  it('finish 产出的轨迹通过 schema，meta 带名字与时间', () => {
    const r = recorder();
    r.raw(click(1));
    const trajectory = r.finish();
    expect(trajectory.meta).toEqual({ app: 'pilion', version: 1, name: 'x', recordedAt: expect.stringMatching(/^2026-09-20T/) });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-recorder.test.ts`
Expected: FAIL，找不到 `TrajectoryRecorder`

- [ ] **Step 3: 写 `src/main/recording/recorder.ts`**

```ts
import { z } from 'zod';
import type { Observation } from '../browser/types.js';
import { PressKeySchema } from '../../shared/contracts.js';
import { toStepTarget } from './resolve.js';
import {
  TrajectorySchema,
  type Step,
  type StepTarget,
  type Trajectory,
  type TrajectoryEntry,
  UNSUPPORTED_REASONS,
} from './types.js';

/** observe 截断到 200 个元素，序号在此之后的目标回放永远够不到。 */
const OBSERVE_LIMIT = 200;
const DOUBLE_CLICK_MS = 400;

const ElementDescriptionSchema = z
  .object({
    tagName: z.string().min(1).max(40),
    role: z.string().max(120),
    name: z.string().max(400),
    inputType: z.string().max(40).optional(),
    optionValues: z.array(z.string().max(10_000)).max(200).optional(),
    checked: z.boolean().optional(),
    duplicates: z.number().int().min(1).max(10_000).optional(),
    position: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();
type ElementDescription = z.infer<typeof ElementDescriptionSchema>;

const base = {
  url: z.string().max(8192),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  at: z.number(),
};
export const RawEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), ...base }).strict(),
  z.object({ kind: z.literal('click'), ...base }).strict(),
  z.object({ kind: z.literal('input'), ...base, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('select'), ...base, value: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal('check'), ...base, checked: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('key'), ...base, key: PressKeySchema, shift: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('secret'), ...base, otp: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('unsupported'),
      url: z.string().max(8192),
      reason: z.enum(['iframe', 'out-of-scope', 'gesture']),
      el: ElementDescriptionSchema.optional(),
      at: z.number(),
    })
    .strict(),
]);
export type RawEvent = z.infer<typeof RawEventSchema>;

type Pending = { index: number; target: StepTarget; text: string; onUrl: string; ambiguous: boolean };
type Pointer = { index: number; url: string; target: StepTarget; ambiguous: boolean };

function fromDescription(el: ElementDescription): StepTarget {
  return {
    role: el.role,
    name: el.name,
    tagName: el.tagName,
    ...(el.inputType ? { inputType: el.inputType } : {}),
    ...(el.optionValues?.length ? { optionValues: [...el.optionValues] } : {}),
    ...(el.duplicates && el.duplicates > 1 && el.position ? { nth: el.position } : {}),
  };
}

/**
 * 脚本只发原始事件；这里把它们变成人读得懂、player 播得动的步骤。
 * 纯函数式状态机，不碰 Electron，所以中文输入法、双击、mousedown 即跳转这些细节都能用单测钉住。
 */
export class TrajectoryRecorder {
  readonly #name: string;
  readonly #now: () => Date;
  readonly #startedAt: string;
  readonly #entries: TrajectoryEntry[] = [];
  #currentUrl = '';
  #pending: Pending | undefined;
  #pointer: Pointer | undefined;
  #lastClick: { index: number; at: number } | undefined;
  #lastSecretIndex: number | undefined;

  constructor(options: { name: string; now?: () => Date }) {
    this.#name = options.name;
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now().toISOString();
  }

  get counts(): { steps: number; unsupported: number } {
    const steps = this.#entries.filter((entry) => entry.kind === 'step');
    return {
      steps: steps.length + (this.#pending ? 1 : 0),
      unsupported: steps.filter((entry) => entry.unsupported).length,
    };
  }

  page(entry: { url: string; title: string; text: string }): void {
    this.#flushPending();
    this.#flushPointerAsClick(entry.url);
    this.#currentUrl = entry.url;
    this.#entries.push({
      kind: 'page',
      at: this.#stamp(),
      url: entry.url,
      title: entry.title.slice(0, 400),
      text: entry.text.slice(0, 2000),
    });
  }

  navigate(url: string): void {
    this.#flushPending();
    this.#pointer = undefined;
    this.#push({ kind: 'navigate', url });
  }

  note(text: string): void {
    this.#push({ kind: 'note', text: text.slice(0, 2000), ...(this.#currentUrl ? { onUrl: this.#currentUrl } : {}) });
  }

  raw(event: RawEvent, observed?: Observation): void {
    if (event.kind === 'unsupported') {
      this.#flushPending();
      const what = event.el ? `"${event.el.name || event.el.tagName}"` : '页面内嵌框架';
      const why =
        event.reason === 'gesture'
          ? `手动完成在 ${what} 上的拖拽或右键操作`
          : event.reason === 'iframe'
            ? '手动完成内嵌框架里的操作'
            : `手动点击 ${what}`;
      this.#push({ kind: 'human', onUrl: this.#onUrl(event.url), reason: why }, { unsupported: event.reason });
      return;
    }
    const { target, ambiguous } = this.#target(event.el, event.index, observed);
    const onUrl = this.#onUrl(event.url);
    const beyond = event.index >= OBSERVE_LIMIT || event.index < 0;
    if (beyond && event.kind !== 'secret') {
      this.#flushPending();
      this.#push(
        { kind: 'human', onUrl, reason: `手动完成对 "${target.name || target.tagName}" 的操作` },
        { unsupported: 'beyond-observe-limit' },
      );
      return;
    }
    // 点进正在输入的那个框不算换元素；其它任何事件（包括同一字段上的回车）都先提交挂起的输入。
    if (event.kind !== 'input') this.#flushPending(event.kind === 'pointer' ? event.index : undefined);
    if (event.kind !== 'secret') this.#lastSecretIndex = undefined;

    switch (event.kind) {
      case 'pointer':
        this.#pointer = { index: event.index, url: onUrl, target, ambiguous };
        return;
      case 'click': {
        this.#pointer = undefined;
        if (this.#lastClick && this.#lastClick.index === event.index && event.at - this.#lastClick.at <= DOUBLE_CLICK_MS)
          return;
        this.#lastClick = { index: event.index, at: event.at };
        this.#push({ kind: 'click', onUrl, target }, { ambiguous });
        return;
      }
      case 'input':
        if (this.#pending && this.#pending.index !== event.index) this.#flushPending();
        this.#pointer = undefined;
        this.#pending = { index: event.index, target, text: event.value, onUrl, ambiguous };
        return;
      case 'select':
        this.#push({ kind: 'select', onUrl, target, value: event.value }, { ambiguous });
        return;
      case 'check':
        this.#push({ kind: 'check', onUrl, target, checked: event.checked }, { ambiguous });
        return;
      case 'key':
        this.#push(
          { kind: 'press', onUrl, target, key: event.key, modifiers: event.shift ? ['Shift'] : [] },
          { ambiguous },
        );
        return;
      case 'secret':
        if (this.#lastSecretIndex === event.index) return;
        this.#lastSecretIndex = event.index;
        this.#push({ kind: 'human', onUrl, reason: event.otp ? '填写验证码' : '填写密码' });
        return;
    }
  }

  finish(): Trajectory {
    this.#flushPending();
    this.#pointer = undefined;
    return TrajectorySchema.parse({
      meta: { app: 'pilion', version: 1, name: this.#name, recordedAt: this.#startedAt },
      entries: this.#entries,
    });
  }

  #onUrl(eventUrl: string): string {
    return this.#currentUrl || eventUrl || 'about:blank';
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #push(step: Step, marks: { unsupported?: (typeof UNSUPPORTED_REASONS)[number]; ambiguous?: boolean } = {}): void {
    this.#entries.push({
      kind: 'step',
      at: this.#stamp(),
      step,
      ...(marks.unsupported ? { unsupported: marks.unsupported } : {}),
      ...(marks.ambiguous ? { ambiguous: true } : {}),
    });
  }

  /** 挂起的输入在这些时刻提交：别的元素有动作、页面切换、结束。同一元素的 pointer 不提交。 */
  #flushPending(exceptIndex?: number): void {
    const pending = this.#pending;
    if (!pending) return;
    if (exceptIndex !== undefined && exceptIndex === pending.index) return;
    this.#pending = undefined;
    this.#push(
      { kind: 'type', onUrl: pending.onUrl, target: pending.target, text: pending.text, replace: true },
      { ambiguous: pending.ambiguous },
    );
  }

  /** mousedown 之后页面就跳走了：没有 click 事件，但人确实点了。到这里 pointer 还挂着，说明中间没有别的事件。 */
  #flushPointerAsClick(newUrl: string): void {
    const pointer = this.#pointer;
    this.#pointer = undefined;
    if (!pointer || newUrl === pointer.url) return;
    this.#push({ kind: 'click', onUrl: pointer.url, target: pointer.target }, { ambiguous: pointer.ambiguous });
  }

  #target(
    el: ElementDescription,
    index: number,
    observed: Observation | undefined,
  ): { target: StepTarget; ambiguous: boolean } {
    const row = observed?.elements[index];
    if (row && row.tagName === el.tagName) {
      const { target, duplicates } = toStepTarget(row, observed!.elements);
      return { target, ambiguous: duplicates > 1 };
    }
    return { target: fromDescription(el), ambiguous: Boolean(el.duplicates && el.duplicates > 1) };
  }
}
```

- [ ] **Step 4: 在 `src/main/recording/index.ts` 加 `export * from './recorder.js';`**

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-recorder.test.ts`
Expected: PASS，16 个用例全绿。若「pointer 紧跟 click」用例失败，检查 `case 'click'` 里是否在 `#lastClick` 判断之前就清掉了 `#pointer`

- [ ] **Step 6: Commit**

```bash
git add src/main/recording tests/recording-recorder.test.ts
git commit -m "feat(recording): normalise raw page events into trajectory steps

Consecutive input events on one field collapse into a single type step
carrying the final value, which makes IME composition come out right
for free; a pointerdown followed by navigation is a click; double
clicks fold; secrets become human steps and never carry a value."
```

---

### Task 6: 页面适配器的录制通道

**Files:**
- Create: `src/main/browser/recording-channel.ts`
- Modify: `src/main/browser/types.ts`（`BrowserPagePort` 新增两个可选方法）
- Modify: `src/main/browser/electron-page-adapter.ts`（`ElectronPagePort` 实现两个方法）
- Modify: `src/main/browser/index.ts`（加 `export * from './recording-channel.js';`）
- Test: `tests/recording-page-channel.test.ts`

**Interfaces:**
- Consumes: 无新依赖
- Produces:
  - `interface RecordingChannelOptions { script: string; bindingName: string; worldName: string; onMessage(payload: string): void }`
  - `interface CdpLike { sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>; on(listener: CdpListener): void; off(listener: CdpListener): void }`，`type CdpListener = (method: string, params: Record<string, unknown>) => void`
  - `class RecordingChannel { constructor(cdp: CdpLike); start(options): Promise<void>; stop(): Promise<void>; get active(): boolean }`
  - `BrowserPagePort.startRecording?(options: RecordingChannelOptions): Promise<void>`
  - `BrowserPagePort.stopRecording?(): Promise<void>`

CDP 调用顺序（全部是固定命令，只在录制期间开启）：

```
start:
  Page.enable
  Runtime.enable
  Page.addScriptToEvaluateOnNewDocument { source, worldName, runImmediately: true }  → identifier
  Runtime.addBinding { name, executionContextName: worldName }
  Page.getFrameTree                                                                    → frameTree.frame.id
  Page.createIsolatedWorld { frameId, worldName, grantUniveralAccess: false }         → executionContextId
  Runtime.evaluate { expression: source, contextId: executionContextId }
  监听 Runtime.bindingCalled，只转发 name === bindingName 的 payload

stop:
  Runtime.removeBinding { name }
  Page.removeScriptToEvaluateOnNewDocument { identifier }
  Runtime.disable
  取消监听
```

`Page.enable` 不在 stop 时关：`hardenUntrustedContents` 可能依赖 Page 域事件，关了会误伤；Runtime 只有录制用，所以关。（spec「实现前需验证 #1」：若 `executionContextName` 绑不上，兜底是不限定 context 的 binding，并在脚本里带随机 token 做来源校验；本任务先按可以绑上写，E2E 里验证。）

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-page-channel.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { RecordingChannel, type CdpLike, type CdpListener } from '../src/main/browser/index';

function fakeCdp() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const listeners = new Set<CdpListener>();
  const cdp: CdpLike = {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      return {};
    }),
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
  };
  const fire = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener(method, params);
  };
  return { cdp, calls, listeners, fire };
}

const options = {
  script: '(() => {})();',
  bindingName: 'pilion_0123456789abcdef',
  worldName: 'pilion-recorder',
};

describe('RecordingChannel', () => {
  it('start 按固定顺序发命令，并把脚本注入当前文档的隔离世界', async () => {
    const { cdp, calls } = fakeCdp();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage: () => undefined });
    expect(calls.map((call) => call.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.addBinding',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    expect(calls[2].params).toEqual({ source: options.script, worldName: 'pilion-recorder', runImmediately: true });
    expect(calls[3].params).toEqual({ name: options.bindingName, executionContextName: 'pilion-recorder' });
    expect(calls[5].params).toEqual({ frameId: 'frame-main', worldName: 'pilion-recorder', grantUniveralAccess: false });
    expect(calls[6].params).toEqual({ expression: options.script, contextId: 42 });
    expect(channel.active).toBe(true);
  });

  it('只转发自己 binding 名的 bindingCalled', async () => {
    const { cdp, fire } = fakeCdp();
    const onMessage = vi.fn();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage });
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{"kind":"click"}' });
    fire('Runtime.bindingCalled', { name: 'somethingElse', payload: '{"kind":"evil"}' });
    fire('Runtime.consoleAPICalled', { args: [] });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('{"kind":"click"}');
  });

  it('stop 拆掉 binding、脚本与监听，并关掉 Runtime', async () => {
    const { cdp, calls, listeners, fire } = fakeCdp();
    const onMessage = vi.fn();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage });
    calls.length = 0;
    await channel.stop();
    expect(calls.map((call) => call.method)).toEqual([
      'Runtime.removeBinding',
      'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.disable',
    ]);
    expect(calls[0].params).toEqual({ name: options.bindingName });
    expect(calls[1].params).toEqual({ identifier: 'script-1' });
    expect(listeners.size).toBe(0);
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{}' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(channel.active).toBe(false);
  });

  it('重复 start 报错；stop 幂等；拆除时单条命令失败不阻止其余拆除', async () => {
    const { cdp } = fakeCdp();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage: () => undefined });
    await expect(channel.start({ ...options, onMessage: () => undefined })).rejects.toThrow(/已在录制/);
    (cdp.sendCommand as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('target closed');
    });
    await expect(channel.stop()).resolves.toBeUndefined();
    await expect(channel.stop()).resolves.toBeUndefined();
    expect(channel.active).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-page-channel.test.ts`
Expected: FAIL，找不到 `RecordingChannel`

- [ ] **Step 3: 写 `src/main/browser/recording-channel.ts`**

```ts
export type CdpListener = (method: string, params: Record<string, unknown>) => void;

/** 适配器把 webContents.debugger 收窄成这个形状，通道本身不认识 Electron。 */
export interface CdpLike {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(listener: CdpListener): void;
  off(listener: CdpListener): void;
}

export interface RecordingChannelOptions {
  script: string;
  bindingName: string;
  worldName: string;
  onMessage(payload: string): void;
}

/**
 * 录制期间唯一新增的 CDP 面：把一段固定脚本放进隔离世界，并接住它的 binding 回调。
 * 脚本来源只能是 Pilion 自己（Task 4），这里不做任何拼接。
 */
export class RecordingChannel {
  #options: RecordingChannelOptions | undefined;
  #scriptIdentifier: string | undefined;
  #listener: CdpListener | undefined;

  constructor(private readonly cdp: CdpLike) {}

  get active(): boolean {
    return this.#options !== undefined;
  }

  async start(options: RecordingChannelOptions): Promise<void> {
    if (this.#options) throw new Error('该页面已在录制');
    this.#options = options;
    const listener: CdpListener = (method, params) => {
      if (method !== 'Runtime.bindingCalled') return;
      if (params.name !== options.bindingName || typeof params.payload !== 'string') return;
      options.onMessage(params.payload);
    };
    this.#listener = listener;
    try {
      await this.cdp.sendCommand('Page.enable');
      await this.cdp.sendCommand('Runtime.enable');
      const added = (await this.cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: options.script,
        worldName: options.worldName,
        runImmediately: true,
      })) as { identifier: string };
      this.#scriptIdentifier = added.identifier;
      await this.cdp.sendCommand('Runtime.addBinding', {
        name: options.bindingName,
        executionContextName: options.worldName,
      });
      this.cdp.on(listener);
      const tree = (await this.cdp.sendCommand('Page.getFrameTree')) as {
        frameTree: { frame: { id: string } };
      };
      const world = (await this.cdp.sendCommand('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: options.worldName,
        grantUniveralAccess: false,
      })) as { executionContextId: number };
      await this.cdp.sendCommand('Runtime.evaluate', {
        expression: options.script,
        contextId: world.executionContextId,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** 每一步都尽力执行；页面已经销毁时命令会失败，但监听与状态仍要清干净。 */
  async stop(): Promise<void> {
    const options = this.#options;
    if (!options) return;
    this.#options = undefined;
    if (this.#listener) this.cdp.off(this.#listener);
    this.#listener = undefined;
    const attempt = async (method: string, params?: Record<string, unknown>) => {
      try {
        await this.cdp.sendCommand(method, params);
      } catch {
        /* target may already be gone */
      }
    };
    await attempt('Runtime.removeBinding', { name: options.bindingName });
    if (this.#scriptIdentifier)
      await attempt('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: this.#scriptIdentifier,
      });
    this.#scriptIdentifier = undefined;
    await attempt('Runtime.disable');
  }
}
```

- [ ] **Step 4: `BrowserPagePort` 加两个可选方法**

在 `src/main/browser/types.ts` 的 `BrowserPagePort` 接口里，`setLifecycleListener` 之前加：

```ts
  /** 录制期间把 Pilion 自己的固定脚本放进隔离世界；页面 JS 看不到它。可选：只有 Electron 适配器实现。 */
  startRecording?(options: RecordingChannelOptions): Promise<void>;
  stopRecording?(): Promise<void>;
```

并在文件顶部加 `import type { RecordingChannelOptions } from './recording-channel.js';`。

- [ ] **Step 5: `ElectronPagePort` 实现**

在 `src/main/browser/electron-page-adapter.ts`：

import 加 `import { RecordingChannel, type RecordingChannelOptions } from './recording-channel.js';`

类里加一个字段与两个方法（放在 `close()` 之前）：

```ts
  #recording: RecordingChannel | undefined;

  async startRecording(options: RecordingChannelOptions): Promise<void> {
    const dbg = this.view.webContents.debugger;
    const listeners = new Map<CdpListener, (event: unknown, method: string, params: unknown) => void>();
    const cdp: CdpLike = {
      sendCommand: (method, params) => dbg.sendCommand(method, params),
      on: (listener) => {
        const wrapped = (_event: unknown, method: string, params: unknown) =>
          listener(method, (params ?? {}) as Record<string, unknown>);
        listeners.set(listener, wrapped);
        dbg.on('message', wrapped);
      },
      off: (listener) => {
        const wrapped = listeners.get(listener);
        if (wrapped) dbg.removeListener('message', wrapped);
        listeners.delete(listener);
      },
    };
    this.#recording = new RecordingChannel(cdp);
    await this.#recording.start(options);
  }

  async stopRecording(): Promise<void> {
    const channel = this.#recording;
    this.#recording = undefined;
    await channel?.stop();
  }
```

import 里补 `type CdpLike, type CdpListener`。在 `close()` 里（现有方法体开头）加 `void this.stopRecording();`，页面销毁时不留 binding。

- [ ] **Step 6: `src/main/browser/index.ts` 加 `export * from './recording-channel.js';`**

- [ ] **Step 7: 跑测试与类型检查**

Run: `pnpm vitest run tests/recording-page-channel.test.ts tests/browser-service.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错误

- [ ] **Step 8: Commit**

```bash
git add src/main/browser tests/recording-page-channel.test.ts
git commit -m "feat(browser): recording channel that injects the fixed script into an isolated world

Fixed CDP commands only, enabled for the duration of a recording and
torn down on stop or page close. The channel is Electron-agnostic so
the command order and the binding filter are unit tested."
```

---

### Task 7: 录制编排、互斥、状态与 IPC

**Files:**
- Modify: `src/shared/contracts.ts`（类型、schema、IPC channel）
- Modify: `src/main/recording/library.ts`（`RecordingSummary` 改为从 shared 导入并 re-export）
- Modify: `src/main/host/durable-store.ts`（公开 `recordEvent`）
- Modify: `src/preload/index.ts`（`recording` 与 `skills` 两组）
- Modify: `src/main/main.ts`（编排）
- Test: `tests/host-store.test.ts`（加一个用例）

**Interfaces:**
- Consumes: Task 1–6 全部
- Produces（给 Task 9、10 用）:
  - `AppState.recording?: RecordingState`、`AppState.skills?: RecordingSummary[]`、`AppState.replay?: ReplayState`
  - `SkillDetail`
  - `IPC.recordingStart/recordingStop/recordingNote/skillsRead/skillsRemove/skillsRename/skillsShow/skillsPlay/skillsResume/skillsStop`
  - preload：`window.pilion.recording.{start, stop(name), note(text)}`、`window.pilion.skills.{read, remove, rename, show, play, resume, stop}`
  - main.ts：`startRecording()`、`stopRecording(name)`、`recording` 状态变量、`library`、`refreshSkills()`

- [ ] **Step 1: `shared/contracts.ts` 加类型与 schema**

在 `ChromeCookieImportResult` 之后加：

```ts
export interface RecordingSummary {
  id: string;
  name: string;
  steps: number;
  unsupported: number;
  needsHuman: number;
  recordedAt: string;
  /** 文件读不出来时的原因；有它的行不能播放，但仍然列出来让人去修。 */
  error?: string;
}
export interface RecordingState {
  tabId: string;
  steps: number;
  unsupported: number;
  startedAt: string;
}
export interface ReplayState {
  id: string;
  name: string;
  /** 1 起，当前正在执行或刚停在的步骤。 */
  step: number;
  total: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  /** paused 时是需要人做的事；failed 时是原因。 */
  message?: string;
  nextStep?: number;
}
export interface SkillDetail {
  id: string;
  name: string;
  recordedAt: string;
  markdown: string;
  steps: { index: number; kind: string; text: string; unsupported?: string; ambiguous?: boolean }[];
}
export const RecordingStopSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();
export const RecordingNoteSchema = z
  .object({ text: z.string().trim().min(1).max(2000) })
  .strict();
export const SkillPlaySchema = z
  .object({
    id: z.string().min(1).max(60),
    fromStep: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
export const SkillRenameSchema = z
  .object({ id: z.string().min(1).max(60), name: z.string().trim().min(1).max(120) })
  .strict();
```

`AppState` 里 `permissionMode?: PermissionMode;` 之后加：

```ts
  recording?: RecordingState;
  skills?: RecordingSummary[];
  replay?: ReplayState;
```

`IPC` 对象里 `agentSetModel` 之后加：

```ts
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingNote: 'recording:note',
  skillsRead: 'skills:read',
  skillsRemove: 'skills:remove',
  skillsRename: 'skills:rename',
  skillsShow: 'skills:show',
  skillsPlay: 'skills:play',
  skillsResume: 'skills:resume',
  skillsStop: 'skills:stop',
```

- [ ] **Step 2: `library.ts` 改用 shared 的 `RecordingSummary`**

删除 Task 3 里本地定义的 `export interface RecordingSummary {...}`，改为：

```ts
import type { RecordingSummary } from '../../shared/contracts.js';
export type { RecordingSummary };
```

Run: `pnpm vitest run tests/recording-library.test.ts` → 仍 PASS

- [ ] **Step 3: `durable-store.ts` 公开 `recordEvent`，并写测试**

在 `tests/host-store.test.ts` 末尾加一个用例（store 的构造方式照本文件其它用例，用 `grep -n "new DurableHostStore" tests/host-store.test.ts` 找到那一行照抄）：

```ts
it('recordEvent 把不属于 action 生命周期的事实写进 events 与 outbox', () => {
  const store = new DurableHostStore({ path: ':memory:' });
  const events = store.count('events');
  const outbox = store.count('outbox');
  store.recordEvent('recording', 'tab-1', 'recording.started', { startedAt: '2026-09-20T06:00:00Z' });
  expect(store.count('events')).toBe(events + 1);
  expect(store.count('outbox')).toBe(outbox + 1);
  expect(store.pendingOutbox(50).at(-1)?.payload).toMatchObject({
    aggregateType: 'recording',
    eventType: 'recording.started',
  });
  store.close();
});
```

Run: `pnpm vitest run tests/host-store.test.ts` → 新用例 FAIL（`recordEvent is not a function`）

在 `src/main/host/durable-store.ts` 的 `createSession` 之前加：

```ts
  /** 录制开始与停止、人工回放这类不属于 action 生命周期的事实，也要进台账。 */
  recordEvent(aggregateType: string, aggregateId: string, eventType: string, payload: unknown): void {
    this.transaction(() => this.event(aggregateType, aggregateId, eventType, payload));
  }
```

Run: `pnpm vitest run tests/host-store.test.ts` → PASS

- [ ] **Step 4: preload 白名单**

`src/preload/index.ts` 的 import 里加 `SkillDetail`（录制状态与技能列表都走 `AppState`，不需要额外类型）：

```ts
import type {
  AgentConfig,
  AppState,
  BrowserViewport,
  PermissionMode,
  ChromeCookieImportResult,
  ChromeCookieSources,
  SkillDetail,
} from '../shared/contracts.js';
```

`agents: Object.freeze({...})` 之后、`});` 之前加：

```ts
  recording: Object.freeze({
    start: () => ipcRenderer.invoke(IPC.recordingStart),
    /** 返回保存后的技能 id；没有录到任何步骤时返回 undefined。 */
    stop: (name: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.recordingStop, { name }),
    note: (text: string) => ipcRenderer.invoke(IPC.recordingNote, { text }),
  }),
  skills: Object.freeze({
    read: (id: string): Promise<SkillDetail> => ipcRenderer.invoke(IPC.skillsRead, { id }),
    remove: (id: string) => ipcRenderer.invoke(IPC.skillsRemove, { id }),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC.skillsRename, { id, name }),
    show: (id: string) => ipcRenderer.invoke(IPC.skillsShow, { id }),
    play: (id: string, fromStep?: number) => ipcRenderer.invoke(IPC.skillsPlay, { id, fromStep }),
    resume: () => ipcRenderer.invoke(IPC.skillsResume),
    stop: () => ipcRenderer.invoke(IPC.skillsStop),
  }),
```

- [ ] **Step 5: `main.ts` 录制编排**

import 加：

```ts
import {
  RECORDER_WORLD,
  RawEventSchema,
  RecordingLibrary,
  TrajectoryRecorder,
  buildRecorderScript,
  describeStep,
  type RecordingSummary,
} from './recording/index.js';
import type { Observation } from './browser/types.js';
```

从 `../shared/contracts.js` 的 import 里加 `RecordingNoteSchema`、`RecordingStopSchema`、`SkillRenameSchema`、`SkillPlaySchema`、`type SkillDetail`。

在 `const databasePath = ...` 之后加：

```ts
const recordingsPath = () => join(app.getPath('userData'), 'recordings');
```

在 `let promptCancelled = false;` 之后加状态：

```ts
type ActiveRecording = {
  tabId: string;
  recorder: TrajectoryRecorder;
  startedAt: string;
  /** 该文档预取的 observe 结果，用来给步骤取词；文档一换就清。 */
  observed?: Observation;
  observing?: Promise<void>;
  lastPageUrl?: string;
  /** 脚本消息与页面条目串行处理，顺序就是人的顺序。 */
  queue: Promise<void>;
};
let recording: ActiveRecording | undefined;
let library: RecordingLibrary;
let skills: RecordingSummary[] = [];
```

`state()` 里 `permissionMode:` 之后加：

```ts
  recording: recording
    ? {
        tabId: recording.tabId,
        steps: recording.recorder.counts.steps,
        unsupported: recording.recorder.counts.unsupported,
        startedAt: recording.startedAt,
      }
    : undefined,
  skills,
```

（`replay` 字段在 Task 9 加。）

在 `recordHandover` 函数之后加编排函数：

```ts
function autoRecordingName(): string {
  return `录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
}

async function refreshSkills(): Promise<void> {
  skills = await library.list();
  emit();
}

/** 只有人能开录制：入口只有可信 Renderer 的 IPC，MCP 里没有这个动词。 */
async function startRecording(): Promise<void> {
  if (recording) throw new Error('已经在录制了');
  if (isAgentBrowserActive() || promptActive || taskRunning())
    throw new Error('Agent 正在执行任务，先停止或接管后再录制');
  const tabId = requireActiveTab();
  const page = browser.registry.get(tabId).page;
  if (!page.startRecording) throw new Error('当前页面不支持录制');
  const bindingName = `pilion_${randomBytes(8).toString('hex')}`;
  const active: ActiveRecording = {
    tabId,
    recorder: new TrajectoryRecorder({ name: '未命名录制' }),
    startedAt: new Date().toISOString(),
    queue: Promise.resolve(),
  };
  recording = active;
  try {
    await page.startRecording({
      script: buildRecorderScript(bindingName),
      bindingName,
      worldName: RECORDER_WORLD,
      onMessage: (payload) => enqueueRecordingEvent(active, payload),
    });
  } catch (error) {
    recording = undefined;
    throw error;
  }
  const model = pages.get(tabId)?.model;
  if (model && model.url !== HOME && !model.loading) {
    active.lastPageUrl = model.url;
    active.queue = active.queue.then(() => recordPageEntry(active, tabId)).catch(() => undefined);
  }
  store.recordEvent('recording', tabId, 'recording.started', { startedAt: active.startedAt });
  log('开始录制');
  emit();
}

function enqueueRecordingEvent(active: ActiveRecording, payload: string): void {
  active.queue = active.queue
    .then(async () => {
      if (recording !== active) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const parsed = RawEventSchema.safeParse(raw);
      if (!parsed.success) return;
      await active.observing?.catch(() => undefined);
      active.recorder.raw(parsed.data, active.observed);
      emit();
    })
    .catch(() => undefined);
}

/** 页面加载完成：记 URL、标题与正文摘录，并预取一次 observe 供后续步骤取词。 */
async function recordPageEntry(active: ActiveRecording, tabId: string): Promise<void> {
  if (recording !== active || !browser.registry.has(tabId)) return;
  const page = browser.registry.get(tabId).page;
  const snapshot = await page.snapshot();
  const text = (await page.readText?.().catch(() => '')) ?? '';
  active.recorder.page({ url: snapshot.url, title: snapshot.title, text });
  active.observed = undefined;
  active.observing = browser
    .observe({ principalId: USER_PRINCIPAL, tabId })
    .then((observation) => {
      if (recording === active) active.observed = observation;
    })
    .catch(() => undefined);
  emit();
}

/** 停止并保存。没有录到步骤时不建文件，返回 undefined。 */
async function stopRecording(name: string): Promise<string | undefined> {
  const active = recording;
  if (!active) throw new Error('当前没有在录制');
  recording = undefined;
  const page = browser.registry.has(active.tabId)
    ? browser.registry.get(active.tabId).page
    : undefined;
  await page?.stopRecording?.().catch(() => undefined);
  await active.queue.catch(() => undefined);
  const trajectory = active.recorder.finish();
  const hasSteps = trajectory.entries.some((entry) => entry.kind === 'step');
  const id = hasSteps ? await library.create(name, trajectory) : undefined;
  store.recordEvent('recording', active.tabId, 'recording.stopped', {
    id,
    entries: trajectory.entries.length,
  });
  log(id ? `录制已保存：${name}` : '录制结束，没有记录到任何步骤');
  await refreshSkills();
  return id;
}

async function skillDetail(id: string): Promise<SkillDetail> {
  const { trajectory, markdown } = await library.read(id);
  let index = 0;
  return {
    id,
    name: trajectory.meta.name,
    recordedAt: trajectory.meta.recordedAt,
    markdown,
    steps: trajectory.entries.flatMap((entry) =>
      entry.kind === 'step'
        ? [
            {
              index: (index += 1),
              kind: entry.step.kind,
              text: describeStep(entry.step),
              ...(entry.unsupported ? { unsupported: entry.unsupported } : {}),
              ...(entry.ambiguous ? { ambiguous: true } : {}),
            },
          ]
        : [],
    ),
  };
}
```

- [ ] **Step 6: 挂钩：页面加载、地址栏导航、切标签、关标签、崩溃、退出、工具互斥**

`sync(tabId)` 里，`if (!item.model.loading) workspace.visit({...});` 之后加：

```ts
  if (
    recording?.tabId === tabId &&
    !item.model.loading &&
    item.model.url !== HOME &&
    item.model.url !== recording.lastPageUrl
  ) {
    const active = recording;
    active.lastPageUrl = item.model.url;
    active.queue = active.queue.then(() => recordPageEntry(active, tabId)).catch(() => undefined);
  }
```

`handle(IPC.tabNavigate, ...)` 改为：

```ts
  handle(IPC.tabNavigate, NavigateInputSchema, async (value) => {
    const tabId = requireActiveTab();
    const result = await browser.navigate({ principalId: USER_PRINCIPAL, tabId, url: value.url });
    if (recording?.tabId === tabId) {
      recording.recorder.navigate(result.url);
      emit();
    }
    return result;
  });
```

`activateTab(tabId, principal)` 开头加：

```ts
  if (recording && recording.tabId !== tabId)
    void stopRecording(autoRecordingName()).catch((error) => {
      lastError = `录制保存失败：${readable(error)}`;
      emit();
    });
```

`closeTab(tabId, principal)` 开头加同样一段，条件改为 `recording?.tabId === tabId`。

把 `model.crashed` 置为 true 的那个事件处理里（`grep -n "crashed = true" src/main/main.ts`）加同样一段，条件 `recording?.tabId === tabId`。

`shutdown()` 里 `draining = true;` 之后加：

```ts
  if (recording) await stopRecording(autoRecordingName()).catch(() => undefined);
```

`executeTool(request)` 第一行之前加：

```ts
  if (recording) throw new Error('用户正在录制，浏览器工具暂不可用');
```

`handle(IPC.agentTask, ...)` 是单行箭头函数，守卫放进它调用的 `executeAgentTask(text, resuming)` 函数体第一行（在 `const current = requireAttachment();` 之前）；`handle(IPC.agentResume, ...)` 的函数体第一行加同一句：

```ts
  if (recording) throw new Error('正在录制，请先停止录制再发送任务');
```

- [ ] **Step 7: IPC handler 与初始化**

在 `init()` 里创建 `store` 之后（`grep -n "store = new DurableHostStore" src/main/main.ts`）加：

```ts
  library = new RecordingLibrary(recordingsPath());
  skills = await library.list().catch(() => []);
```

在 `handle(IPC.agentSetModel, ...)` 附近加：

```ts
  handle(IPC.recordingStart, undefined, () => startRecording());
  handle(IPC.recordingStop, RecordingStopSchema, (value) => stopRecording(value.name));
  handle(IPC.recordingNote, RecordingNoteSchema, (value) => {
    if (!recording) throw new Error('当前没有在录制');
    recording.recorder.note(value.text);
    emit();
  });
  handle(IPC.skillsRead, IdInputSchema, (value) => skillDetail(value.id));
  handle(IPC.skillsRemove, IdInputSchema, async (value) => {
    await library.remove(value.id);
    await refreshSkills();
  });
  handle(IPC.skillsRename, SkillRenameSchema, async (value) => {
    await library.rename(value.id, value.name);
    await refreshSkills();
  });
  handle(IPC.skillsShow, IdInputSchema, (value) => shell.showItemInFolder(library.path(value.id)));
```

（`skillsPlay` / `skillsResume` / `skillsStop` 在 Task 9 注册。为了让 typecheck 通过，本任务先不在 preload 之外引用它们 —— preload 只是字符串 channel，不影响。）

- [ ] **Step 8: 类型检查、全部单测、lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿

- [ ] **Step 9: 手动冒烟（可选但建议）**

Run: `pnpm dev`，在任意网页上从开发者工具 console 调 `window.pilion.recording.start()`，点几个链接，`window.pilion.recording.stop('冒烟')`，检查 `~/Library/Application Support/Pilion/recordings/冒烟/trajectory.md` 存在且时间线可读。

- [ ] **Step 10: Commit**

```bash
git add src/shared/contracts.ts src/main/recording/library.ts src/main/host/durable-store.ts src/preload/index.ts src/main/main.ts tests/host-store.test.ts
git commit -m "feat(recording): record a person's actions on the active tab into a trajectory

Recording is human-only: it starts from the trusted renderer's IPC and
the MCP surface has no verb for it. While a recording runs, every
browser tool call is refused and sending a task is refused, because a
dispatched click is isTrusted too and would be recorded as the
person's. Switching or closing the tab, a crash and quitting all stop
and save."
```

---

### Task 8: 回放状态机 `player.ts`

**Files:**
- Create: `src/main/recording/player.ts`
- Modify: `src/main/recording/index.ts`（加 `export * from './player.js';`）
- Test: `tests/recording-player.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`（Task 2）、`describeStep`（Task 1）、`ToolName`（contracts）、`Observation` / `PageSnapshot`（browser/types）
- Produces:
  - `type PlayerExecute = (name: ToolName, args: Record<string, unknown>) => Promise<unknown>`
  - `type PlayOutcome`（三种：成功 / 需要人 / 失败）
  - `playSteps(steps: ReadonlyArray<Step>, options: PlayOptions): Promise<PlayOutcome>`
  - `samePage(a: string, b: string): boolean`

player 不认识 Electron，也不认识 Host：它只会调 `execute('browser.observe')` 之类，把匹配到的 `elementRef` 原样交回 `execute('browser.click', { elementRef })`。所以 Intent、审批、指纹校验、蒙层全都在 `execute` 后面，与 Agent 完全一样。

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-player.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import type { ToolName } from '../src/shared/contracts';
import { playSteps, samePage, type Step } from '../src/main/recording/index';

const LOGIN = 'https://report.example.com/login';
const DASH = 'https://report.example.com/dashboard';

function ref(id: string): ElementRef {
  return { id, tabId: 'tab', frameId: 'main', documentEpoch: 1, frameEpoch: 0, localFingerprint: 'f'.repeat(64) };
}
function obs(rows: { id: string; role: string; name: string; tagName: string }[]): Observation {
  return {
    observationId: 'o',
    tabId: 'tab',
    documentEpoch: 1,
    elements: rows.map((row) => ({ ref: ref(row.id), role: row.role, name: row.name, disabled: false, tagName: row.tagName })),
  };
}

/** 一个会“跟着操作走”的假浏览器：navigate 换页，点击「登录」跳到 dashboard。 */
function fakeBrowser() {
  let url = 'about:blank';
  let loading = false;
  const calls: { name: ToolName; args: Record<string, unknown> }[] = [];
  const pages: Record<string, Observation> = {
    [LOGIN]: obs([
      { id: 'email', role: 'textbox', name: '邮箱', tagName: 'input' },
      { id: 'login', role: 'button', name: '登录', tagName: 'button' },
    ]),
    [DASH]: obs([
      { id: 'month', role: 'combobox', name: '月份', tagName: 'select' },
      { id: 'export', role: 'button', name: '导出 CSV', tagName: 'button' },
    ]),
  };
  const execute = vi.fn(async (name: ToolName, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'browser.snapshot') return { url, title: url === LOGIN ? '登录' : '仪表盘', loading };
    if (name === 'browser.navigate') {
      url = String(args.url);
      loading = false;
      return { url };
    }
    if (name === 'browser.observe') return pages[url] ?? obs([]);
    if (name === 'browser.click') {
      if ((args.elementRef as ElementRef).id === 'login') {
        url = DASH;
        loading = true;
        setTimeout(() => (loading = false), 5);
      }
      return { ok: true };
    }
    return { ok: true };
  });
  return { execute, calls, current: () => url };
}

const steps: Step[] = [
  { kind: 'navigate', url: LOGIN },
  { kind: 'type', onUrl: LOGIN, target: { role: 'textbox', name: '邮箱', tagName: 'input' }, text: 'me@x.com', replace: true },
  { kind: 'note', text: '公司邮箱' },
  { kind: 'click', onUrl: LOGIN, target: { role: 'button', name: '登录', tagName: 'button' } },
  { kind: 'select', onUrl: DASH, target: { role: 'combobox', name: '月份', tagName: 'select' }, value: '2026-09' },
  { kind: 'click', onUrl: DASH, target: { role: 'button', name: '导出 CSV', tagName: 'button' } },
];
// 用真的定时器而不是立即 resolve：假浏览器靠 setTimeout 把 loading 翻回 false，纯微任务循环会饿死它。
const fast = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1))), settleMs: 200 };

describe('samePage', () => {
  it('比 origin 与 path，忽略 query、hash 与末尾斜杠', () => {
    expect(samePage('https://a.com/x?y=1#z', 'https://a.com/x/')).toBe(true);
    expect(samePage('https://a.com/x', 'https://a.com/y')).toBe(false);
    expect(samePage('https://a.com/', 'https://b.com/')).toBe(false);
    expect(samePage('not a url', 'https://a.com/')).toBe(false);
  });
});

describe('playSteps', () => {
  it('全程成功：每个动作前先 observe，把匹配到的 ref 原样交回', async () => {
    const browser = fakeBrowser();
    const progress: number[] = [];
    const outcome = await playSteps(steps, { execute: browser.execute, ...fast, onProgress: (step) => progress.push(step) });
    expect(outcome).toEqual({ ok: true, steps: 6, finalUrl: DASH });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    const names = browser.calls.map((call) => call.name);
    expect(names.filter((name) => name === 'browser.observe')).toHaveLength(4);
    const typeCall = browser.calls.find((call) => call.name === 'browser.type')!;
    expect(typeCall.args).toEqual({ elementRef: ref('email'), text: 'me@x.com', replace: true });
    const selectCall = browser.calls.find((call) => call.name === 'browser.select')!;
    expect(selectCall.args).toMatchObject({ elementRef: ref('month'), value: '2026-09' });
  });

  it('页面不对时停下并报 WRONG_PAGE，附上剩余步骤', async () => {
    const browser = fakeBrowser();
    const outcome = await playSteps(steps.slice(1), { execute: browser.execute, ...fast });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'WRONG_PAGE',
      failedAt: 1,
      step: '输入 "邮箱" = "me@x.com"',
      url: 'about:blank',
      remaining: ['备注：公司邮箱', '点击 "登录"（button）', '选择 "月份" = "2026-09"', '点击 "导出 CSV"（button）'],
    });
  });

  it('找不到目标时报 NO_MATCH 并停在那一步', async () => {
    const browser = fakeBrowser();
    const renamed: Step[] = [steps[0], { ...steps[3], target: { role: 'button', name: '进入', tagName: 'button' } } as Step];
    const outcome = await playSteps(renamed, { execute: browser.execute, ...fast });
    expect(outcome).toMatchObject({ ok: false, reason: 'NO_MATCH', failedAt: 2, step: '点击 "进入"（button）', url: LOGIN, title: '登录' });
  });

  it('需要人的步骤返回 HUMAN 与位置，不再继续', async () => {
    const browser = fakeBrowser();
    const withHuman: Step[] = [steps[0], { kind: 'human', onUrl: LOGIN, reason: '填写密码' }, steps[3]];
    const outcome = await playSteps(withHuman, { execute: browser.execute, ...fast });
    expect(outcome).toEqual({ ok: false, reason: 'HUMAN', at: 2, step: '需要我：填写密码', humanReason: '填写密码', url: LOGIN, title: '登录' });
    expect(browser.calls.some((call) => call.name === 'browser.click')).toBe(false);
  });

  it('fromStep 从中间续播，不重跑前面', async () => {
    const browser = fakeBrowser();
    await browser.execute('browser.navigate', { url: DASH });
    browser.calls.length = 0;
    const outcome = await playSteps(steps, { execute: browser.execute, ...fast, fromStep: 5 });
    expect(outcome).toEqual({ ok: true, steps: 6, finalUrl: DASH });
    expect(browser.calls.some((call) => call.name === 'browser.navigate')).toBe(false);
    expect(browser.calls.filter((call) => call.name === 'browser.click')).toHaveLength(1);
  });

  it('取消信号让回放停下并报 CANCELLED', async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    const execute: typeof browser.execute = vi.fn(async (name, args) => {
      if (name === 'browser.type') controller.abort();
      return browser.execute(name, args);
    });
    const outcome = await playSteps(steps, { execute, ...fast, signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, reason: 'CANCELLED', failedAt: 3 });
  });

  it('执行动作抛错时报 EFFECT_FAILED 并带上错误信息', async () => {
    const browser = fakeBrowser();
    const execute: typeof browser.execute = vi.fn(async (name, args) => {
      if (name === 'browser.type') throw new Error('STALE_ELEMENT: Element identity changed');
      return browser.execute(name, args);
    });
    const outcome = await playSteps(steps, { execute, ...fast });
    expect(outcome).toMatchObject({ ok: false, reason: 'EFFECT_FAILED', failedAt: 2, message: expect.stringContaining('STALE_ELEMENT') });
  });

  it('点击后等页面加载完再做下一步', async () => {
    const browser = fakeBrowser();
    const outcome = await playSteps(steps, { execute: browser.execute, settleMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    expect(outcome.ok).toBe(true);
    const order = browser.calls.map((call) => call.name);
    const clickIndex = order.indexOf('browser.click');
    expect(order.slice(clickIndex + 1, clickIndex + 3)).toEqual(['browser.snapshot', 'browser.snapshot']);
  });

  it('总预算耗尽报 TIMEOUT', async () => {
    const browser = fakeBrowser();
    let now = 0;
    const outcome = await playSteps(steps, { execute: browser.execute, ...fast, budgetMs: 100, now: () => (now += 60) });
    expect(outcome).toMatchObject({ ok: false, reason: 'TIMEOUT' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-player.test.ts`
Expected: FAIL，找不到 `playSteps`

- [ ] **Step 3: 写 `src/main/recording/player.ts`**

```ts
import type { Observation, PageSnapshot } from '../browser/types.js';
import type { ToolName } from '../../shared/contracts.js';
import { describeStep } from './format.js';
import { resolveTarget } from './resolve.js';
import type { Step } from './types.js';

export type PlayerExecute = (name: ToolName, args: Record<string, unknown>) => Promise<unknown>;
export type PlayFailure = 'WRONG_PAGE' | 'NO_MATCH' | 'AMBIGUOUS' | 'EFFECT_FAILED' | 'TIMEOUT' | 'CANCELLED';
export type PlayOutcome =
  | { ok: true; steps: number; finalUrl: string }
  | { ok: false; reason: 'HUMAN'; at: number; step: string; humanReason: string; url: string; title: string }
  | {
      ok: false;
      reason: PlayFailure;
      failedAt: number;
      step: string;
      url: string;
      title: string;
      remaining: string[];
      message?: string;
    };

export interface PlayOptions {
  execute: PlayerExecute;
  /** 1 起。 */
  fromStep?: number;
  signal?: AbortSignal;
  /** 整场预算，留在 10 分钟 prompt 上限内。 */
  budgetMs?: number;
  /** 导航或点击之后等 loading 变 false 的上限。 */
  settleMs?: number;
  onProgress?(step: number, total: number): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const DEFAULT_BUDGET_MS = 4 * 60_000;
const DEFAULT_SETTLE_MS = 15_000;
const SETTLE_POLL_MS = 200;

/** 前置条件只比 origin 与 path；query 与 hash 常随会话变化，不该让回放停下。 */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/';
    return left.origin === right.origin && path(left) === path(right);
  } catch {
    return false;
  }
}

const TOOL_FOR: Record<'click' | 'type' | 'select' | 'check' | 'press', ToolName> = {
  click: 'browser.click',
  type: 'browser.type',
  select: 'browser.select',
  check: 'browser.check',
  press: 'browser.press',
};

function effectArgs(step: Step): Record<string, unknown> {
  switch (step.kind) {
    case 'type':
      return { text: step.text, replace: true };
    case 'select':
      return { value: step.value };
    case 'check':
      return { checked: step.checked };
    case 'press':
      return { key: step.key, modifiers: step.modifiers };
    default:
      return {};
  }
}

/**
 * 逐步执行：断言页面 → observe → 匹配 → 用与 Agent 相同的工具执行。
 * 任何一步解析不到目标就停下并把现场交出去，不猜。
 */
export async function playSteps(steps: ReadonlyArray<Step>, options: PlayOptions): Promise<PlayOutcome> {
  const execute = options.execute;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const total = steps.length;
  let lastUrl = '';

  const snapshot = async (): Promise<PageSnapshot> =>
    (await execute('browser.snapshot', {})) as PageSnapshot;
  const settle = async () => {
    await sleep(50);
    const until = now() + settleMs;
    for (;;) {
      const current = await snapshot();
      lastUrl = current.url;
      if (!current.loading || now() >= until) return current;
      await sleep(SETTLE_POLL_MS);
    }
  };
  const remaining = (index: number) => steps.slice(index).map(describeStep);
  const fail = async (
    index: number,
    reason: PlayFailure,
    step: Step,
    message?: string,
    page?: PageSnapshot,
  ): Promise<PlayOutcome> => {
    const current = page ?? (await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false })));
    return {
      ok: false,
      reason,
      failedAt: index,
      step: describeStep(step),
      url: current.url,
      title: current.title,
      remaining: remaining(index),
      ...(message ? { message } : {}),
    };
  };

  for (let index = options.fromStep ?? 1; index <= total; index += 1) {
    const step = steps[index - 1];
    options.onProgress?.(index, total);
    if (options.signal?.aborted) return fail(index, 'CANCELLED', step);
    if (now() > deadline) return fail(index, 'TIMEOUT', step);
    if (step.kind === 'note') continue;
    if (step.kind === 'human') {
      const current = await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false }));
      return {
        ok: false,
        reason: 'HUMAN',
        at: index,
        step: describeStep(step),
        humanReason: step.reason,
        url: current.url,
        title: current.title,
      };
    }
    if (step.kind === 'navigate') {
      try {
        await execute('browser.navigate', { url: step.url });
      } catch (error) {
        return fail(index, 'EFFECT_FAILED', step, error instanceof Error ? error.message : String(error));
      }
      await settle();
      continue;
    }
    const page = await snapshot();
    lastUrl = page.url;
    if (!samePage(page.url, step.onUrl)) return fail(index, 'WRONG_PAGE', step, undefined, page);
    const observation = (await execute('browser.observe', {})) as Observation;
    const resolved = resolveTarget(step.target, observation);
    if (!resolved.ok) return fail(index, resolved.reason, step, undefined, page);
    if (options.signal?.aborted) return fail(index, 'CANCELLED', step, undefined, page);
    try {
      await execute(TOOL_FOR[step.kind], { elementRef: resolved.ref, ...effectArgs(step) });
    } catch (error) {
      return fail(index, 'EFFECT_FAILED', step, error instanceof Error ? error.message : String(error), page);
    }
    if (step.kind === 'click' || step.kind === 'press') await settle();
  }
  const finalPage = await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false }));
  return { ok: true, steps: total, finalUrl: finalPage.url };
}
```

- [ ] **Step 4: 在 `src/main/recording/index.ts` 加 `export * from './player.js';`**

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-player.test.ts`
Expected: PASS。若「取消信号」用例的 `failedAt` 不是 3：取消发生在第 2 步的 `browser.type` 里，第 2 步已经执行完，循环到第 3 步（note）开头检测到 aborted → `failedAt: 3`。若实现里在 `note` 之前没有检查 aborted，就会错

- [ ] **Step 6: Commit**

```bash
git add src/main/recording tests/recording-player.test.ts
git commit -m "feat(recording): replay trajectory steps through the ordinary tool path

The player only ever calls browser.observe and the five effect tools
with the ref observe returned, so intents, approvals, fingerprint
revalidation and the shield all apply unchanged. Any step whose target
cannot be resolved stops the run and hands the scene over."
```

---

### Task 9: 本地 principal 与人工回放编排

**Files:**
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: `playSteps` / `PlayOutcome`（Task 8）、`store.createSession` / `createAttachment` / `transitionAttachment` / `recordEvent`（Host）、`executeTool`（既有）
- Produces:
  - `type Actor`，`runTool(request, actor)`、`executeTool(request, actor?)`、`executePreparedAction({ current: Actor })` 的签名收窄
  - `startReplay(id, fromStep)`、`resumeReplay()`、`stopReplay()`、`replay` 状态、`AppState.replay`
  - IPC：`skillsPlay` / `skillsResume` / `skillsStop`

**为什么要本地 principal**：`runTool` 第一行是 `requireAttachment()`，Intent 与执行凭证都挂在 `sessionId / attachmentId / connectionEpoch` 上。人工回放没有 Agent 连接，就需要 Host 里有一个属于 `local-user` 的 session 与 attachment。浏览器侧的 `USER_PRINCIPAL = 'local-user'` 已经是所有标签的 owner，`authorizeBrowserPrincipal` 对它直接放行，所以只差 Host 这两行。每次回放一个 attachment，审计里读得出「这一段是人工回放」。

不接受「复用当前 Agent 的 attachment」：那会把人的操作记在 Agent 名下。

- [ ] **Step 1: 把 `runTool` 的执行者参数化**

在 `type Connection` 之后加：

```ts
/** runTool 需要的最小身份：Agent 连接与人工回放的本地 principal 都满足它。 */
type Actor = {
  principal: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
};
```

`executeTool` 改为：

```ts
async function executeTool(request: ToolRequest, actor?: Actor): Promise<unknown> {
  if (recording) throw new Error('用户正在录制，浏览器工具暂不可用');
  if (!actor && promptCancelled) throw new Error('任务已停止，浏览器操作已取消');
  if (!actor && toolExecutions === 0 && agentStatus === 'ready') {
    restoreReadyAfterTools = true;
    agentStatus = 'running';
  }
  toolExecutions += 1;
  emit();
  try {
    return await runTool(request, actor ?? requireAttachment());
  } finally {
    toolExecutions = Math.max(0, toolExecutions - 1);
    if (toolExecutions === 0 && restoreReadyAfterTools) {
      restoreReadyAfterTools = false;
      if (agentStatus === 'running' && !taskRunning()) agentStatus = 'ready';
    }
    emit();
  }
}
async function runTool(request: ToolRequest, actor: Actor): Promise<unknown> {
  const who = actor.principal === USER_PRINCIPAL ? '回放' : 'Agent';
  log(`${who} 正在执行：${request.name}`);
  const current = actor;
  if (request.name === 'browser.request_human') {
    if (actor.principal === USER_PRINCIPAL) throw new Error('人工回放不能调用 request_human');
    // ……原有 request_human 分支不变
```

原函数体里其余对 `current` 的引用（`current.principal`、`current.sessionId`、`current.attachmentId`、`current.connectionEpoch`）保持不动，因为 `current` 现在就是 `actor`。删除原来的 `const current = requireAttachment();` 那一行。

`executePreparedAction` 的参数类型 `current: Connection & { attachmentId: string }` 改为 `current: Actor`。`Connection & { attachmentId: string }` 结构上满足 `Actor`，其它调用处不用改。

Run: `pnpm typecheck` → 无错误

- [ ] **Step 2: 本地 principal**

在 `let skills: RecordingSummary[] = [];` 之后加：

```ts
let localSession: { sessionId: string; capabilitySnapshotHash: string } | undefined;

/** 人工回放用的 Host 身份：一次会话一个 session，一次回放一个 attachment，台账里与 Agent 分得开。 */
function acquireLocalActor(): Actor & { release(): void } {
  if (!localSession) {
    const sessionId = randomUUID();
    const capabilitySnapshotHash = sha256('local-replay');
    store.createSession({
      sessionId,
      profileId: PROFILE_ID,
      principal: USER_PRINCIPAL,
      agentId: 'local-user',
      connectionEpoch: 1,
      capabilitySnapshotHash,
    });
    localSession = { sessionId, capabilitySnapshotHash };
  }
  const attachmentId = randomUUID();
  store.createAttachment({
    attachmentId,
    sessionId: localSession.sessionId,
    principal: USER_PRINCIPAL,
    agentId: 'local-user',
    role: 'owner',
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    connectionEpoch: 1,
    capabilitySnapshotHash: localSession.capabilitySnapshotHash,
  });
  return {
    principal: USER_PRINCIPAL,
    sessionId: localSession.sessionId,
    attachmentId,
    connectionEpoch: 1,
    capabilitySnapshotHash: localSession.capabilitySnapshotHash,
    release: () => {
      try {
        store.transitionAttachment(attachmentId, 'detached');
      } catch {
        /* already terminal */
      }
    },
  };
}
```

`sha256` 已从 `./host/index.js` 导入（`grep -n "sha256" src/main/main.ts` 确认）。

- [ ] **Step 3: 回放编排**

import 里加 `playSteps, type PlayOutcome, type Step`（从 `./recording/index.js`）。

在 `acquireLocalActor` 之后加：

```ts
type ActiveReplay = {
  id: string;
  steps: Step[];
  actor: ReturnType<typeof acquireLocalActor>;
  abort: AbortController;
  state: ReplayState;
};
let replay: ActiveReplay | undefined;

function replayRunning(): boolean {
  return replay?.state.status === 'running';
}

async function startReplay(id: string, fromStep = 1): Promise<void> {
  if (replayRunning()) throw new Error('已有技能在回放');
  if (recording) throw new Error('正在录制，无法回放');
  if (isAgentBrowserActive() || promptActive || taskRunning())
    throw new Error('Agent 正在执行任务，无法回放');
  requireActiveTab();
  const { trajectory } = await library.read(id);
  const steps = trajectory.entries.flatMap((entry) => (entry.kind === 'step' ? [entry.step] : []));
  if (!steps.length) throw new Error('这份录制没有可回放的步骤');
  if (fromStep > steps.length) throw new Error('起始步骤超出范围');
  replay?.actor.release();
  const actor = acquireLocalActor();
  const active: ActiveReplay = {
    id,
    steps,
    actor,
    abort: new AbortController(),
    state: { id, name: trajectory.meta.name, step: fromStep, total: steps.length, status: 'running' },
  };
  replay = active;
  store.recordEvent('replay', id, 'replay.started', { fromStep, attachmentId: actor.attachmentId });
  log(`开始回放：${trajectory.meta.name}`);
  emit();
  void runReplay(active, fromStep);
}

async function runReplay(active: ActiveReplay, fromStep: number): Promise<void> {
  const outcome: PlayOutcome = await playSteps(active.steps, {
    fromStep,
    signal: active.abort.signal,
    execute: (name, args) =>
      executeTool(
        ToolRequestSchema.parse({ requestId: randomUUID(), name, args, timeoutMs: 15_000 }),
        active.actor,
      ),
    onProgress: (step) => {
      active.state.step = step;
      emit();
    },
  }).catch(
    (error): PlayOutcome => ({
      ok: false,
      reason: 'EFFECT_FAILED',
      failedAt: active.state.step,
      step: '',
      url: '',
      title: '',
      remaining: [],
      message: readable(error),
    }),
  );
  if (replay !== active) return;
  if (outcome.ok) {
    active.state.status = 'done';
    active.state.step = outcome.steps;
    active.state.message = undefined;
  } else if (outcome.reason === 'HUMAN') {
    active.state.status = 'paused';
    active.state.message = outcome.humanReason;
    active.state.nextStep = outcome.at + 1;
  } else if (outcome.reason === 'CANCELLED') {
    active.state.status = 'failed';
    active.state.message = '已停止';
  } else {
    active.state.status = 'failed';
    active.state.message = `第 ${outcome.failedAt} 步失败（${outcome.reason}）：${outcome.step}${
      outcome.message ? ` — ${outcome.message}` : ''
    }`;
  }
  store.recordEvent('replay', active.id, `replay.${active.state.status}`, {
    step: active.state.step,
    reason: outcome.ok ? undefined : outcome.reason,
  });
  if (active.state.status !== 'paused') active.actor.release();
  log(
    active.state.status === 'done'
      ? `回放完成：${active.state.name}`
      : active.state.status === 'paused'
        ? `回放暂停，需要你：${active.state.message}`
        : `回放失败：${active.state.message}`,
  );
  emit();
}

function resumeReplay(): void {
  const active = replay;
  if (!active || active.state.status !== 'paused' || !active.state.nextStep)
    throw new Error('没有等待继续的回放');
  if (active.state.nextStep > active.steps.length) {
    active.state.status = 'done';
    active.state.step = active.steps.length;
    active.actor.release();
    emit();
    return;
  }
  active.state.status = 'running';
  active.state.step = active.state.nextStep;
  active.state.message = undefined;
  emit();
  void runReplay(active, active.state.nextStep);
}

/** 运行中：中止；已结束：收起。两种情况都释放本地 attachment。 */
function stopReplay(): void {
  const active = replay;
  if (!active) return;
  if (active.state.status === 'running') {
    active.abort.abort();
    return;
  }
  active.actor.release();
  replay = undefined;
  emit();
}
```

`ReplayState` 从 `../shared/contracts.js` 导入类型。

- [ ] **Step 4: 状态、蒙层、互斥、退出**

`state()` 里 `skills,` 之后加 `replay: replay?.state,`。

`syncAgentShield()` 里 `const active = isAgentBrowserActive();` 改为：

```ts
  const active = isAgentBrowserActive() || replayRunning();
```

`currentAgentActivityPhase()` 在 `replayRunning()` 时返回 `'act'`（函数开头加 `if (replayRunning()) return 'act';`）。

`startRecording()` 的互斥判断里加 `if (replayRunning()) throw new Error('正在回放技能，无法同时录制');`。

`executeAgentTask(text)` 函数体第一行加 `if (replayRunning()) throw new Error('正在回放技能，请先停止回放');`（与 Task 7 的录制守卫并排）。

回放跟着当前标签走，人切走就停。`activateTab(tabId)` 开头，在录制的自动停止之后加 `if (replayRunning() && tabId !== activeTabId) stopReplay();`；`closeTab(tabId)` 开头加 `if (replayRunning() && tabId === activeTabId) stopReplay();`。

`shutdown()` 里录制停止之后加 `stopReplay();`。

- [ ] **Step 5: IPC handler**

在 Task 7 注册的 handler 之后加：

```ts
  handle(IPC.skillsPlay, SkillPlaySchema, (value) => startReplay(value.id, value.fromStep));
  handle(IPC.skillsResume, undefined, () => resumeReplay());
  handle(IPC.skillsStop, undefined, () => stopReplay());
```

`skillsRemove` 的 handler 第一行加：`if (replay?.id === value.id && replayRunning()) throw new Error('正在回放，无法删除');`

- [ ] **Step 6: 类型检查、全部单测**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿。特别看 `tests/host-grants.test.ts` 与 `tests/integration-security.test.ts` 没有因为 `runTool` 签名变化受影响（它们不直接调 `main.ts`，预期不受影响）

- [ ] **Step 7: 手动验证 Host 接受本地 attachment（spec「实现前需验证 #3」）**

Run: `pnpm dev`，用 Task 7 冒烟录下的技能，在技能库页点播放（Task 10 之前可从 console 调 `window.pilion.skills.play('冒烟')`）。观察：
- 蒙层升起，步骤逐个执行，`state.replay.status` 走到 `done`
- 若 `store.prepareExecution` 对本地 attachment 抛 `INVALID_STATE_TRANSITION` 或 `LEASE_EXPIRED`：按 spec 的兜底，本地回放改用长期存在的 local session，不复用 attachment 状态机，并在本任务的 commit 里说明

- [ ] **Step 8: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(recording): replay a trajectory as the local user without an Agent

runTool now takes its actor instead of reaching for the Agent
connection, so a replay runs under a local-user session and attachment
in the host ledger rather than being written up as the Agent's work.
The shield rises during replay; recording, replay and Agent tasks are
mutually exclusive in the main process, not only in the UI."
```

---

### Task 10: 界面：录制控件、红框、技能库、回放条

**Files:**
- Create: `src/renderer/SkillLibrary.tsx`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/style.css`

**Interfaces:**
- Consumes: `AppState.recording / skills / replay`、`window.pilion.recording.*`、`window.pilion.skills.*`（Task 7、9）
- Produces: `Surface` 联合类型多一个 `'skills'`

界面只渲染主进程快照，不本地推断。录制 = 红点 + 红框，不挡输入；回放 = 现有蒙层 + 底部「正在回放」条，挡输入。两者必须一眼分得开。

- [ ] **Step 1: `Surface` 与左栏入口**

`src/renderer/main.tsx:79` 改为：

```ts
type Surface = 'browser' | 'settings' | 'bookmarks' | 'history' | 'downloads' | 'conversations' | 'skills';
```

lucide import 里加 `Clapperboard, Circle, Square`。左栏 `下载` 按钮之后加：

```tsx
          <button
            className={surface === 'skills' ? 'selected' : ''}
            onClick={() => selectSurface('skills')}
          >
            <Clapperboard size={17} />
            技能库
            {(state.skills?.length ?? 0) > 0 ? <span className="nav-count">{state.skills!.length}</span> : null}
          </button>
```

- [ ] **Step 2: 工具栏录制按钮与录制条**

组件顶部 state 里加：

```ts
  const [noteText, setNoteText] = useState('');
  const [naming, setNaming] = useState(false);
  const [recordingName, setRecordingName] = useState('');
  const recordingActive = Boolean(state.recording);
  const replayRunning = state.replay?.status === 'running';
```

工具栏里 cookie 导入按钮之前加：

```tsx
            <IconButton
              type="button"
              label={recordingActive ? '停止录制' : '开始录制'}
              title={recordingActive ? '停止录制' : '录制我的操作，之后可以回放'}
              className={recordingActive ? 'recording-icon' : ''}
              disabled={agentDriving || replayRunning || home}
              onClick={() => {
                if (recordingActive) {
                  setRecordingName(`录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
                  setNaming(true);
                } else void run(() => window.pilion.recording.start());
              }}
            >
              {recordingActive ? <Square size={15} fill="currentColor" /> : <Circle size={15} />}
            </IconButton>
```

`{browserTools && surface === 'browser' ? (...) : null}` 那段之前加录制条：

```tsx
        {state.recording && surface === 'browser' ? (
          <div className="recording-bar" role="status" aria-live="polite">
            <span className="recording-dot" aria-hidden="true" />
            <strong>录制中 · {state.recording.steps} 步</strong>
            {state.recording.unsupported > 0 ? (
              <span className="recording-warn" title="这些步骤回放不了，提炼时会变成「需要我」">
                {state.recording.unsupported} 步回放不了
              </span>
            ) : null}
            {naming ? (
              <form
                className="recording-name"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await run(() => window.pilion.recording.stop(recordingName))) {
                    setNaming(false);
                    setNoteText('');
                  }
                }}
              >
                <input
                  autoFocus
                  aria-label="录制名称"
                  value={recordingName}
                  onChange={(event) => setRecordingName(event.target.value)}
                  maxLength={120}
                />
                <button type="submit" className="secondary-button" disabled={!recordingName.trim()}>
                  保存
                </button>
                <button type="button" className="text-button" onClick={() => setNaming(false)}>
                  继续录
                </button>
              </form>
            ) : (
              <form
                className="recording-note"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!noteText.trim()) return;
                  if (await run(() => window.pilion.recording.note(noteText))) setNoteText('');
                }}
              >
                <input
                  aria-label="录制旁白"
                  placeholder="加一句旁白，例如：这里要选上个月"
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  maxLength={2000}
                />
              </form>
            )}
          </div>
        ) : null}
```

`.page-area` 的 `className` 改为 ``className={`page-area ${state.recording ? 'recording' : ''}`}``。

- [ ] **Step 3: 底部回放条**

footer 里，`) : manual ? (` 之前插入一个分支（放在 Agent 操作指示器分支之前，因为回放时 Agent 不活跃）：

```tsx
          {state.replay ? (
            <div
              className={`agent-operation-indicator is-replay ${state.replay.status}`}
              role="status"
            >
              <Play size={14} />
              <span className="agent-operation-copy">
                <strong>
                  {state.replay.status === 'running'
                    ? `正在回放「${state.replay.name}」 ${state.replay.step}/${state.replay.total}`
                    : state.replay.status === 'paused'
                      ? `需要你：${state.replay.message}`
                      : state.replay.status === 'done'
                        ? `回放完成「${state.replay.name}」`
                        : `回放失败`}
                </strong>
                {state.replay.status === 'failed' && state.replay.message ? (
                  <span className="agent-operation-detail">{state.replay.message}</span>
                ) : null}
              </span>
              {state.replay.status === 'paused' ? (
                <button
                  className="take-over"
                  aria-label="继续回放"
                  onClick={() => void run(() => window.pilion.skills.resume())}
                >
                  <Play size={14} />
                  继续
                </button>
              ) : null}
              <button
                aria-label={state.replay.status === 'running' ? '停止回放' : '关闭'}
                onClick={() => void run(() => window.pilion.skills.stop())}
              >
                <CircleStop size={14} />
                {state.replay.status === 'running' ? '停止' : '关闭'}
              </button>
            </div>
          ) : agentDriving ? (
```

（原来的 `agentDriving ? (` 分支开头改成 `) : agentDriving ? (` 接在这个分支后面；保持原有 JSX 结构，只是多了一个前置分支。）

- [ ] **Step 4: 技能库页面 `SkillLibrary.tsx`**

```tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Clapperboard, FolderOpen, Pencil, Play, Trash, TriangleAlert } from 'lucide-react';
import type { RecordingSummary, SkillDetail } from '../shared/contracts.js';

type Props = {
  skills: RecordingSummary[];
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<unknown>;
  /** 播放前切回网页视图，蒙层与回放条在那里。 */
  onPlay(id: string): void;
};

export function SkillLibrary({ skills, busy, run, onPlay }: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(skills[0]?.id);
  const [detail, setDetail] = useState<SkillDetail | undefined>();
  const [tab, setTab] = useState<'steps' | 'trajectory'>('steps');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];

  useEffect(() => {
    if (!selected || selected.error) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    void window.pilion.skills
      .read(selected.id)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch(() => {
        if (!cancelled) setDetail(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="library-surface skills-surface">
      <header className="surface-header">
        <div>
          <span className="eyebrow">工作区</span>
          <h1>技能库</h1>
        </div>
      </header>
      {skills.length === 0 ? (
        <div className="empty-list">
          <Clapperboard size={30} />
          <h2>还没有录制</h2>
          <p>在任意网页点工具栏的 ● 开始录制你的操作，停止后会出现在这里。</p>
        </div>
      ) : (
        <div className="skills-layout">
          <div className="skills-list" role="list">
            {skills.map((item) => (
              <button
                role="listitem"
                key={item.id}
                className={`library-row ${item.id === selected?.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setRenaming(false);
                }}
              >
                <Clapperboard size={18} />
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.error
                      ? '文件读不出来'
                      : `${item.steps} 步${item.needsHuman ? ` · 需人工 ${item.needsHuman}` : ''}${
                          item.unsupported ? ` · ${item.unsupported} 步回放不了` : ''
                        }`}
                  </span>
                </div>
                {item.error || item.unsupported ? <TriangleAlert size={16} className="warn" /> : null}
              </button>
            ))}
          </div>
          {selected ? (
            <section className="skills-detail" aria-label={selected.name}>
              <header>
                {renaming ? (
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (await run(() => window.pilion.skills.rename(selected.id, name))) setRenaming(false);
                    }}
                  >
                    <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} aria-label="技能名称" />
                    <button type="submit" className="secondary-button" disabled={!name.trim()}>
                      保存
                    </button>
                    <button type="button" className="text-button" onClick={() => setRenaming(false)}>
                      取消
                    </button>
                  </form>
                ) : (
                  <h2>
                    {selected.name}
                    <button className="text-button" aria-label="改名" onClick={() => { setName(selected.name); setRenaming(true); }}>
                      <Pencil size={14} />
                    </button>
                  </h2>
                )}
                <div className="surface-header-actions">
                  <button className="secondary-button" disabled={busy || Boolean(selected.error)} onClick={() => onPlay(selected.id)}>
                    <Play size={16} />
                    播放
                  </button>
                  <button className="text-button" onClick={() => void run(() => window.pilion.skills.show(selected.id))}>
                    <FolderOpen size={16} />
                    在 Finder 中显示
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`删除「${selected.name}」？轨迹文件会一起删除。`))
                        void run(() => window.pilion.skills.remove(selected.id));
                    }}
                  >
                    <Trash size={16} />
                    删除
                  </button>
                </div>
              </header>
              {selected.error ? (
                <p className="skills-error">{selected.error}</p>
              ) : (
                <>
                  <div className="skills-tabs" role="tablist">
                    <button role="tab" aria-selected={tab === 'steps'} onClick={() => setTab('steps')}>
                      步骤
                    </button>
                    <button role="tab" aria-selected={tab === 'trajectory'} onClick={() => setTab('trajectory')}>
                      轨迹
                    </button>
                  </div>
                  {tab === 'steps' ? (
                    <ol className="skills-steps">
                      {detail?.steps.map((step) => (
                        <li key={step.index} className={step.unsupported ? 'unsupported' : step.ambiguous ? 'ambiguous' : ''}>
                          <span className="step-index">{step.index}</span>
                          <span className="step-text">{step.text}</span>
                          {step.unsupported ? <span className="step-mark">回放不了：{step.unsupported}</span> : null}
                          {step.ambiguous ? <span className="step-mark">录制时目标描述不唯一</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="skills-trajectory">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail?.markdown ?? ''}</ReactMarkdown>
                    </div>
                  )}
                </>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
```

`ReactMarkdown` 的用法照 `src/renderer/ChatMessage.tsx`（`grep -n "ReactMarkdown" src/renderer/ChatMessage.tsx`），特别是它是否禁用了原始 HTML —— 沿用同一套 props。

- [ ] **Step 5: 在 `main.tsx` 接入技能库页面**

`surface === 'downloads' ? (...)` 分支之前加：

```tsx
          ) : surface === 'skills' ? (
            <SkillLibrary
              skills={state.skills ?? []}
              busy={busy}
              run={run}
              onPlay={(id) => {
                setSurface('browser');
                void run(() => window.pilion.skills.play(id));
              }}
            />
```

顶部 `import { SkillLibrary } from './SkillLibrary.js';`（照其它组件 import 的写法，`grep -n "from './Downloads\|from './AgentSettings" src/renderer/main.tsx` 看是否带 `.js`）。

- [ ] **Step 6: CSS**

`src/renderer/style.css` 末尾加：

```css
/* 录制：红点 + 红框，不挡输入。与回放（蒙层）必须一眼分得开。 */
.recording-icon {
  color: var(--danger);
}
.recording-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--danger-soft);
  color: var(--text);
  font-size: 13px;
}
.recording-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  animation: recording-pulse 1.2s ease-in-out infinite;
}
@keyframes recording-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .recording-dot {
    animation: none;
  }
}
.recording-warn {
  color: var(--danger);
}
.recording-note,
.recording-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.recording-note input,
.recording-name input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--input);
  color: var(--text);
}
.page-area.recording::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--danger);
  pointer-events: none;
  z-index: 1;
}

/* 回放条 */
.agent-operation-indicator.is-replay.paused {
  border-color: var(--accent-border);
}
.agent-operation-indicator.is-replay.failed {
  border-color: var(--danger);
}

/* 技能库 */
.skills-layout {
  display: grid;
  grid-template-columns: minmax(200px, 280px) 1fr;
  gap: 16px;
  min-height: 0;
}
@media (max-width: 760px) {
  .skills-layout {
    grid-template-columns: 1fr;
  }
}
.skills-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.library-row.selected {
  background: var(--accent-soft);
}
.library-row .warn {
  color: var(--danger);
}
.skills-detail > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.skills-detail h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 18px;
}
.skills-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.skills-tabs [aria-selected='true'] {
  color: var(--accent);
  border-bottom: 2px solid var(--accent);
}
.skills-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skills-steps li {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
}
.skills-steps li.unsupported {
  background: var(--danger-soft);
}
.skills-steps li.ambiguous .step-mark {
  color: var(--muted);
}
.skills-steps .step-index {
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.skills-steps .step-mark {
  grid-column: 2;
  font-size: 12px;
  color: var(--danger);
}
.skills-trajectory {
  max-height: 60vh;
  overflow: auto;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}
.skills-error {
  color: var(--danger);
}
.text-button.danger {
  color: var(--danger);
}
```

- [ ] **Step 7: 类型检查、lint、手动走一遍**

Run: `pnpm typecheck && pnpm lint && pnpm dev`

手动：开录制 → 红点与红框出现、计数随点击增长 → 加一句旁白 → 停止并命名 → 左栏技能库出现计数 → 打开技能库，看到步骤与轨迹两个标签 → 播放 → 回到网页，蒙层升起，底部回放条走步数 → 完成后「关闭」。再测：Agent 执行中录制按钮禁用；录制中发任务被拒且原因显示在输入框上方；窄窗口（< 760px）技能库单列。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/SkillLibrary.tsx src/renderer/main.tsx src/renderer/style.css
git commit -m "feat(recording): record button, live recording bar, skill library and replay bar

Recording shows as a red dot with a live step count and a red frame
drawn in the trusted renderer, never inside the page, so it cannot be
faked or screenshotted. Replay keeps the existing shield and a bottom
bar with progress, stop and resume. The library lists, renames,
deletes, reveals and plays trajectories; step editing is second phase."
```

---

### Task 11: Electron E2E、架构文档、更新日志

**Files:**
- Modify: `tests/electron.e2e.ts`（新增一个 test）
- Modify: `docs/architecture.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: 全部前序任务的 IPC 与状态

E2E 只能用真实网络上的 `https://example.com`（现有 E2E 就这么做；本机回环被 URL 策略挡掉，仓库里也没有 fixture 静态服务器）。所以录一条 `navigate → click "Learn more"` 的两步轨迹就够：它证明「录 → 存 → 不连 Agent 回放 → 页面真的到了 iana.org」这条闭环。`type` / `select` / `press` 的行为由 Task 4、5、8 的单测钉住。

Playwright 会把每个 WebContentsView 也列在 `application.windows()` 里（文件顶部注释已说明），对它 `click('a')` 走的是 CDP `Input.dispatchMouseEvent`，`isTrusted` 为 true，与人点一样会被录到。

- [ ] **Step 1: 写 E2E**

在 `tests/electron.e2e.ts` 末尾加：

```ts
test('a person records a click, saves it as a skill, and replays it without an Agent', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const state = () => shell.evaluate(() => window.pilion.getState());

  // 录制只能由人（可信 Renderer）开启；开启后 Agent 任务被拒。
  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);
  await expect(shell.evaluate(() => window.pilion.agents.task('hi'))).rejects.toThrow(/录制/);

  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().startsWith('https://example.com')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  // 地址栏导航是第 1 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);

  await tabPage!.click('a');
  await expect.poll(() => tabPage!.url(), { timeout: 30_000 }).toContain('iana.org');
  // 人的点击是第 2 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(2);

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 点击'));
  expect(id).toBe('e2e-点击');
  await expect.poll(async () => (await state()).recording).toBeUndefined();
  await expect.poll(async () => (await state()).skills?.map((item) => item.id)).toEqual(['e2e-点击']);
  const detail = await shell.evaluate((skillId) => window.pilion.skills.read(skillId), id!);
  expect(detail.steps.map((step) => step.kind)).toEqual(['navigate', 'click']);
  expect(detail.steps[1].text).toMatch(/点击 "Learn more"/);
  expect(detail.markdown).toContain('```json pilion-trajectory');

  // 换一个空标签回放，证明它自己走到了 iana.org，且过程中蒙层（Agent 活动相位）升起。
  await shell.evaluate(() => window.pilion.tabs.open());
  await expect.poll(async () => (await state()).tabs.length).toBe(2);
  await shell.evaluate((skillId) => window.pilion.skills.play(skillId), id!);
  await expect.poll(async () => (await state()).replay?.status).toBe('running');
  await expect.poll(async () => (await state()).replay?.status, { timeout: 60_000 }).toBe('done');
  const after = await state();
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('iana.org');
  expect(after.replay).toMatchObject({ step: 2, total: 2 });

  // 关闭回放条；技能删得掉。
  await shell.evaluate(() => window.pilion.skills.stop());
  await expect.poll(async () => (await state()).replay).toBeUndefined();
  await shell.evaluate((skillId) => window.pilion.skills.remove(skillId), id!);
  await expect.poll(async () => (await state()).skills?.length).toBe(0);
});

test('replay stops at a step whose target is gone and reports where', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 直接写一份手工轨迹进技能库：第 2 步的按钮在 example.com 上不存在。
  const dir = join(profileDirectory, 'recordings', 'gone');
  await mkdir(dir, { recursive: true });
  const trajectory = {
    meta: { app: 'pilion', version: 1, name: 'gone', recordedAt: '2026-09-20T06:00:00.000Z' },
    entries: [
      { kind: 'step', at: '2026-09-20T06:00:01.000Z', step: { kind: 'navigate', url: 'https://example.com/' } },
      {
        kind: 'step',
        at: '2026-09-20T06:00:02.000Z',
        step: {
          kind: 'click',
          onUrl: 'https://example.com/',
          target: { role: 'button', name: '不存在的按钮', tagName: 'button' },
        },
      },
    ],
  };
  await writeFile(
    join(dir, 'trajectory.md'),
    `# gone\n\n\`\`\`json pilion-trajectory\n${JSON.stringify(trajectory, null, 2)}\n\`\`\`\n`,
  );
  // 技能库在启动时读过一次；改名会触发重读，这里用 rename 到同名让主进程刷新列表。
  await shell.evaluate(() => window.pilion.skills.rename('gone', 'gone'));
  await expect.poll(async () => (await state()).skills?.some((item) => item.id === 'gone')).toBe(true);

  await shell.evaluate(() => window.pilion.skills.play('gone'));
  await expect.poll(async () => (await state()).replay?.status, { timeout: 60_000 }).toBe('failed');
  const after = await state();
  expect(after.replay?.message).toMatch(/第 2 步失败（NO_MATCH）：点击 "不存在的按钮"/);
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('example.com');
});
```

第二个用例依赖 `rename('gone','gone')` 能对一个尚未被 `list()` 见过的目录生效：`library.rename` 只调 `read` 与 `write`，都按 id 直接访问路径，不依赖缓存，所以可行；随后 `refreshSkills()` 重新枚举目录。

- [ ] **Step 2: 跑 E2E**

Run: `pnpm test:e2e`
Expected: 新增两个用例 PASS，原有用例不受影响。若第一个用例在「人的点击是第 2 步」处超时：
- 检查 `Runtime.bindingCalled` 是否到达（在 `enqueueRecordingEvent` 临时加 `console.log`），没到就是 spec「实现前需验证 #1」的情况，按其兜底改 binding 方式
- 到了但 `steps` 仍是 1：看 `RawEventSchema.safeParse` 的 issues，多半是脚本描述里多了 schema 没有的字段
- 若本机 E2E 抖动，先 `uptime` 看负载（memory 里记过两次是外部负载造成）

- [ ] **Step 3: 架构文档**

`docs/architecture.md`：

「模块」表加两行：

```
| `main/recording`                    | 录制脚本、轨迹归一化、目标匹配、回放状态机、技能库目录 |
| `renderer/SkillLibrary.tsx`         | 技能库：列表、步骤、轨迹、播放、改名、删除             |
```

在「原生视图」一节之后加一节：

```markdown
## 录制与技能

人可以录制自己在当前标签上的操作，得到一份行为轨迹；轨迹是 `recordings/<slug>/trajectory.md` 里的一个 ```json pilion-trajectory 代码块，上方的时间线由它渲染、加载时忽略。步骤只有 `navigate / click / type / select / check / press / human / note` 八种，目标用角色、可访问名、标签、输入类型、同名序号与指纹前缀描述，不含任何只有 Pilion 认得的句柄；`ElementRef` 不落盘，因为它的三层身份（标签、文档 epoch、CDP nodeId）都是一次性的。

录制只能由人从可信 Renderer 开启，MCP 里没有这个动词。录制期间，`browser/recording-channel.ts` 用固定 CDP 命令把 Pilion 自带的脚本放进名为 `pilion-recorder` 的隔离世界（`Page.createIsolatedWorld` 与 `Page.addScriptToEvaluateOnNewDocument`），通过随机命名的 `Runtime.addBinding` 回传。脚本只收 `isTrusted` 事件、只描述元素、永不 `preventDefault`、永不等主进程；密码与一次性验证码字段只产出「需要我」步骤，值与长度都不离开页面。归一化（连续输入合并、mousedown 即跳转合成点击、双击折叠、超纲标记）全部在主进程 `recording/recorder.ts` 完成。每个文档加载完成时主进程预取一次 `observe()`，步骤的角色与名字从它那一行取，和回放走同一条 AX 路径。

因为 `Input.dispatchMouseEvent` 派发的事件 `isTrusted` 也为 true，录制、回放与 Agent 任务在主进程里互斥：录制期间所有浏览器工具直接拒绝，发任务被拒并说明原因。切标签、关标签、页面崩溃与退出都会先停止并保存。录制中界面显示红点、实时步数与由可信 Renderer 画的红框；红框不进页面，因此不会出现在截图里。

回放不新增元素身份通道：`recording/player.ts` 只是主进程里的一个 `ToolRequest` 调用方，每步 `browser.observe` → `resolve()` → `browser.click` 等，与 Agent 走同一条 `runTool` 路径，因此 Intent 台账、指纹重校验、epoch fencing、蒙层与取消链路全部沿用。`resolve()` 按指纹前缀、精确、归一化名字、同名序号、select 选项交集五级降级，每级要求唯一命中，全部落空就停下并交出现场。人工回放以 `local-user` 的 Host session 与 attachment 执行，台账里与 Agent 分得开；`human` 步骤把回放转为暂停，人完成后点继续从下一步续播。

第二期：Agent 把轨迹提炼成技能文档（四条对账保证不凭空造步骤）、`browser.skills.list` / `browser.skills.play`、首次回放审批与卡住交还。
```

「原生视图」一节末段（`grep -n "网页没有 preload" docs/architecture.md`）里那句「网页没有 preload 和 Node 权限。」改成：

```
网页没有 preload 和 Node 权限；唯一例外是录制期间，Pilion 自带的固定脚本运行在页面看不到的隔离世界里，只读事件、不改页面，停止录制即移除。
```

「验证」一节加一句：

```
`pnpm test` 另覆盖轨迹格式往返、目标匹配五级降级、录制脚本的 isTrusted 与密码过滤、归一化状态机、录制通道的命令顺序与回放状态机；`pnpm test:e2e` 覆盖真实录制一次点击、保存、不连 Agent 回放到目标页，以及目标消失时回放停在正确的步骤。
```

- [ ] **Step 4: 更新日志**

`CHANGELOG.md` 在 `## [0.1.3]` 之前加：

```markdown
## [未发布]

### 新增

- 录制你在网页上的操作，保存为一份可回放的轨迹，之后不连 Agent 也能一键回放。录制只能由人从工具栏开启，Agent 没有这个入口；录制中有红点、实时步数和网页四周的红框，Agent 任务与浏览器工具在此期间被拒
- 密码与一次性验证码从不被录下：这类输入只留一条「需要我」，回放到这一步会暂停并等你填完再继续
- 回放走的是 Agent 操作页面的同一条路径：每一步先重新观察页面再匹配目标，进台账、过指纹校验、升蒙层；目标改名或消失时停在那一步并说明原因，不乱点
- 左栏新增「技能库」：查看步骤与原始轨迹、播放、改名、删除、在 Finder 中显示。文件是普通 Markdown，可以直接改
- 录制中可以随手加一句旁白，会一起进轨迹，供下一期 Agent 提炼时参考
```

- [ ] **Step 5: 全部检查**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add tests/electron.e2e.ts docs/architecture.md CHANGELOG.md
git commit -m "test(recording): end-to-end record, save and replay without an Agent; document the feature

Two Electron E2E cases: a real click on example.com is recorded,
saved as a skill and replayed on a fresh tab all the way to iana.org;
and a replay whose target no longer exists stops at that step and says
so. The architecture doc gains a section and the preload boundary
sentence now names the recording-time exception."
```

---

## 自查记录

**Spec 覆盖（第一期范围）**

| Spec 章节 | Task |
| --- | --- |
| 核心结论：回放不新增元素身份通道 | 8、9 |
| 不存 ElementRef，录制时用 observe 取词 | 2（`toStepTarget`）、5（join）、7（预取） |
| 能力边界当场标记 | 4（out-of-scope / gesture / iframe）、5（beyond-observe-limit、ambiguous） |
| 产物格式：单文件、fenced json 唯一真相、不用 frontmatter | 1 |
| 模块表（第一期部分） | 1–8 |
| 脚本生命周期与固定命令集 | 6 |
| `isTrusted` 陷阱与三方互斥 | 7、9 |
| 脚本三件事、密码判断留在脚本 | 4 |
| 归一化规则 | 5 |
| 旁白 | 5、7、10 |
| 只有人能录（四条） | 7（IPC 入口、executeTool 守卫、任务被拒、events 表） |
| 录制中的状态（五条） | 7（AppState）、10（红点、计数、红框、与回放区分）、7（退出先存） |
| 回放状态机、human 暂停、失败交出现场、预算、取消 | 8、9 |
| 人工回放与本地 principal | 9 |
| 界面：Surface、列表、详情、轨迹只读、播放 / 改名 / 删除 / Finder | 10 |
| 安全：手改 md 不可信、0o600、脚本固定 | 1、3、4 |
| 测试计划（第一期部分） | 1–8 单测、11 E2E |
| 架构文档改动 | 11 |

第二期（不在此计划）：提炼与四条对账、专属提炼会话、`skill.md`、修改分权（步骤结构化编辑）、MCP 两个工具、首次回放审批、卡住交还 Agent。

**类型一致性**：`Actor` 在 Task 9 定义并用于 `executeTool / runTool / executePreparedAction`；`PlayOutcome` 的三种形状在 Task 8 定义、Task 9 消费；`RecordingSummary` 在 Task 3 定义、Task 7 挪到 shared；`describeStep` 的输出格式在 Task 1 测试里钉死，Task 8、11 的断言字符串与之一致（`点击 "登录"（button）`、`输入 "邮箱" = "me@x.com"`、`需要我：填写密码`、`备注：公司邮箱`）。
