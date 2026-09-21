# 录制与技能 第三期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录制的产物从「归一化后的步骤」改成「完整的过程事件日志」，步骤降级为由日志算出的投影；顺带关掉第一期留下的三个录制保真缺口。

**Architecture:** 录制期间采集层（有副作用、持有时钟与实时 observe）把每个事件写成一条 `LoggedEvent`，停止录制时整份写入 `events.jsonl`；投影层是一个不碰时钟、不碰 Electron 的纯状态机，把日志算成现有的 `TrajectoryEntry[]`，`trajectory.md` 因此变成缓存。回放、对账、审批全部继续吃投影，安全属性一行不动。

**Tech Stack:** TypeScript 5.9 / Electron 44 / React 19 / zod 4 / vitest 5 / Playwright（Electron E2E）/ `node:sqlite` / `@modelcontextprotocol/sdk` 1.30

**Spec:** `docs/superpowers/specs/2026-09-21-recording-phase-3-design.md`（前两期不变量见 `2026-09-20-recording-and-skills-design.md` 与 `2026-09-21-recording-phase-2-design.md`）

## Global Constraints

- **不新增运行时依赖。** 运行时只允许 `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod` 三个
- **`src/` 内部 import 必须带 `.js` 扩展名**（ESM）；`tests/` 内 import 不带扩展名
- **界面文案中文**；错误消息中文；MCP 工具描述英文
- **commit message 英文**，conventional commits，与 `git log` 风格一致
- **两个 preload 都要改**：`src/preload/index.ts` 只供类型，`src/preload/entry.cts` 才是 Electron 加载的；方法名、参数对象、channel 常量必须一致，E2E 边界测试钉着 `window.pilion.recording` / `.skills` 的方法名
- **投影层不许有时钟、不许有 I/O**：`project.ts` 里不得出现 `new Date()`、`Date.now()`、`Math.random()`、任何 `import` 自 `electron` 或 `browser/` 的东西。条目的 `at` 一律从日志里抄
- **录制只有人能开**，MCP 里没有这个动词；密码与一次性验证码的值永不离开页面
- **对账（`reconcile`）本期一行不改**，继续校验技能步骤对投影
- **轨迹不能改，只有技能可以改**：`trajectory.md` 是算出来的，手工改动会在下次读取时被日志覆盖
- 命令：`pnpm test`（vitest）、`pnpm typecheck`、`pnpm lint`、`pnpm format`、`pnpm build`、`pnpm test:e2e`；单个文件 `pnpm vitest run tests/<file>.test.ts`
- 基线：`main` @ `5efdf18`，单测 24 文件 / 271 用例全绿

## 时钟与纯度（所有任务都要遵守）

投影必须是纯函数，所以**时钟归采集层**：

- `LoggedEvent.at` 是采集层用主进程时钟打的 ISO 字符串，投影把它原样抄进 `TrajectoryEntry.at`。
- 元素事件额外带 `pageAt: number`，就是页面脚本原来发的 `at`（`Date.now()`）。双击折叠比较的是 `pageAt` 的差值，语义与今天完全一致，现有 `recording-recorder.test.ts` 的断言才能原样平移。
- 投影里出现任何对当前时间的读取都是错的，`project.ts` 拿不到 `now()`，也不该有这个参数。

## 关于计划里的测试代码

下面每个任务的测试都写了断言，但为了不让计划变成一份逐字抄的脚本，构造夹具的小函数（`ev()`、`clickAt()`、`fakeDeps()` 这类）只给了名字与用法。实现时在各自的测试文件里就地写出来，照抄同目录已有测试的风格：`tests/recording-project.test.ts` 的 `ev()` 是 Task 2 里给全的，可以当模板；`tests/recording-library.test.ts` 与 `tests/recording-distill.test.ts` 里已经有现成的轨迹与技能夹具可以借。**断言本身不要改**，它们是验收标准。

## 文件结构

新增：

| 文件                                 | 职责                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `src/main/recording/project.ts`      | 纯投影：`Projector`（增量）与 `project()`（一次性），日志 → `TrajectoryEntry[]` |
| `src/main/recording/capture.ts`      | 采集：收页面与主进程事件，解析目标，打时间戳，维护上限，产出 `LoggedEvent[]`    |
| `src/main/recording/session.ts`      | 从 `main.ts` 搬出的录制编排（起停、入队、标签生命周期耦合）                     |
| `src/main/recording/distillation.ts` | 从 `main.ts` 搬出的提炼生命周期                                                 |
| `tests/recording-log.test.ts`        | Task 1                                                                          |
| `tests/recording-project.test.ts`    | Task 2（由 `recording-recorder.test.ts` 平移而来）                              |
| `tests/recording-capture.test.ts`    | Task 3                                                                          |

修改：

| 文件                                             | 改动                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/recording/types.ts`                    | `LoggedEventSchema`；`ElementDescriptionSchema` 与 `RawEventSchema` 移入；`UNSUPPORTED_REASONS` 加 `'rich-text'`；`meta.version` 放宽到 1\|2 并加 `source` |
| `src/main/recording/recorder.ts`                 | Task 5 结束时删除（Task 3 起与 `capture.ts` 短暂并存）                                                                                                     |
| `src/main/recording/recorder-script.ts`          | 滚动、`contenteditable`、iframe 收口                                                                                                                       |
| `src/main/recording/library.ts`                  | `events.jsonl` 读写、哈希、不符时重算、`hasEvents`                                                                                                         |
| `src/main/recording/distill.ts`                  | `renderEvents`，`buildDistillPrompt` 多接一段过程                                                                                                          |
| `src/main/recording/format.ts`                   | 轨迹散文头改口径（算出来的，别手改）                                                                                                                       |
| `src/main/main.ts`                               | 两块搬走，只留接线；三个导航处理函数补 `pendingCause`                                                                                                      |
| `src/shared/contracts.ts`                        | `RecordingSummary.hasEvents`、IPC `recordingsEvents`                                                                                                       |
| `src/preload/index.ts` / `src/preload/entry.cts` | 同步新方法                                                                                                                                                 |
| `src/renderer/SkillLibrary.tsx`                  | 「过程」视图；编辑器拆成独立组件                                                                                                                           |
| `tests/recording-recorder.test.ts`               | Task 5 结束时删除（内容已分别平移到 `recording-project.test.ts` 与 `recording-capture.test.ts`）                                                           |
| `docs/architecture.md` / `CHANGELOG.md`          | Task 10                                                                                                                                                    |

---

### Task 1: 事件日志的类型

**Files:**

- Modify: `src/main/recording/types.ts`
- Modify: `src/main/recording/recorder.ts`（只删被搬走的两个 schema，改成从 `./types.js` 导入）
- Test: `tests/recording-log.test.ts`（新建）

**Interfaces:**

- Consumes: 现有 `StepTargetSchema`、`PressKeySchema`、`UNSUPPORTED_REASONS`
- Produces: `ElementDescriptionSchema` / `ElementDescription`、`RawEventSchema` / `RawEvent`（含新增的 `scroll` 与 `edit` 两种）、`LoggedEventSchema` / `LoggedEvent`、`NAVIGATE_CAUSES`；`TrajectorySchema.meta.version` 放宽到 `1 | 2` 并新增可选 `source: { events, hash }`；`UNSUPPORTED_REASONS` 增加 `'rich-text'`

注意：`src/main/recording/index.ts` 用 `export *` 把这个目录整体再导出，所以把 schema 从 `recorder.ts` 搬到 `types.ts` 对外部调用方是透明的，不要额外加转发导出。

- [ ] **Step 1: 写失败测试**

`tests/recording-log.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  LoggedEventSchema,
  TrajectorySchema,
  UNSUPPORTED_REASONS,
} from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const stamp = '2026-09-21T12:00:00.000Z';

describe('LoggedEventSchema', () => {
  it('点击带着采集时解析好的目标', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 3,
      at: stamp,
      kind: 'click',
      url: 'https://example.com/',
      index: 7,
      el,
      pageAt: 1_700_000_000_000,
      target: { role: 'button', name: '导出 CSV', tagName: 'button' },
      ambiguous: false,
    });
    expect(parsed.kind).toBe('click');
  });

  it('secret 事件带值就整条不合法', () => {
    expect(() =>
      LoggedEventSchema.parse({
        seq: 1,
        at: stamp,
        kind: 'secret',
        url: 'https://example.com/',
        index: 2,
        el,
        pageAt: 1,
        target: { role: 'button', name: '导出 CSV', tagName: 'button' },
        ambiguous: false,
        otp: false,
        value: '123456',
      }),
    ).toThrow();
  });

  it('edit 只有长度，没有内容字段', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 1,
      at: stamp,
      kind: 'edit',
      url: 'https://example.com/',
      index: -1,
      el: { tagName: 'div', role: 'generic', name: '' },
      pageAt: 1,
      target: { role: 'generic', name: '', tagName: 'div' },
      ambiguous: false,
      length: 42,
    });
    expect(parsed).not.toHaveProperty('text');
    expect(() => LoggedEventSchema.parse({ ...parsed, text: '偷渡的内容' })).toThrow();
  });

  it('navigate 必须说明是怎么来的', () => {
    expect(
      LoggedEventSchema.parse({
        seq: 2,
        at: stamp,
        kind: 'navigate',
        url: 'https://example.com/list',
        cause: 'back',
      }).kind,
    ).toBe('navigate');
    expect(() =>
      LoggedEventSchema.parse({ seq: 2, at: stamp, kind: 'navigate', url: 'https://e.com/' }),
    ).toThrow();
  });

  it('scroll 只带坐标', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 9,
      at: stamp,
      kind: 'scroll',
      url: 'https://example.com/',
      x: 0,
      y: 1200,
    });
    expect(parsed).not.toHaveProperty('el');
  });
});

describe('TrajectorySchema 的版本', () => {
  const entries = [] as const;

  it('接受 version 2 与 source', () => {
    const parsed = TrajectorySchema.parse({
      meta: {
        app: 'pilion',
        version: 2,
        name: '月度导出',
        recordedAt: stamp,
        source: { events: 12, hash: 'a'.repeat(64) },
      },
      entries,
    });
    expect(parsed.meta.source?.events).toBe(12);
  });

  it('仍然接受没有 source 的 version 1', () => {
    const parsed = TrajectorySchema.parse({
      meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: stamp },
      entries,
    });
    expect(parsed.meta.version).toBe(1);
  });

  it('source 的哈希必须是 64 位十六进制', () => {
    expect(() =>
      TrajectorySchema.parse({
        meta: {
          app: 'pilion',
          version: 2,
          name: '月度导出',
          recordedAt: stamp,
          source: { events: 1, hash: 'not-a-hash' },
        },
        entries,
      }),
    ).toThrow();
  });
});

it('富文本是一种新的回放不了的原因', () => {
  expect(UNSUPPORTED_REASONS).toContain('rich-text');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-log.test.ts`
Expected: FAIL，`LoggedEventSchema` 不存在。

- [ ] **Step 3: 把两个 schema 搬进 `types.ts` 并新增日志类型**

在 `src/main/recording/types.ts` 里，`StepTargetSchema` 之后加入（`ElementDescriptionSchema` 从 `recorder.ts` 原样搬来，一字不改）：

```ts
export const ElementDescriptionSchema = z
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
export type ElementDescription = z.infer<typeof ElementDescriptionSchema>;

/** 页面脚本发过来的原始事件；`at` 是页面时钟。 */
const rawBase = {
  url: z.string().max(8192),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  at: z.number(),
};
export const RawEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), ...rawBase }).strict(),
  z.object({ kind: z.literal('click'), ...rawBase }).strict(),
  z.object({ kind: z.literal('input'), ...rawBase, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('select'), ...rawBase, value: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal('check'), ...rawBase, checked: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('key'), ...rawBase, key: PressKeySchema, shift: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('secret'), ...rawBase, otp: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('edit'), ...rawBase, length: z.number().int().min(0).max(1_000_000) })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      url: z.string().max(8192),
      at: z.number(),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
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

export const NAVIGATE_CAUSES = ['address', 'back', 'forward', 'reload'] as const;

/**
 * 落盘的一条过程记录。`at` 是采集层用主进程时钟打的，投影原样抄进条目，
 * 所以投影里不需要、也不许有时钟；`pageAt` 保留页面时钟，双击折叠比的是它。
 */
const stamped = {
  seq: z.number().int().min(1).max(1_000_000),
  at: z.string().min(1).max(64),
};
const loggedElement = {
  ...stamped,
  url: z.string().max(8192),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  pageAt: z.number(),
  /**
   * 采集时解析出来的目标：先拿实时 observe 那一行，对不上就退回脚本的描述。
   * 两条路都有结果，所以这里是必填的 —— 投影层因此没有任何回退分支，也就不需要 `fromDescription`。
   */
  target: StepTargetSchema,
  ambiguous: z.boolean(),
};
export const LoggedEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...stamped,
      kind: z.literal('page'),
      url,
      title: z.string().max(400),
      text: z.string().max(2000),
    })
    .strict(),
  z
    .object({ ...stamped, kind: z.literal('navigate'), url, cause: z.enum(NAVIGATE_CAUSES) })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('note'),
      text: z.string().max(2000),
      onUrl: url.optional(),
    })
    .strict(),
  z.object({ ...loggedElement, kind: z.literal('pointer') }).strict(),
  z.object({ ...loggedElement, kind: z.literal('click') }).strict(),
  z.object({ ...loggedElement, kind: z.literal('input'), value: z.string().max(100_000) }).strict(),
  z.object({ ...loggedElement, kind: z.literal('select'), value: z.string().max(10_000) }).strict(),
  z.object({ ...loggedElement, kind: z.literal('check'), checked: z.boolean() }).strict(),
  z
    .object({ ...loggedElement, kind: z.literal('key'), key: PressKeySchema, shift: z.boolean() })
    .strict(),
  z.object({ ...loggedElement, kind: z.literal('secret'), otp: z.boolean() }).strict(),
  z
    .object({
      ...loggedElement,
      kind: z.literal('edit'),
      length: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('scroll'),
      url: z.string().max(8192),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('unsupported'),
      url: z.string().max(8192),
      reason: z.enum(['iframe', 'out-of-scope', 'gesture']),
      el: ElementDescriptionSchema.optional(),
    })
    .strict(),
]);
export type LoggedEvent = z.infer<typeof LoggedEventSchema>;
```

同一文件里另外三处改动：

1. `UNSUPPORTED_REASONS` 数组末尾加 `'rich-text'`。
2. `TrajectorySchema.meta` 的 `version` 从 `z.literal(1)` 改成 `z.union([z.literal(1), z.literal(2)])`，并在 `recordedAt` 之后加：

```ts
        /** 有日志时指向它：条数与全文 sha256。没有这一段的就是第一期的老录制。 */
        source: z
          .object({
            events: z.number().int().min(0).max(20_000),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
```

3. `types.ts` 顶部的 import 增加 `PressKeySchema`（`RawEventSchema` 要用），如果已经有就不要重复。

最后把 `src/main/recording/recorder.ts` 里的 `ElementDescriptionSchema`、`ElementDescription`、`rawBase`（那里叫 `base`）、`RawEventSchema`、`RawEvent` 五处定义删掉，改成从 `./types.js` 导入 `ElementDescriptionSchema` 之外它真正用到的东西（它用 `ElementDescription` 类型与 `RawEvent` 类型）。`recorder.ts` 本身 Task 3 才删。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-log.test.ts tests/recording-recorder.test.ts tests/recording-format.test.ts`
Expected: 三个文件全绿。搬 schema 不该动任何现有断言。

- [ ] **Step 5: 全量检查并提交**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/types.ts src/main/recording/recorder.ts tests/recording-log.test.ts
git commit -m "feat(recording): schema for the process event log"
```

---

### Task 2: 纯投影 `project.ts`

**Files:**

- Create: `src/main/recording/project.ts`
- Create: `tests/recording-project.test.ts`
- Modify: `src/main/recording/index.ts`（加一行 `export * from './project.js';`）

**Interfaces:**

- Consumes: Task 1 的 `LoggedEvent`、`UNSUPPORTED_REASONS`（含 `'rich-text'`）
- Produces: `class Projector`（`push(event: LoggedEvent): void`、`get counts(): { steps: number; unsupported: number }`、`get capped(): boolean`、`done(): { entries: TrajectoryEntry[]; capped: boolean }`）与 `project(events: readonly LoggedEvent[]): { entries: TrajectoryEntry[]; capped: boolean }`

三条铁律，评审会盯：

1. **没有时钟。** 每个条目的 `at` 一律来自产生它的那条事件。挂起输入在提交时落的 `type` 步骤，用的是**那条 input 事件自己的 `at`**（不是提交时刻）；mousedown 之后跳页补的那次 click，用的是 **pointer 事件的 `at`**。这比今天的「提交时刻」更忠实，平移测试时如果有断言 `at` 的地方，按新口径改。
2. **没有回退。** 目标从 `event.target` 直接拿，Task 1 已经把它定成必填。
3. **`scroll` 不进投影**，直接 return。

- [ ] **Step 1: 写失败测试**

`tests/recording-project.test.ts` 的骨架与两条新规则：

```ts
import { describe, expect, it } from 'vitest';
import { project, Projector } from '../src/main/recording/project';
import type { LoggedEvent } from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const target = { role: 'button', name: '导出 CSV', tagName: 'button' };
const URL = 'https://example.com/';

let seq = 0;
/** 把一条事件写全：seq 自增，at 按 seq 生成，元素类事件补上必填的 target/ambiguous。 */
function ev(partial: Record<string, unknown>): LoggedEvent {
  seq += 1;
  const at = new Date(Date.UTC(2026, 8, 21, 12, 0, Math.min(seq, 59))).toISOString();
  const base = { seq, at, url: URL, ...partial };
  if ('index' in base || 'el' in base)
    return { pageAt: seq * 1000, el, target, ambiguous: false, ...base } as LoggedEvent;
  return base as LoggedEvent;
}

function steps(events: LoggedEvent[]) {
  return project(events).entries.flatMap((entry) => (entry.kind === 'step' ? [entry] : []));
}

describe('project', () => {
  it('后退与刷新也产出 navigate 步骤', () => {
    seq = 0;
    const out = steps([
      ev({ kind: 'page', url: URL, title: '列表', text: '' }),
      ev({ kind: 'navigate', url: 'https://example.com/list', cause: 'back' }),
      ev({ kind: 'page', url: 'https://example.com/list', title: '列表', text: '' }),
      ev({ kind: 'navigate', url: 'https://example.com/list', cause: 'reload' }),
    ]);
    expect(out.map((entry) => entry.step)).toEqual([
      { kind: 'navigate', url: 'https://example.com/list' },
      { kind: 'navigate', url: 'https://example.com/list' },
    ]);
  });

  it('富文本输入变成带 rich-text 的「需要我」，不是超纲提示', () => {
    seq = 0;
    const out = steps([
      ev({ kind: 'page', url: URL, title: '编辑器', text: '' }),
      ev({
        kind: 'edit',
        index: -1,
        el: { tagName: 'div', role: 'generic', name: '' },
        target: { role: 'generic', name: '', tagName: 'div' },
        length: 12,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].unsupported).toBe('rich-text');
    expect(out[0].step).toEqual({ kind: 'human', onUrl: URL, reason: '手动填写富文本内容' });
  });

  it('滚动完全不进投影', () => {
    seq = 0;
    expect(steps([ev({ kind: 'scroll', x: 0, y: 900 })])).toHaveLength(0);
  });

  it('条目的时间来自事件，不来自当前时钟', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'input', index: 1, value: '张三' }),
      ev({ kind: 'click', index: 2 }),
    ];
    const out = project(events).entries;
    // type 步骤落的是那条 input 自己的时间戳
    expect(out[1].at).toBe(events[1].at);
    expect(out[2].at).toBe(events[2].at);
  });

  it('增量喂入与一次性 project 结果逐条相同', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'input', index: 1, value: '张三' }),
      ev({ kind: 'pointer', index: 2 }),
      ev({ kind: 'click', index: 2 }),
    ];
    const incremental = new Projector();
    for (const event of events) incremental.push(event);
    expect(incremental.done().entries).toEqual(project(events).entries);
  });

  it('同一份日志算两次结果相同', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'click', index: 2 }),
    ];
    expect(project(events)).toEqual(project(events));
  });

  it('counts 把挂起的输入也算一步', () => {
    seq = 0;
    const projector = new Projector();
    projector.push(ev({ kind: 'page', url: URL, title: '页', text: '' }));
    projector.push(ev({ kind: 'input', index: 1, value: '张三' }));
    expect(projector.counts.steps).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-project.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/recording/project.ts`**

```ts
import {
  StepSchema,
  type LoggedEvent,
  type Step,
  type StepTarget,
  type TrajectoryEntry,
  UNSUPPORTED_REASONS,
} from './types.js';

/** observe 截断到 200 个元素，序号在此之后的目标回放永远够不到。 */
const OBSERVE_LIMIT = 200;
const DOUBLE_CLICK_MS = 400;
/** 轨迹 schema 允许的条目上限；到顶就停止增长，投影照样算得完。 */
const MAX_ENTRIES = 2000;

type ElementEvent = Extract<LoggedEvent, { kind: 'click' }>;
type Pending = {
  index: number;
  target: StepTarget;
  text: string;
  onUrl: string;
  ambiguous: boolean;
  at: string;
};
type Pointer = {
  index: number;
  url: string;
  target: StepTarget;
  ambiguous: boolean;
  beyond: boolean;
  at: string;
};

function beyondReason(target: StepTarget): string {
  return `手动完成对 "${target.name || target.tagName}" 的操作`;
}

/** 步骤不合法时只剩「人当时想做什么」还有用；`onUrl` 是必填项，所以这里保证它非空。 */
function stepUrl(step: Step): string {
  const raw = step.kind === 'navigate' ? step.url : (step.onUrl ?? '');
  return raw.slice(0, 8192) || 'about:blank';
}

function describeAttempt(step: Step): string {
  const what = (target: StepTarget) => `"${target.name || target.tagName}"`;
  switch (step.kind) {
    case 'navigate':
      return '打开录制时的那个地址';
    case 'note':
      return '补上这条备注';
    case 'human':
      return step.reason || '完成这一步';
    case 'click':
      return `点击 ${what(step.target)}`;
    case 'type':
      return `在 ${what(step.target)} 里填写内容`;
    case 'select':
      return `在 ${what(step.target)} 里选择${step.value ? ` "${step.value}"` : '空选项'}`;
    case 'check':
      return `${step.checked ? '勾选' : '取消勾选'} ${what(step.target)}`;
    case 'press':
      return `在 ${what(step.target)} 上按 ${step.key}`;
  }
}

/**
 * 日志到步骤的纯状态机：没有时钟、没有 I/O、不碰 Electron。
 * 每个条目的 `at` 都抄自产生它的那条事件，所以同一份日志算多少次都一样。
 */
export class Projector {
  readonly #entries: TrajectoryEntry[] = [];
  #currentUrl = '';
  #pending: Pending | undefined;
  #pointer: Pointer | undefined;
  #lastClick: { index: number; at: number } | undefined;
  #lastSecretIndex: number | undefined;
  #capped = false;
  #finished = false;

  get capped(): boolean {
    return this.#capped;
  }

  get counts(): { steps: number; unsupported: number } {
    const steps = this.#entries.filter((entry) => entry.kind === 'step');
    return {
      steps: steps.length + (this.#pending ? 1 : 0),
      unsupported: steps.filter((entry) => entry.unsupported).length,
    };
  }

  push(event: LoggedEvent): void {
    if (this.#finished) throw new Error('投影已结束，不能再喂事件');
    switch (event.kind) {
      case 'scroll':
        return;
      case 'page':
        return this.#page(event);
      case 'navigate':
        return this.#navigate(event);
      case 'note':
        return this.#note(event);
      default:
        return this.#element(event);
    }
  }

  done(): { entries: TrajectoryEntry[]; capped: boolean } {
    if (!this.#finished) {
      this.#flushPending();
      this.#pointer = undefined;
      this.#finished = true;
    }
    return { entries: [...this.#entries], capped: this.#capped };
  }

  #page(event: Extract<LoggedEvent, { kind: 'page' }>): void {
    this.#flushPending();
    this.#lastClick = undefined;
    this.#flushPointerAsClick(event.url);
    this.#currentUrl = event.url;
    this.#add({
      kind: 'page',
      at: event.at,
      url: event.url,
      title: event.title.slice(0, 400),
      text: event.text.slice(0, 2000),
    });
  }

  #navigate(event: Extract<LoggedEvent, { kind: 'navigate' }>): void {
    this.#flushPending();
    this.#lastClick = undefined;
    this.#pointer = undefined;
    // cause 只进日志给人和 Agent 看；四种来源产出的步骤完全一样，回放都是「打开这个地址」。
    this.#push(event.at, { kind: 'navigate', url: event.url });
  }

  #note(event: Extract<LoggedEvent, { kind: 'note' }>): void {
    this.#pointer = undefined;
    const onUrl = event.onUrl || this.#currentUrl;
    this.#push(event.at, {
      kind: 'note',
      text: event.text.slice(0, 2000),
      ...(onUrl ? { onUrl } : {}),
    });
  }

  #element(event: Exclude<LoggedEvent, { kind: 'page' | 'navigate' | 'note' | 'scroll' }>): void {
    // 规则 3：除了 pointer 自己，任何事件都清掉挂着的 pointer。
    if (event.kind !== 'pointer') this.#pointer = undefined;

    if (event.kind === 'unsupported') {
      this.#flushPending();
      const what = event.el ? `"${event.el.name || event.el.tagName}"` : '页面内嵌框架';
      const why =
        event.reason === 'gesture'
          ? `手动完成在 ${what} 上的拖拽或右键操作`
          : event.reason === 'iframe'
            ? '手动完成内嵌框架里的操作'
            : `手动点击 ${what}`;
      this.#push(
        event.at,
        { kind: 'human', onUrl: this.#onUrl(event.url), reason: why },
        { unsupported: event.reason },
      );
      return;
    }

    const { target, ambiguous } = event;
    const onUrl = this.#onUrl(event.url);

    // 富文本要在超纲判断之前处理：它的 index 通常是 -1（不在 observe 选择器里），
    // 落进超纲分支就会给出「手动完成对 "" 的操作」这种没用的话。
    if (event.kind === 'edit') {
      this.#flushPending();
      this.#push(
        event.at,
        { kind: 'human', onUrl, reason: '手动填写富文本内容' },
        { unsupported: 'rich-text' },
      );
      return;
    }

    const beyond = event.index >= OBSERVE_LIMIT || event.index < 0;
    // pointerdown 与 click 成对出现，超纲也只该提醒一次：pointer 只挂起，
    // 由紧随的 click（或换页时的补点击）落那唯一一条。
    if (beyond && event.kind === 'pointer') {
      this.#flushPending(event.index);
      this.#pointer = {
        index: event.index,
        url: onUrl,
        target,
        ambiguous,
        beyond: true,
        at: event.at,
      };
      return;
    }
    if (beyond && event.kind !== 'secret') {
      this.#flushPending();
      this.#push(
        event.at,
        { kind: 'human', onUrl, reason: beyondReason(target) },
        { unsupported: 'beyond-observe-limit' },
      );
      return;
    }
    // 点进正在输入的那个框不算换元素；其它任何事件（包括同一字段上的回车）都先提交挂起的输入。
    if (event.kind !== 'input')
      this.#flushPending(event.kind === 'pointer' ? event.index : undefined);
    if (event.kind !== 'secret') this.#lastSecretIndex = undefined;

    switch (event.kind) {
      case 'pointer':
        this.#pointer = {
          index: event.index,
          url: onUrl,
          target,
          ambiguous,
          beyond: false,
          at: event.at,
        };
        return;
      case 'click': {
        if (
          this.#lastClick &&
          this.#lastClick.index === event.index &&
          event.pageAt - this.#lastClick.at <= DOUBLE_CLICK_MS
        )
          return;
        this.#lastClick = { index: event.index, at: event.pageAt };
        this.#push(event.at, { kind: 'click', onUrl, target }, { ambiguous });
        return;
      }
      case 'input':
        if (this.#pending && this.#pending.index !== event.index) this.#flushPending();
        this.#pending = {
          index: event.index,
          target,
          text: event.value,
          onUrl,
          ambiguous,
          at: event.at,
        };
        return;
      case 'select':
        this.#push(event.at, { kind: 'select', onUrl, target, value: event.value }, { ambiguous });
        return;
      case 'check':
        this.#push(
          event.at,
          { kind: 'check', onUrl, target, checked: event.checked },
          { ambiguous },
        );
        return;
      case 'key':
        this.#push(
          event.at,
          { kind: 'press', onUrl, target, key: event.key, modifiers: event.shift ? ['Shift'] : [] },
          { ambiguous },
        );
        return;
      case 'secret':
        if (this.#lastSecretIndex === event.index) return;
        this.#lastSecretIndex = event.index;
        this.#push(event.at, {
          kind: 'human',
          onUrl,
          reason: event.otp ? '填写验证码' : '填写密码',
        });
        return;
    }
  }

  #onUrl(eventUrl: string): string {
    return this.#currentUrl || eventUrl || 'about:blank';
  }

  /** 唯一的写入口：到上限就丢，绝不让投影因为超长而整份失败。 */
  #add(entry: TrajectoryEntry): void {
    if (this.#entries.length >= MAX_ENTRIES) {
      this.#capped = true;
      return;
    }
    this.#entries.push(entry);
  }

  #push(
    at: string,
    step: Step,
    marks: { unsupported?: (typeof UNSUPPORTED_REASONS)[number]; ambiguous?: boolean } = {},
  ): void {
    // 当场校验：空值下拉、超长 URL 这类步骤放进去，序列化时 schema 会把整份轨迹一起拒掉。
    // 换成一条人看得懂的「需要我」，别的步骤照样留着。
    if (!StepSchema.safeParse(step).success) {
      this.#add({
        kind: 'step',
        at,
        step: {
          kind: 'human',
          onUrl: stepUrl(step),
          reason: `手动完成：${describeAttempt(step)}`.slice(0, 500),
        },
        unsupported: 'out-of-scope',
      });
      return;
    }
    this.#add({
      kind: 'step',
      at,
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
      pending.at,
      {
        kind: 'type',
        onUrl: pending.onUrl,
        target: pending.target,
        text: pending.text,
        replace: true,
      },
      { ambiguous: pending.ambiguous },
    );
  }

  /** mousedown 之后页面就跳走了：没有 click 事件，但人确实点了。到这里 pointer 还挂着，说明中间没有别的事件。 */
  #flushPointerAsClick(newUrl: string): void {
    const pointer = this.#pointer;
    this.#pointer = undefined;
    if (!pointer || newUrl === pointer.url) return;
    if (pointer.beyond) {
      this.#push(
        pointer.at,
        { kind: 'human', onUrl: pointer.url, reason: beyondReason(pointer.target) },
        { unsupported: 'beyond-observe-limit' },
      );
      return;
    }
    this.#push(
      pointer.at,
      { kind: 'click', onUrl: pointer.url, target: pointer.target },
      { ambiguous: pointer.ambiguous },
    );
  }
}

export function project(events: readonly LoggedEvent[]): {
  entries: TrajectoryEntry[];
  capped: boolean;
} {
  const projector = new Projector();
  for (const event of events) projector.push(event);
  return projector.done();
}
```

`ElementEvent` 这个类型别名如果实现时用不上就删掉，不要留着不用的声明（lint 会报）。

- [ ] **Step 4: 平移现有状态机用例**

把 `tests/recording-recorder.test.ts` 里这些用例搬进 `tests/recording-project.test.ts`，断言不变，只把「调 `recorder.page()/raw()/…`」改成「构造 `LoggedEvent` 数组喂 `project()`」：

- `page 产出页面条目，navigate 与 note 直接成步骤`
- `同一输入框的连续 input 合并成一条 type，只留最终值，且 replace 为 true`
- `换到别的元素时先提交挂起的输入，顺序保持`
- `pointer 紧跟 click 只产出一条 click`
- `pointer 后页面直接跳走也算一次 click`
- `孤立的 pointer 被丢弃`
- `pointer 之后有别的事件再换页，不会伪造点击`
- `换页后同 index 的点击不算双击`
- `400ms 内的双击折叠成一次`（用 `pageAt` 控制间隔）
- `secret 产出「需要我」步骤，连续的只留一条，且从不带值`
- `Enter 先提交挂起输入再产出 press`
- `Shift 作为唯一支持的修饰键写入 modifiers`
- `unsupported 变成带原因的「需要我」步骤`
- `序号超出 observe 上限标 beyond-observe-limit`
- `超纲的 pointer 加 click 只提醒一次`
- `超纲的 pointer 之后页面跳走，补的也是那一条「需要我」`
- `空值下拉变成「需要我」而不是让 finish 抛错`
- `到达 2000 条上限后不再增长，capped 置位`（断言改成 `project()` 返回的 `capped` 为真且 `entries.length === 2000`）

**不要搬**下面五条，它们测的是目标解析，属于 Task 3 的 `tests/recording-capture.test.ts`：`对上预取的 observe 时用它那一行取词，并带上指纹与 nth`、`observe 行的 tagName 对不上时退回脚本描述`、`observe 行的角色与名字都对不上时退回脚本描述，不拿别人的词取名`、`一方的名字包含另一方时仍算同一个元素，用 observe 那一行的词`、`脚本描述里的 duplicates/position 变成 nth`。

`finish 产出的轨迹通过 schema，meta 带名字与时间` 这一条也不搬：轨迹信封从 Task 3 起由会话层组装，Task 3 会覆盖它。

`tests/recording-recorder.test.ts` 本任务先留着（`recorder.ts` 还在），Task 3 删文件时一起删。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-project.test.ts tests/recording-recorder.test.ts`
Expected: 两个文件都绿。

- [ ] **Step 6: 提交**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/project.ts src/main/recording/index.ts tests/recording-project.test.ts
git commit -m "feat(recording): pure projection from the event log to steps"
```

---

### Task 3: 采集层 `capture.ts`，删掉 `recorder.ts`

**Files:**

- Create: `src/main/recording/capture.ts`
- Create: `tests/recording-capture.test.ts`
- Modify: `src/main/recording/index.ts`（加一行 `export * from './capture.js';`；`recorder.js` 那一行 Task 5 才去掉）

**Interfaces:**

- Consumes: Task 1 的 `RawEvent` / `LoggedEvent`，Task 2 的 `Projector`；现有 `resolve.ts` 的 `normalizeName` / `toStepTarget`；`browser/types.js` 的 `Observation` / `ObservedElement`
- Produces: `class RecordingCapture`
  - `constructor(options?: { now?: () => Date })`
  - `pendingCause(cause: 'back' | 'forward' | 'reload'): void`
  - `page(entry: { url: string; title: string; text: string }): void`
  - `navigate(url: string): void`（地址栏那一种，`cause: 'address'`）
  - `note(text: string, onUrl?: string): void`
  - `raw(event: RawEvent, observed?: Observation): void`
  - `get counts(): { steps: number; unsupported: number }`、`get capped(): boolean`、`get startedAt(): string`
  - `finish(): LoggedEvent[]`

- [ ] **Step 1: 写失败测试**

`tests/recording-capture.test.ts`：先把 Task 2 点名不搬的那五条目标解析用例**从 `tests/recording-recorder.test.ts` 搬过来**，断言全部不变，只把「读 `recorder.finish().entries[i].step.target`」改成「读 `capture.finish()[i].target`」。再加下面这些：

```ts
import { describe, expect, it } from 'vitest';
import { RecordingCapture } from '../src/main/recording/capture';
import type { RawEvent } from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const URL = 'https://example.com/';
const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 12, 0, (tick += 1)));
};
const click = (index = 1): RawEvent => ({ kind: 'click', url: URL, index, el, at: 1_000 });

describe('RecordingCapture', () => {
  it('seq 连续、at 用注入的时钟，不用页面时钟', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: URL, title: '页', text: '' });
    capture.raw(click());
    const events = capture.finish();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1].at).toBe('2026-09-21T12:00:02.000Z');
    expect(events[1]).toMatchObject({ pageAt: 1_000 });
  });

  it('元素事件一定带解析好的目标', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.raw(click());
    expect(capture.finish()[0]).toMatchObject({
      target: { role: 'button', name: '导出 CSV', tagName: 'button' },
      ambiguous: false,
    });
  });

  it('后退的原因挂起来，由下一个 page 消费成一条 navigate', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.pendingCause('back');
    capture.page({ url: 'https://example.com/list', title: '列表', text: '' });
    const kinds = capture.finish().map((event) => event.kind);
    expect(kinds).toEqual(['navigate', 'page']);
    expect(capture.finish()[0]).toMatchObject({ cause: 'back', url: 'https://example.com/list' });
  });

  it('导航没成功时挂起的原因不会张冠李戴', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.pendingCause('forward');
    capture.navigate('https://example.com/typed'); // 人改用地址栏
    capture.page({ url: 'https://example.com/typed', title: '页', text: '' });
    const events = capture.finish();
    expect(events.map((event) => event.kind)).toEqual(['navigate', 'page']);
    expect(events[0]).toMatchObject({ cause: 'address' });
  });

  it('到达两万条上限后停止记录，capped 置位，已记的照样拿得到', () => {
    const capture = new RecordingCapture({ now: clock() });
    for (let n = 0; n < 20_050; n += 1) capture.raw(click());
    expect(capture.capped).toBe(true);
    expect(capture.finish()).toHaveLength(20_000);
  });

  it('counts 实时反映投影出来的步数', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: URL, title: '页', text: '' });
    capture.raw(click());
    expect(capture.counts.steps).toBe(1);
  });

  it('滚动与 unsupported 进日志但不带目标', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.raw({ kind: 'scroll', url: URL, at: 1, x: 0, y: 800 });
    capture.raw({ kind: 'unsupported', url: URL, reason: 'iframe', at: 2 });
    const events = capture.finish();
    expect(events[0]).not.toHaveProperty('target');
    expect(events[1]).toMatchObject({ reason: 'iframe' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-capture.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/recording/capture.ts`**

从 `recorder.ts` 原样搬走 `fromDescription` 与 `sameElement` 两个函数（连注释一起），它们是目标解析的全部逻辑。骨架：

```ts
import type { Observation, ObservedElement } from '../browser/types.js';
import { normalizeName, toStepTarget } from './resolve.js';
import { Projector } from './project.js';
import type { ElementDescription, LoggedEvent, RawEvent, StepTarget } from './types.js';

/** 日志上限：条数与字节数先到者为准，到顶就停止记录，绝不让停止录制失败。 */
const MAX_EVENTS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

// fromDescription / sameElement 从 recorder.ts 原样搬来，放在这里

/**
 * 有副作用的那一层：持有时钟、拿实时 observe 解析目标、维护上限。
 * 它只产出日志；步骤是 Projector 的事，这里持有一个只为录制条实时显示步数。
 */
export class RecordingCapture {
  readonly #events: LoggedEvent[] = [];
  readonly #projector = new Projector();
  readonly #now: () => Date;
  readonly #startedAt: string;
  #bytes = 0;
  #capped = false;
  #pendingCause: 'back' | 'forward' | 'reload' | undefined;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now().toISOString();
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  /** 日志到顶或投影到顶，对人来说都是「后面的没记下」。 */
  get capped(): boolean {
    return this.#capped || this.#projector.capped;
  }

  get counts(): { steps: number; unsupported: number } {
    return this.#projector.counts;
  }

  /** 前进后退刷新：落地地址要等文档提交才知道，所以先挂起，由下一个 page 消费。 */
  pendingCause(cause: 'back' | 'forward' | 'reload'): void {
    this.#pendingCause = cause;
  }

  page(entry: { url: string; title: string; text: string }): void {
    const cause = this.#takeCause();
    if (cause) this.#add({ kind: 'navigate', url: entry.url, cause });
    this.#add({
      kind: 'page',
      url: entry.url,
      title: entry.title.slice(0, 400),
      text: entry.text.slice(0, 2000),
    });
  }

  navigate(url: string): void {
    // 人改用地址栏了：挂着的前进后退原因作废，不能安到这次导航头上。
    this.#takeCause();
    this.#add({ kind: 'navigate', url, cause: 'address' });
  }

  note(text: string, onUrl?: string): void {
    this.#add({ kind: 'note', text: text.slice(0, 2000), ...(onUrl ? { onUrl } : {}) });
  }

  raw(event: RawEvent, observed?: Observation): void {
    if (event.kind === 'scroll') {
      this.#add({ kind: 'scroll', url: event.url, x: event.x, y: event.y });
      return;
    }
    if (event.kind === 'unsupported') {
      this.#add({
        kind: 'unsupported',
        url: event.url,
        reason: event.reason,
        ...(event.el ? { el: event.el } : {}),
      });
      return;
    }
    const { target, ambiguous } = this.#target(event.el, event.index, observed);
    const { kind, url, index, el, at, ...rest } = event;
    this.#add({ kind, url, index, el, pageAt: at, target, ambiguous, ...rest } as Omit<
      LoggedEvent,
      'seq' | 'at'
    >);
  }

  finish(): LoggedEvent[] {
    return [...this.#events];
  }

  #takeCause(): 'back' | 'forward' | 'reload' | undefined {
    const cause = this.#pendingCause;
    this.#pendingCause = undefined;
    return cause;
  }

  #add(partial: Omit<LoggedEvent, 'seq' | 'at'>): void {
    if (this.#events.length >= MAX_EVENTS || this.#bytes >= MAX_BYTES) {
      this.#capped = true;
      return;
    }
    const event = {
      seq: this.#events.length + 1,
      at: this.#now().toISOString(),
      ...partial,
    } as LoggedEvent;
    this.#bytes += JSON.stringify(event).length + 1;
    this.#events.push(event);
    this.#projector.push(event);
  }

  #target(
    el: ElementDescription,
    index: number,
    observed: Observation | undefined,
  ): { target: StepTarget; ambiguous: boolean } {
    const row = observed?.elements[index];
    if (row && sameElement(row, el)) {
      const { target, duplicates } = toStepTarget(row, observed!.elements);
      return { target, ambiguous: duplicates > 1 };
    }
    return { target: fromDescription(el), ambiguous: Boolean(el.duplicates && el.duplicates > 1) };
  }
}
```

`#add` 里那个 `as` 断言是必要的：`Omit` 打散判别联合后 TypeScript 认不回来。如果实现时能用更干净的重载或泛型消掉它，可以，但不要为此放宽 schema。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-capture.test.ts tests/recording-project.test.ts tests/recording-recorder.test.ts`
Expected: 三个文件全绿。

**`recorder.ts` 本任务不删。** 它和 `capture.ts` 会短暂并存、逻辑重复，这是故意的：`main.ts` 还在用 `TrajectoryRecorder`，现在删会让整棵树编译不过。Task 5 把主进程接到新模块上之后，连同 `tests/recording-recorder.test.ts` 一起删除。评审看到这份重复请按计划放行。

- [ ] **Step 5: 提交**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/capture.ts src/main/recording/index.ts tests/recording-capture.test.ts
git commit -m "feat(recording): capture layer owns the clock and target resolution"
```

---

### Task 4: 技能库读写日志，不符就重算

**Files:**

- Modify: `src/main/recording/format.ts`（新增 `parseEvents` / `serializeEvents`）
- Modify: `src/main/recording/library.ts`
- Test: `tests/recording-library.test.ts`（扩写）、`tests/recording-format.test.ts`（扩写）

**Interfaces:**

- Consumes: Task 1 的 `LoggedEvent` / `LoggedEventSchema`，Task 2 的 `project()`；现有 `sha256`（`../host/canonical.js`）
- Produces:
  - `format.ts`：`serializeEvents(events: readonly LoggedEvent[]): string`（一行一条 JSON，末尾带换行）、`parseEvents(text: string): LoggedEvent[]`（坏行抛 `RecordingFormatError`，行号从 1 起）
  - `library.ts`：`eventsPath(id): string`、`readEvents(id): Promise<LoggedEvent[] | undefined>`、`create(name, trajectory, events?)`、`write(id, trajectory, events?)`、`read(id): Promise<{ trajectory; markdown; recomputed: boolean }>`；`RecordingSummary` 多一个 `hasEvents`

- [ ] **Step 1: 写失败测试**

`tests/recording-format.test.ts` 追加：

```ts
describe('事件日志的行格式', () => {
  const event = {
    seq: 1,
    at: '2026-09-21T12:00:00.000Z',
    kind: 'scroll' as const,
    url: 'https://example.com/',
    x: 0,
    y: 100,
  };

  it('一行一条，往返相等', () => {
    const text = serializeEvents([event]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(parseEvents(text)).toEqual([event]);
  });

  it('空文本读出空数组', () => {
    expect(parseEvents('')).toEqual([]);
    expect(parseEvents('\n\n')).toEqual([]);
  });

  it('坏行报得出行号', () => {
    const text = `${serializeEvents([event])}{"seq":2,坏\n`;
    expect(() => parseEvents(text)).toThrow(/第 2 行/);
  });
});
```

`tests/recording-library.test.ts` 追加：

```ts
it('create 同时落下轨迹与日志，摘要标出有过程记录', async () => {
  const events = [pageEvent, clickEvent]; // 用 project() 的输出构造轨迹
  const id = await library.create('月度导出', trajectoryOf(events), events);
  expect(await readFile(library.eventsPath(id), 'utf8')).toContain('"kind":"click"');
  expect((await library.list())[0].hasEvents).toBe(true);
});

it('日志被改过时按日志重算轨迹并改写文件', async () => {
  const id = await library.create('月度导出', trajectoryOf(events), events);
  await writeFile(library.eventsPath(id), serializeEvents([...events, extraClickEvent]));
  const first = await library.read(id);
  expect(first.recomputed).toBe(true);
  expect(first.trajectory.entries.filter((e) => e.kind === 'step')).toHaveLength(2);
  // 改写已经落盘：第二次读不再重算
  expect((await library.read(id)).recomputed).toBe(false);
});

it('手工改过的轨迹步骤在重算时被覆盖', async () => {
  const id = await library.create('月度导出', trajectoryOf(events), events);
  const tampered = { ...trajectoryOf(events), entries: [] };
  await writeFile(library.path(id), serializeTrajectory(tampered));
  const { trajectory, recomputed } = await library.read(id);
  expect(recomputed).toBe(true);
  expect(trajectory.entries.length).toBeGreaterThan(0);
});

it('第一期的老录制没有日志，照常读出，不重算', async () => {
  const id = await library.create('老录制', v1Trajectory); // 不传 events
  const { trajectory, recomputed } = await library.read(id);
  expect(recomputed).toBe(false);
  expect(trajectory.meta.version).toBe(1);
  expect((await library.list())[0].hasEvents).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-format.test.ts tests/recording-library.test.ts`
Expected: FAIL，`serializeEvents` / `eventsPath` 不存在。

- [ ] **Step 3: 实现**

`format.ts` 末尾加：

```ts
/** 一行一条 JSON。日志只增不改，所以整份重写时也保持同一种排布。 */
export function serializeEvents(events: readonly LoggedEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

/** 手改过的日志是不可信输入，坏在第几行必须说得出来。 */
export function parseEvents(text: string): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new RecordingFormatError(
        index + 1,
        `第 ${index + 1} 行不是合法 JSON：${String(error)}`,
      );
    }
    const result = LoggedEventSchema.safeParse(raw);
    if (!result.success)
      throw new RecordingFormatError(
        index + 1,
        `第 ${index + 1} 行不是合法的事件：${result.error.issues[0].path.join('.')} ${result.error.issues[0].message}`,
      );
    out.push(result.data);
  }
  return out;
}
```

`library.ts`（顶部 import 补 `sha256`（`../host/canonical.js`）、`project`（`./project.js`）、`parseEvents` / `serializeEvents`（`./format.js`）与 `LoggedEvent` 类型）：

```ts
const EVENTS_FILE = 'events.jsonl';

  eventsPath(id: string): string {
    assertId(id);
    return join(this.root, id, EVENTS_FILE);
  }

  async readEvents(id: string): Promise<LoggedEvent[] | undefined> {
    const text = await this.#readEventsText(id);
    return text === undefined ? undefined : parseEvents(text);
  }

  async #readEventsText(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.eventsPath(id), 'utf8');
    } catch {
      return undefined;
    }
  }
```

`#write` 改成同时落两个文件（仍在 `#serialize` 里，仍走临时文件加 rename 与 0o600），**先写日志再写轨迹**，这样万一中途失败，留下的是「日志比轨迹新」，下次读取会重算并自愈；反过来则会留下一份没有依据的轨迹：

```ts
  async #write(id: string, trajectory: Trajectory, events?: readonly LoggedEvent[]): Promise<void> {
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
    if (events) {
      const target = this.eventsPath(id);
      await writeFile(`${target}.tmp`, serializeEvents(events), { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    }
    const target = this.path(id);
    await writeFile(`${target}.tmp`, serializeTrajectory(trajectory), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }
```

`read` 加重算：

```ts
  async read(id: string): Promise<{ trajectory: Trajectory; markdown: string; recomputed: boolean }> {
    const markdown = await readFile(this.path(id), 'utf8');
    const trajectory = parseTrajectory(markdown);
    const text = await this.#readEventsText(id);
    // 没有日志就是第一期的老录制：md 里的步骤就是全部真相，不动它。
    if (text === undefined) return { trajectory, markdown, recomputed: false };
    const hash = sha256(text);
    if (trajectory.meta.source?.hash === hash) return { trajectory, markdown, recomputed: false };
    // 对不上说明有人动过其中一份。日志赢：按它重算并把 md 改写回去。
    const events = parseEvents(text);
    const rebuilt: Trajectory = {
      meta: {
        ...trajectory.meta,
        version: 2,
        source: { events: events.length, hash },
      },
      entries: project(events).entries,
    };
    await this.write(id, rebuilt);
    return { trajectory: rebuilt, markdown: serializeTrajectory(rebuilt), recomputed: true };
  }
```

`summarize` 多一个参数 `hasEvents: boolean` 并写进返回值；`list()` 里用 `await this.#readEventsText(id) !== undefined` 求它（`read` 已经读过一次，为省一次 IO 可以让 `read` 把这个信息带出来，但不要为此改 `read` 的返回形状 —— 多读一次几十 KB 的文件不值得增加接口复杂度）。

`create(name, trajectory, events?)` 把 `events` 透传给 `#write`，并在写之前把 `meta.source` 补上：

```ts
const meta = events
  ? {
      ...trajectory.meta,
      version: 2 as const,
      source: { events: events.length, hash: sha256(serializeEvents(events)) },
    }
  : trajectory.meta;
await this.#write(id, { ...trajectory, meta: { ...meta, name } }, events);
```

另外改 `serializeTrajectory` 顶部那句说明，让文件自己讲清楚它是算出来的：

```ts
    `录制于 ${parsed.meta.recordedAt}。步骤由同目录的 events.jsonl 算出，时间线又由下方代码块渲染；`,
    `直接修改本文件不作数，下次读取会按事件日志重算。要改请先提炼成技能，在技能库里改。`,
```

没有日志的老录制（`meta.version === 1`）保持原来那句，按 `parsed.meta.source` 是否存在分支。`tests/recording-format.test.ts` 里现有的往返用例断言的是 json 块，不受散文影响；再加一条断言 v2 轨迹的散文里出现「不作数」。

`#rename` 现在读 `read(id)` 会拿到 `recomputed`，忽略它即可；`#rename` 重写轨迹时**不要**传 `events`（日志不因改名而变），`meta.source` 原样保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-format.test.ts tests/recording-library.test.ts`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/format.ts src/main/recording/library.ts tests/recording-format.test.ts tests/recording-library.test.ts
git commit -m "feat(recording): persist the event log and recompute the projection from it"
```

---

### Task 5: 录制编排搬进 `session.ts`，主进程接上新模块

这是本期唯一一个大改，做完之后 `recorder.ts` 才能删。**下面的行号来自对 `main.ts`（3362 行）的一次实测，动手前用 `grep -n` 复核一遍，不要盲信。**

**Files:**

- Create: `src/main/recording/session.ts`、`tests/recording-session.test.ts`
- Delete: `src/main/recording/recorder.ts`、`tests/recording-recorder.test.ts`
- Modify: `src/main/main.ts`、`src/main/recording/index.ts`

**Interfaces:**

- Consumes: Task 3 的 `RecordingCapture`，Task 2 的 `project`，Task 4 的 `library.create(name, trajectory, events)`
- Produces: `createRecordingSession(deps): RecordingSession`

```ts
export interface RecordingSessionDeps {
  /** 取页面适配器与文档 epoch；就是 main.ts 里的 BrowserService。 */
  browser: {
    registry: {
      has(tabId: string): boolean;
      get(tabId: string): { page: RecordingPage; documentEpoch: number };
    };
    observe(input: { principalId: string; tabId: string }): Promise<Observation>;
  };
  library: {
    create(name: string, trajectory: Trajectory, events?: readonly LoggedEvent[]): Promise<string>;
  };
  recordEvent(kind: 'recording', payload: Record<string, unknown>): void;
  /** 状态变了就通知渲染进程；就是 main.ts 的 emit。 */
  emit(): void;
  log(line: string): void;
  /** 当前有别的东西在开浏览器时返回中文原因，录制据此拒绝开始。 */
  busy(): string | undefined;
  principalId: string;
  now?: () => Date;
}

export interface RecordingSession {
  isRecording(): boolean;
  tabId(): string | undefined;
  /** 给 state() 用：步数、超纲数、开始时间、是否已到上限。 */
  snapshot():
    | { tabId: string; startedAt: string; steps: number; unsupported: number; capped: boolean }
    | undefined;
  start(tabId: string): Promise<void>;
  stop(name: string): Promise<string | undefined>;
  /** 地址栏导航；录制的不是这个标签就什么也不做。 */
  navigate(tabId: string, url: string): void;
  /** 前进后退刷新：先挂起原因，落地地址由下一个 page 补。 */
  pendingCause(tabId: string, cause: 'back' | 'forward' | 'reload'): void;
  note(text: string): void;
  /** 文档开始加载：上一份 observe 的序号作废。 */
  dropObservation(tabId: string): void;
  /** 文档加载完：记一条 page，并为新文档预取 observe。 */
  pageLoaded(tabId: string, entry: { url: string; title: string; text: string }): void;
  /** 焦点要离开录制标签了（切标签、关标签、崩溃、退出）：自动停止并保存。 */
  leaveTab(nextTabId: string | undefined, name: string): Promise<void>;
}
```

`RecordingPage` 是 `startRecording({script, bindingName, worldName, onMessage})` / `stopRecording()` 那两个方法的结构类型，照 `src/main/browser/electron-page-adapter.ts:350-352` 的签名写，不要 import Electron 类型。

- [ ] **Step 1: 写失败测试**

`tests/recording-session.test.ts`，全部用假依赖，不碰 Electron：

```ts
function fakeDeps() {
  const created: { name: string; events: unknown[] }[] = [];
  let onMessage: ((payload: string) => void) | undefined;
  return {
    created,
    send: (event: unknown) => onMessage?.(JSON.stringify(event)),
    deps: {
      browser: {
        registry: {
          has: () => true,
          get: () => ({
            documentEpoch: 1,
            page: {
              startRecording: (options: { onMessage: (payload: string) => void }) => {
                onMessage = options.onMessage;
                return Promise.resolve();
              },
              stopRecording: () => Promise.resolve(),
            },
          }),
        },
        observe: () => Promise.resolve({ documentEpoch: 1, elements: [] }),
      },
      library: {
        create: (name: string, _t: unknown, events?: readonly unknown[]) => {
          created.push({ name, events: [...(events ?? [])] });
          return Promise.resolve('slug');
        },
      },
      recordEvent: () => undefined,
      emit: () => undefined,
      log: () => undefined,
      busy: () => undefined,
      principalId: 'local-user',
      now: clock(),
    },
  };
}

it('停止时把日志和轨迹一起交给技能库', async () => {
  const { deps, send, created } = fakeDeps();
  const session = createRecordingSession(deps);
  await session.start('tab-1');
  session.pageLoaded('tab-1', { url: 'https://example.com/', title: '页', text: '' });
  send({ kind: 'click', url: 'https://example.com/', index: 1, el, at: 1 });
  await session.stop('月度导出');
  expect(created).toHaveLength(1);
  expect(created[0].events.map((e: any) => e.kind)).toEqual(['page', 'click']);
});

it('一步都没有就不落盘', async () => {
  const { deps, created } = fakeDeps();
  const session = createRecordingSession(deps);
  await session.start('tab-1');
  session.pageLoaded('tab-1', { url: 'https://example.com/', title: '页', text: '' });
  expect(await session.stop('空的')).toBeUndefined();
  expect(created).toHaveLength(0);
});

it('后退的原因经会话层挂起，落在下一条 page 之前', async () => {
  const { deps, created } = fakeDeps();
  const session = createRecordingSession(deps);
  await session.start('tab-1');
  session.pageLoaded('tab-1', { url: 'https://example.com/', title: '一', text: '' });
  send({ kind: 'click', url: 'https://example.com/', index: 1, el, at: 1 });
  session.pendingCause('tab-1', 'back');
  session.pageLoaded('tab-1', { url: 'https://example.com/list', title: '二', text: '' });
  await session.stop('带后退的');
  expect(created[0].events.map((e: any) => e.kind)).toEqual(['page', 'click', 'navigate', 'page']);
});

it('别的东西在开浏览器时拒绝开始录制', async () => {
  const { deps } = fakeDeps();
  const session = createRecordingSession({ ...deps, busy: () => 'Agent 正在操作页面' });
  await expect(session.start('tab-1')).rejects.toThrow('Agent 正在操作页面');
});

it('切到别的标签会自动停止并保存', async () => {
  const { deps, send, created } = fakeDeps();
  const session = createRecordingSession(deps);
  await session.start('tab-1');
  session.pageLoaded('tab-1', { url: 'https://example.com/', title: '页', text: '' });
  send({ kind: 'click', url: 'https://example.com/', index: 1, el, at: 1 });
  await session.leaveTab('tab-2', '自动保存');
  expect(session.isRecording()).toBe(false);
  expect(created[0].name).toBe('自动保存');
});

it('不是录制的那个标签，事件一概不收', () => {
  const { deps } = fakeDeps();
  const session = createRecordingSession(deps);
  session.pageLoaded('tab-9', { url: 'https://other/', title: '', text: '' });
  expect(session.snapshot()).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-session.test.ts`

- [ ] **Step 3: 实现 `session.ts`**

把 `main.ts` 下面这些整段搬进来，逻辑一行不改，只把对 main.ts 闭包的引用换成 `deps` 上的成员：

| 搬走的                                 | 现在在              | 变成                                                          |
| -------------------------------------- | ------------------- | ------------------------------------------------------------- |
| `ActiveRecording` 类型                 | `main.ts:221-235`   | 模块内部类型，`recorder` 字段换成 `capture: RecordingCapture` |
| `recording` 单例                       | `main.ts:236`       | 模块内部 `let active`                                         |
| `startRecording()`                     | `main.ts:1573-1612` | `start(tabId)`                                                |
| `dropObservation` / `freshObservation` | `main.ts:1615-1628` | 私有函数                                                      |
| `enqueueRecordingEvent`                | `main.ts:1630-1647` | 私有，`onMessage` 里调                                        |
| `recordPageEntry`                      | `main.ts:1650-1666` | `pageLoaded(tabId, entry)`                                    |
| `stopRecording(name)`                  | `main.ts:1669-1696` | `stop(name)`                                                  |
| `leaveRecordingTab`                    | `main.ts:1559-1565` | `leaveTab(next, name)`                                        |

三处语义变化，别漏：

1. `stop()` 里 `active.recorder.finish()` 换成 `const events = active.capture.finish();` 加 `const { entries } = project(events);`，轨迹信封在这里组装（`meta.app/version/name/recordedAt` 照旧，`version` 写 `2`），落盘调 `library.create(name, trajectory, events)`。
2. 「一步都没有就不写盘」这条规则保留：判据仍是 `entries.some((entry) => entry.kind === 'step')`。只有滚动的录制不值得留一堆空目录。
3. `start()` 的拒绝原因来自 `deps.busy()`；main.ts 把现有那几个守卫（`replayRunning()`、`agentReplay`、`distilling`、`isAgentBrowserActive()` 等）包成一个返回中文原因的函数传进来。**不要**在 session 里 import 那些状态。

- [ ] **Step 4: 改 `main.ts` 接线**

1. 顶部 import 去掉 `TrajectoryRecorder`、`RawEventSchema`、`RECORDER_WORLD`、`buildRecorderScript`（它们现在是 session 的事），加 `createRecordingSession`。
2. 建会话：在 `library` 之后加 `const recordingSession = createRecordingSession({ browser, library, recordEvent: (kind, payload) => store.recordEvent(kind, payload), emit, log, busy: recordingBusyReason, principalId: USER_PRINCIPAL });`，并新增一个 `function recordingBusyReason(): string | undefined`，把今天 `startRecording` 里那几条守卫原样搬进去，逐条返回原来的中文消息。
3. 十一个触点逐个改成调会话，不要留任何 `recording?.` 写法：

| 位置                                            | 改成                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `main.ts:806-813` `state()`                     | 读 `recordingSession.snapshot()`                                    |
| `main.ts:931-932` `sync()` 载入开始             | `recordingSession.dropObservation(tabId)`                           |
| `main.ts:941` `sync()` 载入结束                 | `recordingSession.pageLoaded(tabId, entry)`                         |
| `main.ts:1045` 崩溃                             | `void recordingSession.leaveTab(undefined, autoRecordingName())`    |
| `main.ts:1066` `openTab`                        | `void recordingSession.leaveTab(opened.tabId, autoRecordingName())` |
| `main.ts:1090` `closeTab`                       | `void recordingSession.leaveTab(undefined, autoRecordingName())`    |
| `main.ts:1117` `activateTab`                    | `void recordingSession.leaveTab(tabId, autoRecordingName())`        |
| `main.ts:2188-2190` Agent 开标签                | 同 `openTab`                                                        |
| `main.ts:1752` `executeTool`                    | `if (recordingSession.isRecording()) throw …`（原文案不变）         |
| `main.ts:332` / `1577` / `2875` / `3181` 各守卫 | `recordingSession.isRecording()`                                    |
| `main.ts:3328` `shutdown()`                     | `void recordingSession.stop(autoRecordingName())`                   |

4. 两处直接伸手进录制器的，换成会话方法：`main.ts:3081-3084`（`tabNavigate`）改 `recordingSession.navigate(tabId, result.url)`；`main.ts:3272-3276`（`recordingNote`）改 `recordingSession.note(value.text)`。
5. **补上缺口**：`IPC.tabBack`（`main.ts:3087`）、`IPC.tabForward`（`3090`）、`IPC.tabReload`（`3093`）三个处理函数各加一行，在真正执行导航之前：

```ts
handle(IPC.tabBack, undefined, () => {
  const tabId = requireActiveTab();
  recordingSession.pendingCause(tabId, 'back');
  return pages.get(tabId)!.view.webContents.navigationHistory.goBack();
});
```

`tabForward` 用 `'forward'`、`tabReload` 用 `'reload'`，形状相同。注意原来这三个都写成了单表达式箭头函数，改成块体。

6. `IPC.recordingStart` 改成 `() => recordingSession.start(requireActiveTab())`。

- [ ] **Step 5: 删掉旧录制器**

```bash
git rm src/main/recording/recorder.ts tests/recording-recorder.test.ts
```

`src/main/recording/index.ts` 去掉 `export * from './recorder.js';`。

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿，`main.ts` 里不再有 `TrajectoryRecorder` 与 `recording?.` 的引用（`grep -n "TrajectoryRecorder\|recording?\." src/main/main.ts` 应当无输出）。

Run: `pnpm test:e2e -g "录制"`（或现有录制相关用例的标题）
Expected: 第一期那三条录制 E2E 仍然绿。这是这一任务最重要的验收：真实 Electron 里录制、保存、回放没有回归。

- [ ] **Step 7: 提交**

```bash
git add -A src/main src/main/recording tests
git commit -m "refactor(recording): move the recording session out of main.ts and log back/forward/reload"
```

---

### Task 6: 页面脚本补齐滚动、富文本与 iframe 收口

**Files:**

- Modify: `src/main/recording/recorder-script.ts`
- Test: `tests/recording-script.test.ts`

**Interfaces:**

- Consumes: Task 1 已经给 `RawEventSchema` 加好的 `scroll` 与 `edit`
- Produces: 脚本多发两种事件；`input` / `change` / `keydown` 在 iframe 里改发 `unsupported`

- [ ] **Step 1: 写失败测试**（追加到 `tests/recording-script.test.ts`，用文件里现有的 harness）

```ts
it('滚动节流到 400 毫秒一条', () => {
  const { fire, sent, setNow } = mount();
  setNow(1_000);
  fire('scroll', {});
  setNow(1_200);
  fire('scroll', {});
  setNow(1_500);
  fire('scroll', {});
  expect(sent.filter((payload) => payload.kind === 'scroll')).toHaveLength(2);
});

it('contenteditable 只报长度，不报内容', () => {
  const { fire, sent } = mount();
  const editor = makeElement({ tagName: 'div', contentEditable: true, textContent: '机密内容' });
  fire('input', { target: editor });
  const edit = sent.find((payload) => payload.kind === 'edit');
  expect(edit).toMatchObject({ length: 4 });
  expect(JSON.stringify(edit)).not.toContain('机密');
});

it('iframe 里的输入与按键报成 unsupported，且只报一次', () => {
  const { fire, sent } = mount({ inFrame: true });
  fire('input', { target: makeInput('张三') });
  fire('keydown', { target: makeInput('张三'), key: 'Enter' });
  expect(sent.filter((p) => p.kind === 'input' || p.kind === 'key')).toHaveLength(0);
  expect(sent.filter((p) => p.kind === 'unsupported' && p.reason === 'iframe')).toHaveLength(1);
});
```

harness 如果还没有 `setNow` / `inFrame` 这两个开关，本任务顺手加上：脚本里的 `now()` 与 `inFrame` 都要能在测试里控制。`mount()` 现有签名不要改破，给它加可选参数。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-script.test.ts`

- [ ] **Step 3: 改脚本**

在 `buildRecorderScript` 返回的源码里，`on('pointerdown', …)` 那几行之后加：

```js
const SCROLL_MS = 400;
let lastScroll = 0;
on('scroll', () => {
  if (inFrame) return;
  const at = now();
  if (at - lastScroll < SCROLL_MS) return;
  lastScroll = at;
  send({
    kind: 'scroll',
    url: href(),
    at,
    x: Math.round(w.scrollX || 0),
    y: Math.round(w.scrollY || 0),
  });
});

// iframe 里的输入类事件只报一次：每个键都报会把日志灌满。
let framedInputReported = false;
const framedInput = () => {
  if (framedInputReported) return true;
  framedInputReported = true;
  unsupported('iframe');
  return true;
};
```

`on('input', …)` 改成（保持原有的密码判断不动）：

```js
  on('input', (event) => {
    if (inFrame) { framedInput(); return; }
    const raw = event.target;
    // contenteditable 不在 OBSERVE_SELECTOR 里，scoped() 会返回 null，
    // 所以这一支必须在 scoped 的提前返回之前，否则富文本输入永远录不到。
    if (raw && raw.isContentEditable) {
      emit('edit', raw, { length: String(raw.textContent || '').length });
      return;
    }
    const el = scoped(raw);
    …以下不变…
  });
```

`on('change', …)` 与 `on('keydown', …)` 各在函数体第一行加 `if (inFrame) { framedInput(); return; }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-script.test.ts`
Expected: 新旧用例全绿。脚本里 `isTrusted` 过滤、密码与验证码不带值、`detail === 0` 的补发点击不算点击这三条，断言必须仍然通过。

- [ ] **Step 5: 提交**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/recorder-script.ts tests/recording-script.test.ts
git commit -m "feat(recording): record scrolling and rich-text edits, refuse iframe input"
```

---

### Task 7: 提炼时附上过程

**Files:**

- Modify: `src/main/recording/distill.ts`
- Test: `tests/recording-distill.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LoggedEvent`
- Produces: `renderEvents(events: readonly LoggedEvent[], limit?: number): string`；`buildDistillPrompt(name, trajectoryMarkdown, process?)` 多一个可选参数

**对账（`reconcile`）本任务一行不改。** 过程只是给 Agent 的上下文，步骤仍然只能来自轨迹块。

- [ ] **Step 1: 写失败测试**

```ts
describe('renderEvents', () => {
  it('连续滚动折叠成一行', () => {
    const text = renderEvents([scroll(1), scroll(2), scroll(3)]);
    expect(text).toContain('滚动了 3 次');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('同一字段的连续输入只留最终值并注明改了几次', () => {
    const text = renderEvents([input(1, '张'), input(1, '张三'), input(1, '张三丰')]);
    expect(text).toContain('张三丰');
    expect(text).toContain('改了 3 次');
    expect(text).not.toContain('"张"');
  });

  it('超过三秒的间隔插一行停顿', () => {
    const text = renderEvents([clickAt('12:00:00'), clickAt('12:00:09')]);
    expect(text).toContain('停顿 9 秒');
  });

  it('总行数封顶，中间折叠', () => {
    const many = Array.from({ length: 800 }, (_, n) => clickAt('12:00:00', n + 1));
    const lines = renderEvents(many, 300).trim().split('\n');
    expect(lines).toHaveLength(301); // 150 + 省略行 + 150
    expect(lines[150]).toContain('省略');
  });

  it('密码事件只说填了密码，不带任何值', () => {
    expect(renderEvents([secret(1, false)])).toContain('填写密码');
  });
});

describe('buildDistillPrompt 带过程', () => {
  it('过程放在轨迹原文之后，并说明它只是上下文', () => {
    const prompt = buildDistillPrompt('月度导出', '轨迹原文', '过程原文');
    expect(prompt.indexOf('过程原文')).toBeGreaterThan(prompt.indexOf('轨迹原文'));
    expect(prompt).toContain('步骤仍然只能从 pilion-trajectory 代码块里挑选');
  });

  it('不给过程时与今天一字不差', () => {
    expect(buildDistillPrompt('月度导出', '轨迹原文')).toBe(PROMPT_BEFORE_PHASE_3);
  });
});
```

最后一条用一个文件内常量存今天的完整 prompt 文本（从当前实现复制），这样以后谁改了固定说明都会被这条测试拦住。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-distill.test.ts`

- [ ] **Step 3: 实现**

`renderEvents` 的骨架（时间差用 `Date.parse` 算，纯函数，不读当前时间）：

```ts
const GAP_MS = 3_000;

/** 给 Agent 与人看的过程时间线。只折叠，不解释，不猜意图。 */
export function renderEvents(events: readonly LoggedEvent[], limit = 300): string {
  const lines: string[] = [];
  let previousAt: number | undefined;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const at = Date.parse(event.at);
    if (previousAt !== undefined && at - previousAt >= GAP_MS)
      lines.push(`- 停顿 ${Math.round((at - previousAt) / 1000)} 秒`);
    previousAt = at;
    if (event.kind === 'scroll') {
      let run = 1;
      while (events[index + 1]?.kind === 'scroll') {
        index += 1;
        run += 1;
      }
      previousAt = Date.parse(events[index].at);
      lines.push(`- 滚动了 ${run} 次`);
      continue;
    }
    if (event.kind === 'input') {
      let run = 1;
      let last = event;
      while (
        events[index + 1]?.kind === 'input' &&
        (events[index + 1] as typeof event).index === event.index
      ) {
        index += 1;
        last = events[index] as typeof event;
        run += 1;
      }
      previousAt = Date.parse(last.at);
      const times = run > 1 ? `（改了 ${run} 次）` : '';
      lines.push(
        `- 在 "${last.target.name || last.el.tagName}" 里填 "${oneLine(last.value)}"${times}`,
      );
      continue;
    }
    lines.push(`- ${describeLoggedEvent(event)}`);
  }
  return clamp(lines, limit).join('\n');
}
```

`describeLoggedEvent` 逐种给一句中文；`secret` 只说「填写密码」或「填写验证码」，`edit` 说「在富文本里输入了 N 个字」，`unsupported` 复用现有三种原因的说法，`navigate` 带上 `cause` 的中文（地址栏 / 后退 / 前进 / 刷新）。所有插值都要过 `oneLine`（`format.ts` 已有同名函数，把它导出复用，不要再写一份）。

`clamp(lines, limit)`：不超就原样返回；超了取前 `limit/2`、一行 `- 省略 N 条`、后 `limit/2`。

`buildDistillPrompt` 的改动只有两处：签名多一个 `process?: string`；有它时在 `trajectoryMarkdown` 之后追加

```ts
      '',
      '过程记录（你在浏览器里看不到的那部分）：',
      '',
      process,
      '',
      '过程记录是给你判断「什么时候用」「前置条件」「已知坑」和哪些步骤是误操作用的上下文。步骤仍然只能从 pilion-trajectory 代码块里挑选、合并、重排。',
```

- [ ] **Step 4: 跑测试并提交**

```bash
pnpm vitest run tests/recording-distill.test.ts
pnpm typecheck && pnpm lint && pnpm test
git add src/main/recording/distill.ts src/main/recording/format.ts tests/recording-distill.test.ts
git commit -m "feat(recording): hand the Agent the process, not just the steps"
```

---

### Task 8: 提炼状态机搬出 `main.ts`，顺手修一个死标志

**Files:**

- Create: `src/main/recording/distillation.ts`、`tests/recording-distillation.test.ts`
- Modify: `src/main/main.ts`

**Interfaces:**

- Consumes: `reconcile` / `unsupportedSteps` / `extractSkillMarkdown` / `stepsHash`（`distill.ts` 已有）、`parseSkill` / `serializeSkill`、Task 7 的 `renderEvents`
- Produces: `class DistillationState`，构造参数 `{ library, recordEvent, emit, refreshSkills }`，方法 `claim(id)` / `release()` / `begin(id, name, conversationId)` / `accept(input)` / `reject(input)` / `keep()` / `discard()` / `finish()`；只读属性 `running` / `pending` / `rejected` / `busyReasonFor(id)`

**搬多少，不搬什么。** 实测表明 `startDistillation` 与通用 prompt 循环共用 `promptActive` / `connectionBusy` / `agentStatus` / `activeResponseId` / `taskId` / `lastError` / `promptCancelled` 七个可变字段，还会调用 `connectAgent`。**那部分不搬**：对话与 prompt 的编排留在 `main.ts`，搬走的是提炼自己的状态机（四个变量与接受、保留、丢弃、校验）。硬把 prompt 循环拆出来要动 `executeAgentTask` 与 `connectAgent`，那是本期范围之外的事，会把一个可控的重构变成一次大改。

**顺手修的缺陷：`pendingSkillManual` 是死的。** 它在四处被重置成 `[]`，从来没有被赋过计算值，所以提炼预览里每一步的 `manual` 标志恒为 false；而已保留技能的详情走 `unsupportedSteps(skill, trajectory)` 算得好好的。搬进新模块时在 `accept` 里补上这次计算。

- [ ] **Step 1: 写失败测试**（`tests/recording-distillation.test.ts`，全假依赖）

```ts
it('Agent 凭空造的步骤会被拒绝，pending 保持空', () => {
  const state = new DistillationState(fakeDeps());
  const result = state.accept({ ...base, reply: replyWithInventedClick });
  expect(result.ok).toBe(false);
  expect(state.pending).toBeUndefined();
  expect(state.rejected?.reason).toContain('没有依据');
});

it('接受时把需要人做的步骤算出来，不再是恒 false', () => {
  const state = new DistillationState(fakeDeps());
  state.accept({ ...base, reply: replyWithHumanStep });
  expect(state.pending?.manual).toEqual([1]);
});

it('保留才落盘，丢弃什么也不写', async () => {
  const deps = fakeDeps();
  const state = new DistillationState(deps);
  state.accept({ ...base, reply: goodReply });
  state.discard();
  expect(deps.written).toHaveLength(0);
  state.accept({ ...base, reply: goodReply });
  await state.keep();
  expect(deps.written).toHaveLength(1);
});

it('同一份录制正在提炼或有待决预览时，改名与删除要被挡住', () => {
  const state = new DistillationState(fakeDeps());
  state.begin('monthly', '月度导出', 'conv-1');
  expect(state.busyReasonFor('monthly')).toBeTruthy();
  expect(state.busyReasonFor('another')).toBeUndefined();
});
```

- [ ] **Step 2-3: 实现并把 `main.ts` 接过去**

`main.ts` 的改动：

1. `main.ts:293-310` 的四个模块级变量删掉，换成 `const distillation = new DistillationState({ library, recordEvent: …, emit, refreshSkills });`
2. `main.ts:650-729` 的 `acceptDistillation` / `keepDistilled` / `discardDistilled` 整体搬走；`startDistillation`（`554-648`）留在原地，但把它对四个变量的读写换成 `distillation.*`，并在读轨迹之后加上过程：

```ts
const events = await library.readEvents(id);
const prompt = buildDistillPrompt(
  name,
  markdown,
  events?.length ? renderEvents(events) : undefined,
);
```

3. `main.ts:816-828` `state()`、`3287` / `3294`（`skillsRemove` / `skillsRename` 的内联守卫）、`333` / `560` / `1577` / `1753`（各处 `distilling` 守卫）全部改成调 `distillation` 上的只读属性或 `busyReasonFor`。
4. `main.ts:1698-1709` `skillStepViews` 同时服务提炼预览与已保留技能详情，**留在 `main.ts`**，由新模块通过构造参数拿不到它 —— 让 `accept` 返回步骤与 `manual` 下标，视图仍在 `main.ts` 组装。
5. `shutdown()`（`main.ts:3331`）现在只调 `discardDistilled()`，不清 `distilling` / `distillStarting`；改成 `distillation.finish()`，一次把四个状态都清干净。

- [ ] **Step 4: 验证并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Run: `pnpm test:e2e -g "提炼"`（第二期那条提炼 E2E）
Expected: 全绿。

```bash
git add src/main/recording/distillation.ts src/main/main.ts tests/recording-distillation.test.ts
git commit -m "refactor(recording): distillation state machine leaves main.ts, manual steps computed"
```

---

### Task 9: 契约、preload 与「过程」视图

**Files:**

- Modify: `src/shared/contracts.ts`、`src/preload/index.ts`、`src/preload/entry.cts`、`src/main/main.ts`
- Create: `src/renderer/SkillEditor.tsx`
- Modify: `src/renderer/SkillLibrary.tsx`
- Test: `tests/contracts.test.ts`

**Interfaces:**

- Produces: `RecordingSummary.hasEvents: boolean`；IPC `recordingsEvents`，入参 `{ id: string }`，返回 `{ lines: string[]; capped: boolean }`；`window.pilion.skills.events(id)`

- [ ] **Step 1: 契约与两份 preload**

`src/shared/contracts.ts`：`RecordingSummary` 加 `hasEvents: boolean`；`IPC` 加 `recordingsEvents: 'recordings:events'`；加 `SkillEventsArgsSchema = z.object({ id: z.string().min(1).max(60) }).strict()`。

`src/preload/index.ts` 与 `src/preload/entry.cts` **同时**加 `events: (id: string) => invoke(IPC.recordingsEvents, { id })` 到 `skills` 组里。两份的方法名、参数对象形状、channel 常量必须一字不差 —— 第一期在这里栽过一次，`index.ts` 只供类型，`entry.cts` 才是 Electron 真正加载的。

`tests/contracts.test.ts` 加一条：两份 preload 暴露的 `skills` 方法名集合相同（现有测试若已覆盖就扩断言）。

- [ ] **Step 2: 主进程渲染，不把两万条事件送过桥**

`main.ts` 加处理函数：

```ts
handle(IPC.recordingsEvents, SkillEventsArgsSchema, async (value) => {
  const events = await library.readEvents(value.id);
  if (!events) return { lines: [], capped: false };
  return {
    lines: renderEvents(events).split('\n').filter(Boolean),
    capped: events.length >= 20_000,
  };
});
```

- [ ] **Step 3: 界面**

`SkillLibrary.tsx` 现在 547 行，本任务先把编辑器整块搬进 `src/renderer/SkillEditor.tsx`（props 为它今天从父组件用到的那些，不要顺手改行为），再加「过程」视图：与「步骤」「原始轨迹」并列的第三个 tab，只在 `selected.hasEvents` 为真时出现，进入时调 `window.pilion.skills.events(id)`，把 `lines` 渲染成只读列表；`capped` 为真时顶部一行说明「录制到达上限，后面的过程没有记下」。

轨迹视图顶部补一句：「步骤是从过程记录算出来的，直接改这个文件不作数；要改请提炼成技能后再改。」

**不要**给轨迹视图加任何编辑入口。

- [ ] **Step 4: 验证并提交**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
git add src/shared/contracts.ts src/preload src/main/main.ts src/renderer tests/contracts.test.ts
git commit -m "feat(renderer): a read-only process view for a recording"
```

---

### Task 10: E2E、文档与更新日志

**Files:**

- Modify: `tests/electron.e2e.ts`、`docs/architecture.md`、`CHANGELOG.md`

- [ ] **Step 1: E2E**

在现有录制用例旁边加一条：在测试页面上滚动、按后退、在一个 `contenteditable` 里输入，停止录制后

- 录制目录里存在 `events.jsonl`，行数大于步骤数
- 技能库「过程」视图能看到「滚动了 N 次」与「停顿 N 秒」
- 步骤视图里后退是一条 `navigate`，富文本是一条「需要我」

沿用现有 E2E 的等待方式，不要引入新的轮询工具。测试页面用 `tests/fixtures` 下已有的本地页面，**不要**依赖外网站点（本机已经因为外网重定向慢导致过假失败）。

- [ ] **Step 2: 文档**

`docs/architecture.md` 四处（动手前用 `grep -n` 复核行号）：

- 模块表 `main/recording` 那一行（约 41 行）：职责改成「录制脚本、事件日志采集、纯投影、目标匹配、回放状态机、技能库目录」
- 「录制与技能」里讲轨迹文件敏感度的那段（约 111 行）：补 `events.jsonl` 存什么、同样 `0o600`、同样含键入文本；讲清楚轨迹是算出来的
- 说「归一化全部在 `recording/recorder.ts` 完成」的那句（约 113 行）：改成采集与投影两层
- 测试覆盖那段（约 137 行）：把新测试文件列进去

- [ ] **Step 3: 更新日志**

`CHANGELOG.md` 的 `[未发布]` 段落加三条中文条目：录制现在记录完整过程（滚动、前进后退刷新、富文本都在案）；提炼时 Agent 读得到过程；技能库多了「过程」视图。另加一条说明轨迹是算出来的、可直接编辑的是技能文件 —— 0.1.3 那条「文件是普通 Markdown，可以直接改」的范围要在这里收窄。

- [ ] **Step 4: 全量验证并提交**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm test:e2e
git add tests/electron.e2e.ts docs/architecture.md CHANGELOG.md
git commit -m "test(recording): end-to-end coverage for the process log, plus docs"
```
