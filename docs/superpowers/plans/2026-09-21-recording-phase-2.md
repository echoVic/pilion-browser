# 录制与技能 第二期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 能把人录的轨迹提炼成技能文档（不能凭空造步骤），任意 ACP Agent 能通过 MCP 发现并回放已提炼的技能（首次一次审批，卡住交还），人能在技能库里有限度地修改技能。

**Architecture:** 技能是第二个 fenced-json 文件 `skill.md`，与轨迹同一套解析约定。提炼在一个专属对话里跑一次普通 ACP prompt，主进程从回合文本里取块、校验、按四条对账规则与轨迹逐步对账，人按保留才落盘。Agent 的 `browser.skills.play` 走既有 `runTool` 主路径（Intent → 审批 → `executePreparedAction` → `performTool`），播放器只是它执行阶段的一个内层 `ToolRequest` 调用方；每一步 Intent 仍记在 Agent 的 attachment 下，人的编辑经主进程校验后整体重写文件。

**Tech Stack:** TypeScript 5.9 / Electron 44 / React 19 / zod 4 / vitest 5 / Playwright（Electron E2E）/ `node:sqlite` / `@modelcontextprotocol/sdk` 1.30

**Spec:** `docs/superpowers/specs/2026-09-21-recording-phase-2-design.md`（第一期不变量见 `docs/superpowers/specs/2026-09-20-recording-and-skills-design.md`）

## Global Constraints

- **不新增运行时依赖。** 运行时只允许 `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod` 三个
- **`src/` 内部 import 必须带 `.js` 扩展名**（ESM）；`tests/` 内 import 不带扩展名
- **界面文案中文**；错误消息中文；MCP 工具描述英文（现有工具如此）
- **commit message 英文**，conventional commits，与 `git log` 风格一致
- **两个 preload 都要改**：`src/preload/index.ts` 只供类型，`src/preload/entry.cts` 才是 Electron 加载的；方法名、参数对象、channel 常量必须一致，E2E 边界测试钉着 `window.pilion.recording` / `.skills` 的方法名
- **Agent 只能通过 MCP 读技能摘要与回放**；写技能目录的只有 Pilion（提炼保留、界面保存）和人
- **提炼那一轮没有浏览器工具**；对账在主进程执行，Agent 输出是不可信文本
- **`skills:save` 的"不能新建动作步骤"在主进程校验**，不依赖界面
- 占位符唯一判定处：`isPlaceholder()`，正则 `/^\{\{[^{}]{1,60}\}\}$/`
- 命令：`pnpm test`（vitest）、`pnpm typecheck`、`pnpm lint`、`pnpm format`、`pnpm build`、`pnpm test:e2e`；单个文件 `pnpm vitest run tests/<file>.test.ts`
- 基线：`main` @ `61b7697`，单测 21 文件 / 229 用例，E2E 全绿（本机有一条与本功能无关的既有失败：PATH 上的 `codex` shim）

## 文件结构

新增：

| 文件                                   | 职责                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/recording/distill.ts`        | 提炼 prompt、从回合文本取 skill 文档、`stepsHash`、四条对账 `reconcile`、非阻塞 `unsupportedSteps`、编辑校验 `validateSkillEdit` |
| `tests/recording-skill-format.test.ts` | Task 1                                                                                                                           |
| `tests/recording-distill.test.ts`      | Task 3                                                                                                                           |
| `tests/browser-mcp-server.test.ts`     | Task 5                                                                                                                           |

修改：

| 文件                                                                                                                      | 改动                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/recording/types.ts`                                                                                             | `SkillSchema` / `Skill`、`PLACEHOLDER_PATTERN` / `isPlaceholder`                                                                                                                                             |
| `src/main/recording/format.ts`                                                                                            | `parseSkill` / `serializeSkill`；`locateBlock` 多返回 `openLine`                                                                                                                                             |
| `src/main/recording/library.ts`                                                                                           | `hasSkill` / `readSkill` / `writeSkill`；summary 的 `distilled` / `about`、计数取自技能                                                                                                                      |
| `src/main/recording/player.ts`                                                                                            | 占位符步骤视为 `human`                                                                                                                                                                                       |
| `src/main/recording/index.ts`                                                                                             | 导出 `distill.js`                                                                                                                                                                                            |
| `src/main/host/canonical.ts`                                                                                              | 空白页允许 `browser.skills.list` / `browser.skills.play`                                                                                                                                                     |
| `src/main/agents/browser-mcp-server.ts`                                                                                   | 两个工具                                                                                                                                                                                                     |
| `src/shared/contracts.ts`                                                                                                 | `ToolNameSchema` 两项、`SkillsPlayArgsSchema`、`RecordingSummary.distilled/about`、`SkillDetail` 扩展、`DistillationState`、`AgentReplayState`、`ConversationTask.replayCursor`、`SkillSaveSchema`、IPC 常量 |
| `src/preload/index.ts` + `src/preload/entry.cts`                                                                          | `skills.distill / keep / discard / save`                                                                                                                                                                     |
| `src/main/main.ts`                                                                                                        | 提炼编排；`runTool` 的 list / play；`Actor.replayApproval`；`approvedSkills`；`agentReplay` 互斥与取消；`replayCursor` 交接；`skills:save` 校验；`skillDetail` 扩展                                          |
| `src/renderer/SkillLibrary.tsx` + `src/renderer/main.tsx` + `src/renderer/style.css`                                      | 编辑、预览、提炼状态、Agent 回放 detail                                                                                                                                                                      |
| `tests/fixtures/e2e-agent.mjs`                                                                                            | 「提炼」与「用技能」两个分支                                                                                                                                                                                 |
| `tests/electron.e2e.ts`                                                                                                   | 四个 E2E                                                                                                                                                                                                     |
| `tests/contracts.test.ts`、`tests/host-core.test.ts`、`tests/recording-library.test.ts`、`tests/recording-player.test.ts` | 扩展                                                                                                                                                                                                         |
| `docs/architecture.md`、`CHANGELOG.md`、`README.md`                                                                       | 文档                                                                                                                                                                                                         |

---

### Task 1: `skill.md` 的类型与格式

**Files:**

- Modify: `src/main/recording/types.ts`
- Modify: `src/main/recording/format.ts`
- Test: `tests/recording-skill-format.test.ts`

**Interfaces:**

- Consumes: `StepSchema`（第一期）
- Produces:
  - `PLACEHOLDER_PATTERN`、`isPlaceholder(value: string): boolean`
  - `SkillSchema` / `type Skill = { meta: { app:'pilion'; version:1; kind:'skill'; name; about; recordedAt; distilledBy; trajectory:'trajectory.md' }; steps: Step[] }`
  - `parseSkill(md: string): { prose: string; skill: Skill }`
  - `serializeSkill(prose: string, skill: Skill): string`

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-skill-format.test.ts`：

````ts
import { describe, expect, it } from 'vitest';
import {
  RecordingFormatError,
  isPlaceholder,
  parseSkill,
  serializeSkill,
  type Skill,
} from '../src/main/recording/index';

const skill: Skill = {
  meta: {
    app: 'pilion',
    version: 1,
    kind: 'skill',
    name: '月度导出',
    about: '登录后选月份并导出 CSV',
    recordedAt: '2026-09-20T14:03:11+08:00',
    distilledBy: 'claude-code',
    trajectory: 'trajectory.md',
  },
  steps: [
    { kind: 'navigate', url: 'https://report.example.com/login' },
    {
      kind: 'type',
      onUrl: 'https://report.example.com/login',
      target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
      text: '{{邮箱}}',
      replace: true,
    },
    { kind: 'human', onUrl: 'https://report.example.com/login', reason: '填写密码' },
    {
      kind: 'click',
      onUrl: 'https://report.example.com/login',
      target: { role: 'button', name: '登录', tagName: 'button' },
    },
  ],
};
const prose = [
  '# 月度导出',
  '',
  '## 什么时候用',
  '',
  '每月初要给财务那份 CSV 时。',
  '',
  '## 前置条件',
  '',
  '- 已登录',
  '',
  '## 已知坑',
  '',
  '- 无',
].join('\n');

describe('skill format', () => {
  it('serialize 后再 parse 得到同一份技能，散文原样保留', () => {
    const md = serializeSkill(prose, skill);
    expect(md).toContain('```json pilion-skill');
    const parsed = parseSkill(md);
    expect(parsed.skill).toEqual(skill);
    expect(parsed.prose).toBe(prose);
  });

  it('散文为空时用名字生成一行标题', () => {
    expect(parseSkill(serializeSkill('', skill)).prose).toBe('# 月度导出');
  });

  it('没有 pilion-skill 块时报错并指出行号', () => {
    try {
      parseSkill('# 月度导出\n\n什么都没有\n');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingFormatError);
      expect((error as RecordingFormatError).line).toBe(1);
      expect((error as RecordingFormatError).message).toContain('pilion-skill');
    }
  });

  it('meta.kind 不是 skill 时被拒绝', () => {
    const md = serializeSkill(prose, skill).replace('"kind": "skill"', '"kind": "trajectory"');
    expect(() => parseSkill(md)).toThrow(RecordingFormatError);
  });

  it('about 超过 200 字被拒绝', () => {
    const md = serializeSkill(prose, { ...skill, meta: { ...skill.meta, about: 'x'.repeat(201) } });
    expect(() => parseSkill(md)).toThrow(RecordingFormatError);
  });

  it('轨迹文件不会被当成技能读取', () => {
    const md = serializeSkill(prose, skill).replace(
      '```json pilion-skill',
      '```json pilion-trajectory',
    );
    expect(() => parseSkill(md)).toThrow(/pilion-skill/);
  });
});

describe('isPlaceholder', () => {
  it('只认 {{…}} 且内容不含花括号、不超过 60 字', () => {
    expect(isPlaceholder('{{邮箱}}')).toBe(true);
    expect(isPlaceholder('{{ 公司邮箱地址 }}')).toBe(true);
    expect(isPlaceholder('me@x.com')).toBe(false);
    expect(isPlaceholder('{{}}')).toBe(false);
    expect(isPlaceholder('{{a{b}}')).toBe(false);
    expect(isPlaceholder(`{{${'x'.repeat(61)}}}`)).toBe(false);
    expect(isPlaceholder('前缀{{邮箱}}')).toBe(false);
  });
});
````

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-skill-format.test.ts`
Expected: FAIL，`parseSkill` / `isPlaceholder` 不存在

- [ ] **Step 3: `src/main/recording/types.ts` 加占位符与技能 schema**

在文件末尾加：

```ts
/** 占位符的唯一判定处：提炼用它隐去个人数据，回放到这一步交给人。 */
export const PLACEHOLDER_PATTERN = /^\{\{[^{}]{1,60}\}\}$/;
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

export const SkillSchema = z
  .object({
    meta: z
      .object({
        app: z.literal('pilion'),
        version: z.literal(1),
        kind: z.literal('skill'),
        name: z.string().min(1).max(120),
        about: z.string().max(200),
        recordedAt: z.string().min(1).max(64),
        /** 提炼它的 Agent 配置 id；人手工创建时为 'person'。 */
        distilledBy: z.string().min(1).max(120),
        trajectory: z.literal('trajectory.md'),
      })
      .strict(),
    steps: z.array(StepSchema).max(500),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;
```

- [ ] **Step 4: `src/main/recording/format.ts` 加 `parseSkill` / `serializeSkill`**

把 import 行改为：

```ts
import {
  SkillSchema,
  TrajectorySchema,
  type Skill,
  type Step,
  type Trajectory,
  type TrajectoryEntry,
} from './types.js';
```

`locateBlock` 改为同时返回开栏行的下标（0 起），其余调用不受影响：

````ts
const SKILL_TAG = 'pilion-skill';

function locateBlock(
  md: string,
  tag: string,
): { body: string; startLine: number; openLine: number } {
  const lines = md.split('\n');
  const open = lines.findIndex((line) => line.trim() === `\`\`\`json ${tag}`);
  if (open < 0)
    throw new RecordingFormatError(1, `文件里找不到 \`\`\`json ${tag} 代码块，无法读取`);
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```');
  if (close < 0) throw new RecordingFormatError(open + 1, `\`\`\`json ${tag} 代码块没有闭合`);
  return { body: lines.slice(open + 1, close).join('\n'), startLine: open + 2, openLine: open };
}
````

在 `parseTrajectory` 之后加：

````ts
/** 块上方的散文原样保留、不解析；块是唯一真相。 */
export function parseSkill(md: string): { prose: string; skill: Skill } {
  const raw = parseBlock(md, SKILL_TAG);
  const { startLine, openLine } = locateBlock(md, SKILL_TAG);
  const result = SkillSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RecordingFormatError(
      startLine,
      `技能内容不合法：${issue.path.join('.')} ${issue.message}`,
    );
  }
  const prose = md.split('\n').slice(0, openLine).join('\n').trimEnd();
  return { prose, skill: result.data };
}

export function serializeSkill(prose: string, skill: Skill): string {
  const parsed = SkillSchema.parse(skill);
  const head = prose.trimEnd() || `# ${parsed.meta.name}`;
  return [head, '', `\`\`\`json ${SKILL_TAG}`, JSON.stringify(parsed, null, 2), '```', ''].join(
    '\n',
  );
}
````

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-skill-format.test.ts tests/recording-format.test.ts`
Expected: 两个文件全部 PASS（后者证明 `locateBlock` 的改动没有破坏轨迹解析）

- [ ] **Step 6: 类型检查、lint、格式化**

Run: `pnpm typecheck && pnpm lint && pnpm format`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add src/main/recording/types.ts src/main/recording/format.ts tests/recording-skill-format.test.ts
git commit -m "feat(recording): skill.md format and the placeholder rule

A skill is a second fenced-json file next to the trajectory: the prose
above the block is kept verbatim and never parsed, the block is the
only truth. A value shaped {{…}} is a placeholder, decided in exactly
one place."
```

---

### Task 2: 技能库读写技能文件

**Files:**

- Modify: `src/shared/contracts.ts`（`RecordingSummary`）
- Modify: `src/main/recording/library.ts`
- Test: `tests/recording-library.test.ts`（追加）

**Interfaces:**

- Consumes: `parseSkill` / `serializeSkill` / `Skill`（Task 1）
- Produces:
  - `RecordingSummary` 新增 `distilled: boolean`、`about?: string`；已提炼时 `steps` / `needsHuman` 取自技能步骤
  - `library.skillPath(id): string`
  - `library.hasSkill(id): Promise<boolean>`
  - `library.readSkill(id): Promise<{ prose: string; skill: Skill; markdown: string }>`
  - `library.writeSkill(id, prose, skill): Promise<void>`（走写队列）

- [ ] **Step 1: 写下失败的测试**

在 `tests/recording-library.test.ts` 的 import 里加 `type Skill`，文件末尾加：

````ts
const skill: Skill = {
  meta: {
    app: 'pilion',
    version: 1,
    kind: 'skill',
    name: '月度导出',
    about: '登录后选月份并导出 CSV',
    recordedAt: '2026-09-20T14:03:11+08:00',
    distilledBy: 'claude-code',
    trajectory: 'trajectory.md',
  },
  steps: [
    { kind: 'navigate', url: 'https://report.example.com/' },
    { kind: 'human', onUrl: 'https://report.example.com/', reason: '填写密码' },
  ],
};

describe('RecordingLibrary skills', () => {
  it('没有 skill.md 时 hasSkill 为 false，summary 标 distilled=false', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    expect(await library.hasSkill(id)).toBe(false);
    expect((await library.list())[0]).toMatchObject({ id, distilled: false, steps: 3 });
  });

  it('writeSkill 后 hasSkill 为 true，readSkill 往返，summary 的计数与 about 取自技能', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await library.writeSkill(id, '# 月度导出\n\n## 什么时候用\n\n月初。', skill);
    expect(await library.hasSkill(id)).toBe(true);
    const loaded = await library.readSkill(id);
    expect(loaded.skill).toEqual(skill);
    expect(loaded.prose).toBe('# 月度导出\n\n## 什么时候用\n\n月初。');
    expect(loaded.markdown).toContain('```json pilion-skill');
    expect((await library.list())[0]).toMatchObject({
      id,
      distilled: true,
      about: '登录后选月份并导出 CSV',
      steps: 2,
      needsHuman: 1,
    });
    const mode = (await stat(join(root, id, 'skill.md'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('坏的 skill.md 让 summary 带 error 且 distilled=false，轨迹仍可读', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await writeFile(join(root, id, 'skill.md'), '# 手改坏了\n没有代码块\n');
    const [row] = await library.list();
    expect(row).toMatchObject({
      id,
      distilled: false,
      error: expect.stringContaining('pilion-skill'),
    });
    expect((await library.read(id)).trajectory).toEqual(trajectory);
  });

  it('remove 连 skill.md 一起删', async () => {
    const library = new RecordingLibrary(root);
    const id = await library.create('月度导出', trajectory);
    await library.writeSkill(id, '', skill);
    await library.remove(id);
    expect(await library.list()).toEqual([]);
  });
});
````

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-library.test.ts`
Expected: 新用例 FAIL，`hasSkill is not a function`

- [ ] **Step 3: `src/shared/contracts.ts` 扩展 `RecordingSummary`**

在 `RecordingSummary` 接口里 `recordedAt: string;` 之后加：

```ts
  /** 有 skill.md 才算已提炼；Agent 只看得到已提炼的。 */
  distilled: boolean;
  about?: string;
```

- [ ] **Step 4: `src/main/recording/library.ts` 加技能读写**

import 改为：

```ts
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordingSummary } from '../../shared/contracts.js';
import { parseSkill, parseTrajectory, serializeSkill, serializeTrajectory } from './format.js';
import type { Skill, Trajectory } from './types.js';
```

`const FILE = 'trajectory.md';` 之后加 `const SKILL_FILE = 'skill.md';`。

`summarize` 改为接受可选技能：

```ts
function summarize(id: string, trajectory: Trajectory, skill?: Skill): RecordingSummary {
  const steps = skill
    ? skill.steps.map((step) => ({ step, unsupported: undefined }))
    : trajectory.entries.flatMap((entry) => (entry.kind === 'step' ? [entry] : []));
  return {
    id,
    name: skill?.meta.name ?? trajectory.meta.name,
    steps: steps.length,
    unsupported: steps.filter((entry) => entry.unsupported).length,
    needsHuman: steps.filter((entry) => entry.step.kind === 'human').length,
    recordedAt: trajectory.meta.recordedAt,
    distilled: Boolean(skill),
    ...(skill ? { about: skill.meta.about } : {}),
  };
}
```

`list()` 里的 `try` 块改为：

```ts
        try {
          const { trajectory } = await this.read(id);
          const skill = (await this.hasSkill(id)) ? (await this.readSkill(id)).skill : undefined;
          return summarize(id, trajectory, skill);
        } catch (error) {
```

catch 块里构造的对象加 `distilled: false,`（在 `recordedAt: '',` 之后）。

在 `path(id)` 之后加：

```ts
  skillPath(id: string): string {
    assertId(id);
    return join(this.root, id, SKILL_FILE);
  }

  async hasSkill(id: string): Promise<boolean> {
    try {
      await stat(this.skillPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async readSkill(id: string): Promise<{ prose: string; skill: Skill; markdown: string }> {
    const markdown = await readFile(this.skillPath(id), 'utf8');
    return { ...parseSkill(markdown), markdown };
  }

  /** 与轨迹一样走写队列、临时文件与 0o600；散文原样、块按规范形式。 */
  async writeSkill(id: string, prose: string, skill: Skill): Promise<void> {
    return this.#serialize(async () => {
      const target = this.skillPath(id);
      await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
      await writeFile(`${target}.tmp`, serializeSkill(prose, skill), { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    });
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-library.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck 无错误（`RecordingSummary` 多了必填 `distilled`，`library.ts` 的 catch 分支已补）

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts.ts src/main/recording/library.ts tests/recording-library.test.ts
git commit -m "feat(recording): read and write skill.md next to the trajectory

A recording is distilled when skill.md exists; the summary then takes
its name, about and step counts from the skill, and a broken skill.md
is reported on the row without hiding the trajectory."
```

---

### Task 3: 提炼纯逻辑 `distill.ts`

**Files:**

- Create: `src/main/recording/distill.ts`
- Modify: `src/main/recording/index.ts`（加 `export * from './distill.js';`，按字母序放在 `format.js` 之前）
- Test: `tests/recording-distill.test.ts`

**Interfaces:**

- Consumes: `Skill` / `Step` / `Trajectory` / `isPlaceholder`（Task 1）、`normalizeName`（第一期 `resolve.ts`）、`sha256`（`../host/canonical.js`）
- Produces:
  - `buildDistillPrompt(name: string, trajectoryMarkdown: string): string`
  - `extractSkillMarkdown(text: string): string | undefined` —— 从回合文本里取出 skill 文档（从第一行 `# ` 标题到第一个 ```json pilion-skill 块的闭合栏）
  - `stepsHash(steps: ReadonlyArray<Step>): string`
  - `reconcile(skill: Skill, trajectory: Trajectory): ReconcileResult`，`type ReconcileResult = { ok: true } | { ok: false; step: number; reason: 'NO_EVIDENCE' | 'VALUE_CHANGED' | 'URL_UNKNOWN' }`
  - `unsupportedSteps(skill: Skill, trajectory: Trajectory): number[]` —— 非阻塞：所有没有依据的步骤序号（1 起）
  - `validateSkillEdit(existing: ReadonlyArray<Step>, submitted: ReadonlyArray<Step>): EditVerdict`，`type EditVerdict = { ok: true } | { ok: false; step: number; reason: 'NEW_ACTION' | 'TOO_MANY' }`

- [ ] **Step 1: 写下失败的测试**

创建 `tests/recording-distill.test.ts`：

````ts
import { describe, expect, it } from 'vitest';
import {
  buildDistillPrompt,
  extractSkillMarkdown,
  reconcile,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
  type Skill,
  type Step,
  type Trajectory,
} from '../src/main/recording/index';

const LOGIN = 'https://report.example.com/login';
const DASH = 'https://report.example.com/dashboard';
const email: Step = {
  kind: 'type',
  onUrl: LOGIN,
  target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
  text: 'me@x.com',
  replace: true,
};
const login: Step = {
  kind: 'click',
  onUrl: LOGIN,
  target: { role: 'button', name: '登录', tagName: 'button' },
};
const month: Step = {
  kind: 'select',
  onUrl: DASH,
  target: { role: 'combobox', name: '月份', tagName: 'select' },
  value: '2026-09',
};
const exportCsv: Step = {
  kind: 'click',
  onUrl: DASH,
  target: { role: 'button', name: '导出 CSV', tagName: 'button' },
};
const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    { kind: 'step', at: 't1', step: { kind: 'navigate', url: LOGIN } },
    { kind: 'page', at: 't2', url: LOGIN, title: '登录', text: '请输入邮箱' },
    { kind: 'step', at: 't3', step: email },
    { kind: 'step', at: 't4', step: { kind: 'human', onUrl: LOGIN, reason: '填写密码' } },
    { kind: 'step', at: 't5', step: login },
    { kind: 'page', at: 't6', url: DASH, title: '仪表盘', text: '本月数据' },
    { kind: 'step', at: 't7', step: month },
    { kind: 'step', at: 't8', step: exportCsv },
    { kind: 'step', at: 't9', step: { kind: 'note', onUrl: DASH, text: '上面那个按钮' } },
  ],
};
function skillWith(steps: Step[]): Skill {
  return {
    meta: {
      app: 'pilion',
      version: 1,
      kind: 'skill',
      name: '月度导出',
      about: '导出 CSV',
      recordedAt: '2026-09-20T14:03:11+08:00',
      distilledBy: 'claude-code',
      trajectory: 'trajectory.md',
    },
    steps,
  };
}

describe('reconcile', () => {
  it('从轨迹里挑选、合并、重排并插入 human/note 都通过', () => {
    const skill = skillWith([
      { kind: 'navigate', url: LOGIN },
      email,
      { kind: 'human', onUrl: LOGIN, reason: '填写密码' },
      login,
      { kind: 'note', text: '等表格出现' },
      exportCsv,
      month,
    ]);
    expect(reconcile(skill, trajectory)).toEqual({ ok: true });
  });

  it('凭空造的动作被拒：NO_EVIDENCE 指到那一步', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    expect(reconcile(skillWith([{ kind: 'navigate', url: LOGIN }, invented]), trajectory)).toEqual({
      ok: false,
      step: 2,
      reason: 'NO_EVIDENCE',
    });
  });

  it('一条轨迹步骤不能被复用成两步（消耗式匹配）', () => {
    expect(reconcile(skillWith([login, login]), trajectory)).toEqual({
      ok: false,
      step: 2,
      reason: 'NO_EVIDENCE',
    });
  });

  it('改写人输入过的值被拒：VALUE_CHANGED', () => {
    expect(reconcile(skillWith([{ ...email, text: 'boss@x.com' }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
    expect(reconcile(skillWith([{ ...month, value: '2026-10' }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
  });

  it('值换成占位符可以通过', () => {
    expect(reconcile(skillWith([{ ...email, text: '{{邮箱}}' }]), trajectory)).toEqual({
      ok: true,
    });
    expect(reconcile(skillWith([{ ...month, value: '{{月份}}' }]), trajectory)).toEqual({
      ok: true,
    });
  });

  it('navigate 的 URL 必须在轨迹里出现过：navigate 步或 page 条目都算', () => {
    expect(reconcile(skillWith([{ kind: 'navigate', url: DASH }]), trajectory)).toEqual({
      ok: true,
    });
    expect(
      reconcile(skillWith([{ kind: 'navigate', url: 'https://evil.example.com/' }]), trajectory),
    ).toEqual({ ok: false, step: 1, reason: 'URL_UNKNOWN' });
  });

  it('目标名只差空白与大小写时算同一目标', () => {
    const spaced: Step = { ...login, target: { ...login.target, name: ' 登录 ' } };
    expect(reconcile(skillWith([spaced]), trajectory)).toEqual({ ok: true });
  });

  it('同名不同角色不算同一目标', () => {
    const asLink: Step = { ...login, target: { ...login.target, role: 'link', tagName: 'a' } };
    expect(reconcile(skillWith([asLink]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'NO_EVIDENCE',
    });
  });
});

describe('unsupportedSteps', () => {
  it('非阻塞地列出所有没有依据的步骤序号', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    const skill = skillWith([
      login,
      invented,
      { kind: 'navigate', url: 'https://evil.example.com/' },
      exportCsv,
    ]);
    expect(unsupportedSteps(skill, trajectory)).toEqual([2, 3]);
  });
});

describe('validateSkillEdit', () => {
  const existing: Step[] = [{ kind: 'navigate', url: LOGIN }, email, login, month, exportCsv];

  it('删步、重排、改值、插入 human 都通过', () => {
    const submitted: Step[] = [
      { kind: 'navigate', url: LOGIN },
      { ...email, text: '{{邮箱}}' },
      { kind: 'human', onUrl: LOGIN, reason: '填写密码' },
      exportCsv,
      { ...month, value: '2026-10' },
    ];
    expect(validateSkillEdit(existing, submitted)).toEqual({ ok: true });
  });

  it('新增动作步骤被拒', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    expect(validateSkillEdit(existing, [...existing, invented])).toEqual({
      ok: false,
      step: 6,
      reason: 'NEW_ACTION',
    });
  });

  it('把一个动作步骤复制成两份被拒', () => {
    expect(validateSkillEdit(existing, [...existing, exportCsv])).toEqual({
      ok: false,
      step: 6,
      reason: 'TOO_MANY',
    });
  });

  it('新增 navigate 到别的 URL 被拒', () => {
    expect(
      validateSkillEdit(existing, [{ kind: 'navigate', url: 'https://evil.example.com/' }]),
    ).toEqual({ ok: false, step: 1, reason: 'NEW_ACTION' });
  });
});

describe('extractSkillMarkdown', () => {
  const doc = [
    '# 月度导出',
    '',
    '## 什么时候用',
    '',
    '月初。',
    '',
    '```json pilion-skill',
    '{"a":1}',
    '```',
  ].join('\n');

  it('去掉块前的闲聊和块后的尾巴，保留从标题到闭合栏', () => {
    expect(extractSkillMarkdown(`好的，这是提炼结果：\n\n${doc}\n\n还有什么需要吗？`)).toBe(doc);
  });

  it('没有块时返回 undefined', () => {
    expect(extractSkillMarkdown('# 月度导出\n\n没有块')).toBeUndefined();
  });

  it('有多个块时取第一个', () => {
    expect(extractSkillMarkdown(`${doc}\n\n\`\`\`json pilion-skill\n{"b":2}\n\`\`\``)).toBe(doc);
  });

  it('没有标题时从块开始', () => {
    expect(extractSkillMarkdown('前言\n```json pilion-skill\n{}\n```')).toBe(
      '```json pilion-skill\n{}\n```',
    );
  });
});

describe('buildDistillPrompt / stepsHash', () => {
  it('prompt 含轨迹原文与四条规则的关键词', () => {
    const prompt = buildDistillPrompt(
      '月度导出',
      '# 月度导出\n\n```json pilion-trajectory\n{}\n```',
    );
    expect(prompt).toContain('pilion-trajectory');
    expect(prompt).toContain('pilion-skill');
    expect(prompt).toContain('不得新增');
    expect(prompt).toContain('{{');
    expect(prompt).toContain('不要调用任何工具');
  });

  it('stepsHash 对内容敏感、对顺序敏感', () => {
    expect(stepsHash([login, month])).toBe(stepsHash([login, month]));
    expect(stepsHash([login, month])).not.toBe(stepsHash([month, login]));
    expect(stepsHash([login])).toMatch(/^[a-f0-9]{64}$/);
  });
});
````

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-distill.test.ts`
Expected: FAIL，找不到 `reconcile` 等导出

- [ ] **Step 3: 写 `src/main/recording/distill.ts`**

````ts
import { sha256 } from '../host/canonical.js';
import { normalizeName } from './resolve.js';
import { isPlaceholder, type Skill, type Step, type Trajectory } from './types.js';

const SKILL_FENCE = '```json pilion-skill';
type ActionStep = Extract<Step, { target: unknown }>;

export type ReconcileResult =
  | { ok: true }
  | { ok: false; step: number; reason: 'NO_EVIDENCE' | 'VALUE_CHANGED' | 'URL_UNKNOWN' };
export type EditVerdict =
  { ok: true } | { ok: false; step: number; reason: 'NEW_ACTION' | 'TOO_MANY' };

/** 固定说明 + 轨迹原文。规则写给任意 ACP Agent 看，所以每条都直白。 */
export function buildDistillPrompt(name: string, trajectoryMarkdown: string): string {
  return [
    `下面是我在浏览器里录制的一段操作轨迹「${name}」。请把它提炼成一份可复用的技能文档。`,
    '',
    '只输出一个 Markdown 文档，不要输出其它内容，也不要调用任何工具。文档结构：',
    `1. \`# ${name}\``,
    '2. `## 什么时候用`：一两句话，写清楚什么情况下该用这份技能',
    '3. `## 前置条件`：列表，例如需要已登录哪个站点、页面要处于什么状态',
    '4. `## 已知坑`：列表，轨迹里看得出的陷阱；没有就写「- 无」',
    '5. 一个 ```json pilion-skill 代码块，内容是 { "meta": { "about": "<一句话说明>" }, "steps": [ … ] }',
    '',
    '步骤规则：',
    '- 步骤只能从轨迹的 pilion-trajectory 代码块里挑选、合并、重排；不得新增任何动作，也不得改写目标',
    '- 不得改写人输入过的值；需要隐去的值（邮箱、姓名等）改成 {{说明}} 形式的占位符',
    '- 可以插入 { "kind": "human", "onUrl": "...", "reason": "..." } 说明哪一步要人来做，也可以插入 { "kind": "note", "text": "..." }',
    '- 删掉误点和无意义的步骤；散文里不要复述步骤',
    '',
    '轨迹原文：',
    '',
    trajectoryMarkdown,
  ].join('\n');
}

/** 从回合文本里取出文档：从第一行 `# ` 标题（没有就从块开始）到第一个技能块的闭合栏。 */
export function extractSkillMarkdown(text: string): string | undefined {
  const lines = text.split('\n');
  const open = lines.findIndex((line) => line.trim() === SKILL_FENCE);
  if (open < 0) return undefined;
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```');
  if (close < 0) return undefined;
  let start = open;
  for (let index = open - 1; index >= 0; index -= 1)
    if (/^# /.test(lines[index])) {
      start = index;
      break;
    }
  return lines.slice(start, close + 1).join('\n');
}

export function stepsHash(steps: ReadonlyArray<Step>): string {
  return sha256(JSON.stringify(steps));
}

function isAction(step: Step): step is ActionStep {
  return 'target' in step;
}

function targetKey(step: ActionStep): string {
  return `${step.kind}|${step.target.tagName}|${step.target.role}|${normalizeName(step.target.name)}`;
}

function sameValue(candidate: ActionStep, evidence: ActionStep): boolean {
  switch (candidate.kind) {
    case 'type':
      return (
        evidence.kind === 'type' &&
        (candidate.text === evidence.text || isPlaceholder(candidate.text))
      );
    case 'select':
      return (
        evidence.kind === 'select' &&
        (candidate.value === evidence.value || isPlaceholder(candidate.value))
      );
    case 'check':
      return evidence.kind === 'check' && candidate.checked === evidence.checked;
    case 'press':
      return (
        evidence.kind === 'press' &&
        candidate.key === evidence.key &&
        candidate.modifiers.join('+') === evidence.modifiers.join('+')
      );
    default:
      return true;
  }
}

/**
 * 四条对账：动作有依据（消耗式）、值未被改写、URL 未被编造、human/note 例外。
 * 意义在于提炼不能变成「Agent 写出一串你没做过的操作，然后请你批准」。
 */
function walk(
  skill: Skill,
  trajectory: Trajectory,
  onFailure: (failure: Extract<ReconcileResult, { ok: false }>) => boolean,
): void {
  const pool = trajectory.entries.flatMap((entry) =>
    entry.kind === 'step' && isAction(entry.step) ? [{ step: entry.step, used: false }] : [],
  );
  const urls = new Set(
    trajectory.entries.flatMap((entry) =>
      entry.kind === 'page' ? [entry.url] : entry.step.kind === 'navigate' ? [entry.step.url] : [],
    ),
  );
  skill.steps.forEach((step, index) => {
    const at = index + 1;
    if (step.kind === 'human' || step.kind === 'note') return;
    if (step.kind === 'navigate') {
      if (!urls.has(step.url) && !onFailure({ ok: false, step: at, reason: 'URL_UNKNOWN' })) return;
      return;
    }
    const key = targetKey(step);
    const evidence = pool.find((item) => !item.used && targetKey(item.step) === key);
    if (!evidence) {
      onFailure({ ok: false, step: at, reason: 'NO_EVIDENCE' });
      return;
    }
    evidence.used = true;
    if (!sameValue(step, evidence.step))
      onFailure({ ok: false, step: at, reason: 'VALUE_CHANGED' });
  });
}

export function reconcile(skill: Skill, trajectory: Trajectory): ReconcileResult {
  let failure: ReconcileResult = { ok: true };
  try {
    walk(skill, trajectory, (found) => {
      failure = found;
      throw failure;
    });
  } catch (thrown) {
    if (thrown !== failure) throw thrown;
  }
  return failure;
}

/** 非阻塞：给界面标「手工添加」用。 */
export function unsupportedSteps(skill: Skill, trajectory: Trajectory): number[] {
  const steps: number[] = [];
  walk(skill, trajectory, (found) => {
    steps.push(found.step);
    return true;
  });
  return steps;
}

/** 编辑只能删、排、改值、插 human：每个提交的动作步都要能在现有文件里找到同 kind + 同目标的一条，且不超额。 */
export function validateSkillEdit(
  existing: ReadonlyArray<Step>,
  submitted: ReadonlyArray<Step>,
): EditVerdict {
  const budget = new Map<string, number>();
  for (const step of existing) {
    const key =
      step.kind === 'navigate'
        ? `navigate|${step.url}`
        : isAction(step)
          ? targetKey(step)
          : undefined;
    if (key) budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  for (const [index, step] of submitted.entries()) {
    if (step.kind === 'human' || step.kind === 'note') continue;
    const key = step.kind === 'navigate' ? `navigate|${step.url}` : targetKey(step);
    const left = budget.get(key);
    if (left === undefined) return { ok: false, step: index + 1, reason: 'NEW_ACTION' };
    if (left === 0) return { ok: false, step: index + 1, reason: 'TOO_MANY' };
    budget.set(key, left - 1);
  }
  return { ok: true };
}
````

`walk` 的 `onFailure` 返回值只在 `navigate` 分支用来决定是否继续；阻塞模式通过抛出终止，非阻塞模式收集后继续。

- [ ] **Step 4: `src/main/recording/index.ts` 加 `export * from './distill.js';`**（字母序：`distill`、`format`、`library`、`player`、`recorder`、`recorder-script`、`resolve`、`types`）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-distill.test.ts && pnpm typecheck && pnpm lint && pnpm format`
Expected: PASS；无错误。若 `extractSkillMarkdown` 的「有多个块时取第一个」失败，确认 `close` 用的是第一个 `open` 之后的第一个闭合栏

- [ ] **Step 6: Commit**

```bash
git add src/main/recording/distill.ts src/main/recording/index.ts tests/recording-distill.test.ts
git commit -m "feat(recording): distillation prompt, reconciliation and edit validation

Four checks keep a distilled skill honest: every action must consume a
matching trajectory step, values must be unchanged or a placeholder,
navigation targets must have been visited, only human and note steps
are free. The same walk lists unsupported steps for the editor, and
validateSkillEdit refuses any action the file does not already hold."
```

---

### Task 4: 播放器把占位符步骤交给人

**Files:**

- Modify: `src/main/recording/player.ts`
- Test: `tests/recording-player.test.ts`（追加）

**Interfaces:**

- Consumes: `isPlaceholder`（Task 1）
- Produces: `playSteps` 遇到 `type.text` / `select.value` 为占位符的步骤时返回 `{ ok: false, reason: 'HUMAN', at, step, humanReason: '填写 "<目标名>"：<占位符内容>', url, title }`

- [ ] **Step 1: 写下失败的测试**

在 `tests/recording-player.test.ts` 的 `describe('playSteps', …)` 末尾加：

```ts
it('占位符步骤视为需要人：不执行，返回 HUMAN 并说明填什么', async () => {
  const browser = fakeBrowser();
  const withPlaceholder: Step[] = [
    steps[0],
    { ...(steps[1] as Extract<Step, { kind: 'type' }>), text: '{{公司邮箱}}' },
    steps[3],
  ];
  const outcome = await playSteps(withPlaceholder, { execute: browser.execute, ...fast });
  expect(outcome).toEqual({
    ok: false,
    reason: 'HUMAN',
    at: 2,
    step: '输入 "邮箱" = "{{公司邮箱}}"',
    humanReason: '填写 "邮箱"：公司邮箱',
    url: LOGIN,
    title: '登录',
  });
  expect(browser.calls.some((call) => call.name === 'browser.type')).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/recording-player.test.ts`
Expected: 新用例 FAIL（返回的是执行了 `browser.type` 的成功结果）

- [ ] **Step 3: 实现**

`src/main/recording/player.ts` 的 import 改为 `import { isPlaceholder, type Step } from './types.js';`。在 `playSteps` 循环里 `if (step.kind === 'human') { … }` 分支之后、`if (step.kind === 'navigate')` 之前加：

```ts
const placeholder =
  step.kind === 'type' && isPlaceholder(step.text)
    ? step.text
    : step.kind === 'select' && isPlaceholder(step.value)
      ? step.value
      : undefined;
if (placeholder && (step.kind === 'type' || step.kind === 'select')) {
  // 占位符不展开：这一步是人的，和 human 步骤一样交出去。
  const current = await safeSnapshot();
  return {
    ok: false,
    reason: 'HUMAN',
    at: index,
    step: describeStep(step),
    humanReason: `填写 "${step.target.name}"：${placeholder.slice(2, -2).trim()}`,
    url: current.url,
    title: current.title,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/recording-player.test.ts && pnpm typecheck && pnpm lint && pnpm format`
Expected: PASS（13/13）；无错误

- [ ] **Step 5: Commit**

```bash
git add src/main/recording/player.ts tests/recording-player.test.ts
git commit -m "feat(recording): a placeholder value hands the step to the person

{{…}} is never expanded; the player stops there exactly as it does on
a human step and says which field to fill."
```

---

### Task 5: MCP 契约与空白页允许列表

**Files:**

- Modify: `src/shared/contracts.ts`（`ToolNameSchema`、`SkillsPlayArgsSchema`、`ToolRequestSchema` 的参数校验）
- Modify: `src/main/agents/browser-mcp-server.ts`
- Modify: `src/main/host/canonical.ts`（`isBlankPageOperation` 允许列表）
- Test: `tests/contracts.test.ts`（追加）、`tests/host-core.test.ts`（追加）、`tests/browser-mcp-server.test.ts`（新建）

**Interfaces:**

- Produces:
  - `ToolNameSchema` 含 `'browser.skills.list'`、`'browser.skills.play'`
  - `SkillsPlayArgsSchema = z.object({ skillId: z.string().min(1).max(60), fromStep: z.number().int().min(1).max(500).optional() }).strict()`，且 `ToolRequestSchema` 对 `browser.skills.play` 用它校验 `args`
  - MCP 工具名 `browser_skills_list`、`browser_skills_play`
  - `isBlankPageOperation('about:blank', 'browser.skills.play') === true`（技能通常第一步就是导航，空白标签也能起播）

- [ ] **Step 1: 写下失败的测试**

`tests/contracts.test.ts` 的 `describe('browser tool surface', …)` 里加：

```ts
it('exposes the two skill tools and validates play arguments', () => {
  expect(ToolNameSchema.safeParse('browser.skills.list').success).toBe(true);
  expect(ToolNameSchema.safeParse('browser.skills.play').success).toBe(true);
  expect(
    ToolRequestSchema.safeParse({
      requestId: 'r1',
      name: 'browser.skills.play',
      args: { skillId: 'monthly-export', fromStep: 3 },
    }).success,
  ).toBe(true);
  expect(
    ToolRequestSchema.safeParse({
      requestId: 'r1',
      name: 'browser.skills.play',
      args: { skillId: 'monthly-export', fromStep: 0 },
    }).success,
  ).toBe(false);
  expect(
    ToolRequestSchema.safeParse({
      requestId: 'r1',
      name: 'browser.skills.play',
      args: { skillId: '../x' },
    }).success,
  ).toBe(true); // id 形状由技能库 assertId 把关，这里只限长度
});
```

（若文件尚未 import `ToolRequestSchema`，在现有 `import { ToolNameSchema } from '../src/shared/contracts';` 里加上。）

`tests/host-core.test.ts` 里紧邻现有 `isBlankPageOperation` / blank-page 用例加：

```ts
it('lets a skill be listed or played from a blank tab', () => {
  expect(isBlankPageOperation('about:blank', 'browser.skills.list')).toBe(true);
  expect(isBlankPageOperation('about:blank', 'browser.skills.play')).toBe(true);
  expect(isBlankPageOperation('https://example.com', 'browser.skills.play')).toBe(false);
});
```

（确认该文件 import 了 `isBlankPageOperation`；没有就从 `'../src/main/host/index'` 加。）

创建 `tests/browser-mcp-server.test.ts`：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpServer } from '../src/main/agents/browser-mcp-server';

async function connected() {
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }));
  const server = createBrowserMcpServer(execute as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, execute };
}

describe('browser MCP server skill tools', () => {
  it('lists both skill tools with instructions the Agent can follow', async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools;
    const list = tools.find((tool) => tool.name === 'browser_skills_list');
    const play = tools.find((tool) => tool.name === 'browser_skills_play');
    expect(list?.description).toMatch(/Prefer a matching skill/);
    expect(play?.description).toMatch(/fromStep = failedAt \+ 1/);
    expect(play?.description).toMatch(/HUMAN/);
  });

  it('routes browser_skills_list to the executor with no arguments', async () => {
    const { client, execute } = await connected();
    await client.callTool({ name: 'browser_skills_list', arguments: {} });
    expect(execute).toHaveBeenCalledWith('browser.skills.list', {});
  });

  it('rejects a play call with fromStep 0 before it reaches the executor', async () => {
    const { client, execute } = await connected();
    const result = await client.callTool({
      name: 'browser_skills_play',
      arguments: { skillId: 'monthly-export', fromStep: 0 },
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalledWith('browser.skills.play', expect.anything());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/contracts.test.ts tests/host-core.test.ts tests/browser-mcp-server.test.ts`
Expected: 三个文件各有新用例 FAIL

- [ ] **Step 3: `src/shared/contracts.ts`**

`ToolNameSchema` 的数组末尾（`'browser.request_human'` 之后）加：

```ts
  'browser.skills.list',
  'browser.skills.play',
```

在 `PressArgsSchema` 定义之后加：

```ts
export const SkillsPlayArgsSchema = z
  .object({
    skillId: z.string().min(1).max(60),
    fromStep: z.number().int().min(1).max(500).optional(),
  })
  .strict();
```

`NewEffectArgsSchemas` 改名不动，只加一项：

```ts
const NewEffectArgsSchemas = {
  'browser.select': SelectArgsSchema,
  'browser.check': CheckArgsSchema,
  'browser.press': PressArgsSchema,
  'browser.skills.play': SkillsPlayArgsSchema,
} as const;
```

- [ ] **Step 4: `src/main/agents/browser-mcp-server.ts`**

import 里加 `SkillsPlayArgsSchema`（不用；工具参数用 raw shape）。在 `register('browser.press', …)` 之后、`return server;` 之前加：

```ts
register(
  'browser.skills.list',
  'List the skills the person recorded and kept in this workspace. Prefer a matching skill over exploring by hand; each entry says when to use it. Returns [{ id, name, about, steps, needsHuman, recordedAt }].',
  {},
);
register(
  'browser.skills.play',
  'Replay a kept skill on the current tab. Returns { ok: true, steps, finalUrl } when every step ran. On { ok: false } read failedAt, step, url and remaining: fix only that step with browser_observe and the effect tools, then call this again with fromStep = failedAt + 1. On reason "HUMAN" the browser was handed to the person: end your turn, and when they resume you continue with fromStep. The first replay of a skill in a task asks the person once.',
  {
    skillId: z.string().min(1).max(60),
    fromStep: z.number().int().min(1).max(500).optional(),
  },
);
```

- [ ] **Step 5: `src/main/host/canonical.ts`**

`isBlankPageOperation` 的数组里加 `'browser.skills.list'`、`'browser.skills.play'`（放在 `'browser.observe'` 之后）。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run tests/contracts.test.ts tests/host-core.test.ts tests/browser-mcp-server.test.ts && pnpm typecheck && pnpm lint && pnpm format`
Expected: PASS；无错误。若 `InMemoryTransport` 的 import 路径报错，改为 `'@modelcontextprotocol/sdk/inMemory.js'` 的实际导出路径（`ls node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js` 存在）

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts.ts src/main/agents/browser-mcp-server.ts src/main/host/canonical.ts tests/contracts.test.ts tests/host-core.test.ts tests/browser-mcp-server.test.ts
git commit -m "feat(mcp): browser_skills_list and browser_skills_play

The descriptions are the only channel that steers an arbitrary ACP
Agent, so they say when to prefer a skill, how to resume after a
hand-back and that the first replay asks the person once. Both tools
are allowed from a blank tab because a skill usually starts by
navigating."
```

---

### Task 6: 提炼编排（主进程、契约、preload）

**Files:**

- Modify: `src/shared/contracts.ts`（`DistillationState`、`SkillDetail` 扩展、IPC）
- Modify: `src/preload/index.ts`、`src/preload/entry.cts`
- Modify: `src/main/main.ts`

**Interfaces:**

- Consumes: `buildDistillPrompt` / `extractSkillMarkdown` / `reconcile` / `unsupportedSteps`（Task 3）、`parseSkill`（Task 1）、`library.hasSkill/readSkill/writeSkill`（Task 2）
- Produces:
  - `AppState.distillation?: DistillationState`，`DistillationState = { id; name; status: 'running' | 'proposed' | 'rejected'; conversationId; markdown?: string; steps?: SkillStepView[]; reason?: string }`
  - `SkillStepView = { index; kind; text; unsupported?; ambiguous?; manual?: boolean; raw: Record<string, unknown> }`；`SkillDetail` 增加 `distilled: boolean`、`about?: string`、`prose?: string`、`skillMarkdown?: string`，其 `steps` 变为 `SkillStepView[]`（已提炼时来自技能，否则来自轨迹）
  - IPC：`skillsDistill: 'skills:distill'`、`skillsKeep: 'skills:keep'`、`skillsDiscard: 'skills:discard'`；preload `skills.distill(id)`、`skills.keep()`、`skills.discard()`
  - main.ts：`startDistillation(id)`、`keepDistilled()`、`discardDistilled()`、模块变量 `distilling` / `pendingSkill` / `distillationRejected`；`executeTool` 在提炼期间拒绝 Agent 工具

- [ ] **Step 1: `src/shared/contracts.ts`**

`SkillDetail` 改为：

```ts
export interface SkillStepView {
  index: number;
  kind: string;
  text: string;
  unsupported?: string;
  ambiguous?: boolean;
  /** 没有轨迹依据的步骤（人直接改文件加的）。 */
  manual?: boolean;
  /** 原始步骤对象，编辑时原样交回主进程校验。 */
  raw: Record<string, unknown>;
}
export interface SkillDetail {
  id: string;
  name: string;
  recordedAt: string;
  /** 轨迹 md 原文。 */
  markdown: string;
  distilled: boolean;
  about?: string;
  /** 已提炼时：块上方散文与 skill.md 原文。 */
  prose?: string;
  skillMarkdown?: string;
  steps: SkillStepView[];
}
export interface DistillationState {
  id: string;
  name: string;
  status: 'running' | 'proposed' | 'rejected';
  conversationId: string;
  markdown?: string;
  steps?: SkillStepView[];
  reason?: string;
}
```

`AppState` 里 `replay?: ReplayState;` 之后加 `distillation?: DistillationState;`。`IPC` 里 `skillsStop` 之后加：

```ts
  skillsDistill: 'skills:distill',
  skillsKeep: 'skills:keep',
  skillsDiscard: 'skills:discard',
```

- [ ] **Step 2: 两个 preload**

`src/preload/index.ts` 的 `skills: Object.freeze({ … })` 里加：

```ts
    distill: (id: string) => ipcRenderer.invoke(IPC.skillsDistill, { id }),
    keep: () => ipcRenderer.invoke(IPC.skillsKeep),
    discard: () => ipcRenderer.invoke(IPC.skillsDiscard),
```

`src/preload/entry.cts` 同样加三行（它的 IPC 表是手抄的，`grep -n "skills:stop" src/preload/entry.cts` 找到位置，照 `stop` 的写法加 `distill` / `keep` / `discard`，channel 字符串与 contracts 一致）。

- [ ] **Step 3: `src/main/main.ts` 状态与快照**

import：从 `./recording/index.js` 加 `buildDistillPrompt, extractSkillMarkdown, parseSkill, reconcile, unsupportedSteps, type Skill`；从 `../shared/contracts.js` 加 `type DistillationState, type SkillStepView`；从 `./agents/index.js`（或现有 `runPrompt` 的 import 处）确认 `runPrompt` 已导入。

在 `let replayStarting = false;` 之后加：

```ts
/** 提炼那一轮：Agent 只准输出文档。 */
let distilling: { id: string; name: string; conversationId: string } | undefined;
let pendingSkill:
  | {
      id: string;
      name: string;
      conversationId: string;
      prose: string;
      skill: Skill;
      markdown: string;
    }
  | undefined;
let distillationRejected:
  { id: string; name: string; conversationId: string; reason: string } | undefined;
```

`state()` 里 `replay: replay?.state,` 之后加：

```ts
  distillation: distilling
    ? { ...distilling, status: 'running' }
    : pendingSkill
      ? {
          id: pendingSkill.id,
          name: pendingSkill.name,
          conversationId: pendingSkill.conversationId,
          status: 'proposed',
          markdown: pendingSkill.markdown,
          steps: skillStepViews(pendingSkill.skill.steps, pendingSkillManual),
        }
      : distillationRejected
        ? { ...distillationRejected, status: 'rejected' }
        : undefined,
```

其中 `pendingSkillManual` 是提案对账时算出的 `manual` 序号集合（`let pendingSkillManual: number[] = [];`，与 `pendingSkill` 一起赋值/清空）。

`skillDetail(id)` 改为（保留原有轨迹渲染，已提炼时步骤取自技能）：

```ts
function skillStepViews(
  steps: ReadonlyArray<Step>,
  manual: ReadonlyArray<number> = [],
): SkillStepView[] {
  return steps.map((step, index) => ({
    index: index + 1,
    kind: step.kind,
    text: describeStep(step),
    ...(manual.includes(index + 1) ? { manual: true } : {}),
    raw: step as unknown as Record<string, unknown>,
  }));
}

async function skillDetail(id: string): Promise<SkillDetail> {
  const { trajectory, markdown } = await library.read(id);
  if (await library.hasSkill(id)) {
    const { prose, skill, markdown: skillMarkdown } = await library.readSkill(id);
    return {
      id,
      name: skill.meta.name,
      recordedAt: skill.meta.recordedAt,
      markdown,
      distilled: true,
      about: skill.meta.about,
      prose,
      skillMarkdown,
      steps: skillStepViews(skill.steps, unsupportedSteps(skill, trajectory)),
    };
  }
  let index = 0;
  return {
    id,
    name: trajectory.meta.name,
    recordedAt: trajectory.meta.recordedAt,
    markdown,
    distilled: false,
    steps: trajectory.entries.flatMap((entry) =>
      entry.kind === 'step'
        ? [
            {
              index: (index += 1),
              kind: entry.step.kind,
              text: describeStep(entry.step),
              ...(entry.unsupported ? { unsupported: entry.unsupported } : {}),
              ...(entry.ambiguous ? { ambiguous: true } : {}),
              raw: entry.step as unknown as Record<string, unknown>,
            },
          ]
        : [],
    ),
  };
}
```

- [ ] **Step 4: 提炼编排函数**

在 `stopReplay` 之后加：

````ts
/** 提炼：一个专属对话里跑一次普通 prompt，主进程取块、校验、对账；人按保留才落盘。 */
async function startDistillation(id: string): Promise<void> {
  const current = connection;
  if (!current || current.transport.state !== 'ready') throw new Error('请先连接 Agent');
  if (promptActive || connectionBusy || taskRunning()) throw new Error('请等待当前任务结束');
  if (recording) throw new Error('正在录制，无法提炼');
  if (replayRunning()) throw new Error('正在回放技能，无法提炼');
  if (distilling) throw new Error('已有提炼在进行');
  const { trajectory, markdown } = await library.read(id);
  const name = trajectory.meta.name;
  // 重炼时留在同一个提炼对话里；否则和「新对话」一样新建并重连出干净的 session。
  const reuse =
    workspace.current?.title === `提炼：${name}` &&
    workspace.current.agentId === current.config.id &&
    !workspace.current.task;
  if (!reuse) {
    connectionBusy = true;
    try {
      workspace.create(randomUUID(), current.config.id);
      workspace.current!.title = `提炼：${name}`;
      await connectAgent(current.config.id);
    } finally {
      connectionBusy = false;
    }
  }
  const live = requireAttachment();
  const conversation = workspace.current!;
  pendingSkill = undefined;
  pendingSkillManual = [];
  distillationRejected = undefined;
  distilling = { id, name, conversationId: conversation.id };
  promptActive = true;
  promptCancelled = false;
  activeResponseId = undefined;
  taskId = randomUUID();
  lastError = undefined;
  workspace.append({
    id: randomUUID(),
    role: 'user',
    text: `提炼「${name}」`,
    time: new Date().toISOString(),
    status: 'completed',
  });
  agentStatus = 'running';
  emit();
  const start = conversation.messages.length;
  try {
    await runPrompt(buildDistillPrompt(name, markdown), {
      prompt: (prompt) => live.transport.prompt(prompt),
      messages: () => conversation.messages,
      cancelled: () => promptCancelled || connection !== live,
      onResult: (result) => log(`提炼回合结束：${result.stopReason}`),
      diagnostics: () => ({ agent: live.transport.capabilities.agentInfo }),
    });
    const reply = conversation.messages
      .slice(start)
      .filter((message) => message.role === 'assistant')
      .map((message) => message.text)
      .join('');
    acceptDistillation(id, name, conversation.id, reply, trajectory, live.config.id);
  } catch (error) {
    distillationRejected = {
      id,
      name,
      conversationId: conversation.id,
      reason: promptCancelled ? '已取消' : readable(error),
    };
  } finally {
    distilling = undefined;
    promptActive = false;
    for (const message of conversation.messages)
      if (message.status === 'running') message.status = 'completed';
    if (connection === live) agentStatus = 'ready';
    emit();
  }
}

function acceptDistillation(
  id: string,
  name: string,
  conversationId: string,
  reply: string,
  trajectory: Trajectory,
  distilledBy: string,
): void {
  const reject = (reason: string) => {
    distillationRejected = { id, name, conversationId, reason };
  };
  const extracted = extractSkillMarkdown(reply);
  if (!extracted) return reject('回复里没有 ```json pilion-skill 代码块');
  let parsed: ReturnType<typeof parseSkill>;
  try {
    parsed = parseSkill(extracted);
  } catch (error) {
    return reject(readable(error));
  }
  // 元信息以 Pilion 为准：Agent 只提供 about、步骤与散文。
  const skill: Skill = {
    ...parsed.skill,
    meta: {
      ...parsed.skill.meta,
      name,
      recordedAt: trajectory.meta.recordedAt,
      distilledBy,
      trajectory: 'trajectory.md',
    },
  };
  const verdict = reconcile(skill, trajectory);
  if (!verdict.ok)
    return reject(
      `第 ${verdict.step} 步在轨迹里找不到依据（${
        verdict.reason === 'VALUE_CHANGED'
          ? '改写了输入值'
          : verdict.reason === 'URL_UNKNOWN'
            ? '轨迹里没去过这个地址'
            : '没有对应的动作'
      }）`,
    );
  pendingSkill = { id, name, conversationId, prose: parsed.prose, skill, markdown: extracted };
  pendingSkillManual = [];
  log(`提炼完成，等待保留：${name}`);
}

async function keepDistilled(): Promise<void> {
  const proposal = pendingSkill;
  if (!proposal) throw new Error('没有待保留的提炼结果');
  await library.writeSkill(proposal.id, proposal.prose, proposal.skill);
  pendingSkill = undefined;
  pendingSkillManual = [];
  store.recordEvent('skill', proposal.id, 'skill.kept', {
    distilledBy: proposal.skill.meta.distilledBy,
  });
  log(`技能已保留：${proposal.name}`);
  await refreshSkills();
}

function discardDistilled(): void {
  pendingSkill = undefined;
  pendingSkillManual = [];
  distillationRejected = undefined;
  emit();
}
````

`acceptDistillation` 里 `parsed.skill.meta` 由 Agent 提供 `about`，`kind`/`app`/`version` 由 schema 强制；若 Agent 漏了 `meta` 里的 `name`/`recordedAt`/`distilledBy`/`trajectory`，`parseSkill` 会先拒绝 —— 为了让 Agent 只需给 `about`，在 `parseSkill` 之前把缺失字段补上：

```ts
const withMeta = extracted.replace(
  /"meta"\s*:\s*\{/,
  () =>
    `"meta": { "app": "pilion", "version": 1, "kind": "skill", "name": ${JSON.stringify(name)}, "recordedAt": ${JSON.stringify(trajectory.meta.recordedAt)}, "distilledBy": ${JSON.stringify(distilledBy)}, "trajectory": "trajectory.md", `,
);
```

放在 `parseSkill(extracted)` 之前并改为 `parseSkill(withMeta)`；后面覆盖 `meta` 的那段仍保留（Agent 给了也以 Pilion 为准）。若 Agent 给的 `meta` 里已有同名键，JSON 里后出现的键覆盖先出现的，正好以 Agent 的 `about` 为准、其余以 Pilion 为准；`pendingSkill.markdown` 存 `withMeta` 之后重新 `serializeSkill(parsed.prose, skill)` 的结果，而不是原始 `extracted`。

- [ ] **Step 5: 互斥与 IPC**

`executeTool` 里录制守卫之后加：

```ts
if (!actor && distilling) throw new Error('提炼期间不提供浏览器工具，请只输出文档');
```

`startRecording()` 与 `startReplay()` 的守卫里各加 `if (distilling) throw new Error('正在提炼，请稍后');`（`promptActive` 已经挡住 `executeAgentTask`）。

`shutdown()` 里 `stopReplay();` 之后加 `discardDistilled();`。

IPC（放在 `handle(IPC.skillsStop, …)` 之后）：

```ts
handle(IPC.skillsDistill, IdInputSchema, (value) => startDistillation(value.id));
handle(IPC.skillsKeep, undefined, () => keepDistilled());
handle(IPC.skillsDiscard, undefined, () => discardDistilled());
```

`skillsRemove` 的 handler 里加：`if (pendingSkill?.id === value.id || distilling?.id === value.id) throw new Error('正在提炼，无法删除');`。

- [ ] **Step 6: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm format && pnpm test`
Expected: 全绿（单测不覆盖 main.ts；E2E 在 Task 10）。`runPrompt` 抛 `AgentEmptyResponseError` 时 `readable(error)` 给出中文说明，进入 `rejected`

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts.ts src/preload/index.ts src/preload/entry.cts src/main/main.ts
git commit -m "feat(recording): distil a trajectory into a skill in a dedicated conversation

One ordinary ACP prompt in a fresh conversation, no browser tools for
that turn; the main process extracts the skill block, pins the meta,
reconciles every step against the trajectory and holds the proposal in
memory until the person keeps it."
```

---

### Task 7: Agent 回放：`browser.skills.list` / `browser.skills.play`

**Files:**

- Modify: `src/shared/contracts.ts`（`AgentReplayState`、`ConversationTask.replayCursor`）
- Modify: `src/main/main.ts`

**Interfaces:**

- Consumes: `library.list/readSkill`（Task 2）、`stepsHash`（Task 3）、`playSteps`（第一期 + Task 4）、`SkillsPlayArgsSchema`（Task 5）
- Produces:
  - `Actor.replayApproval?: string`
  - `AppState.agentReplay?: { name: string; step: number; total: number }`
  - `ConversationTaskSchema.replayCursor?: { skillId; name; nextStep }`
  - `runTool` 走主路径处理两个工具：`list` 为 pure-observe，`play` 首次 `require_approval`（`full` 也问）、之后 allow；`performTool` 的两个 case

- [ ] **Step 1: `src/shared/contracts.ts`**

`ConversationTaskSchema` 里 `handover` 之后加：

```ts
  /** Where an Agent-driven replay handed the browser back, so resume can say which step to continue from. */
  replayCursor: z
    .object({
      skillId: z.string().min(1).max(60),
      name: z.string().max(120),
      nextStep: z.number().int().min(1).max(500),
    })
    .strict()
    .optional(),
```

`ReplayState` 之后加：

```ts
export interface AgentReplayState {
  name: string;
  step: number;
  total: number;
}
```

`AppState` 里 `distillation?` 之后加 `agentReplay?: AgentReplayState;`。

- [ ] **Step 2: `src/main/main.ts` 类型与状态**

`type Actor` 加一个可选字段：

```ts
  /** Agent 回放技能时每一步携带的那次审批；有它就不再逐步问人，只做目标重校验。 */
  replayApproval?: string;
```

`let distillationRejected …` 之后加：

```ts
/** Agent 通过 MCP 回放技能时的进度与取消句柄；人的回放用 replay，两者互斥。 */
let agentReplay: { name: string; step: number; total: number; abort: AbortController } | undefined;
/** 任务 id → 已审批的技能步骤哈希；技能一改哈希就变，重新问。 */
const approvedSkills = new Map<string, Set<string>>();
/** runTool 到 performTool 之间传递已加载的技能。 */
const pendingSkillPlays = new Map<
  string,
  { skill: Skill; fromStep: number; approvalId?: string; actor: Actor }
>();
```

`state()` 里 `distillation:` 之后加 `agentReplay: agentReplay ? { name: agentReplay.name, step: agentReplay.step, total: agentReplay.total } : undefined,`。

`startRecording()` 与 `startReplay()` 的守卫各加 `if (agentReplay) throw new Error('Agent 正在回放技能');`。

- [ ] **Step 3: `runTool` 的裁决**

在 `runTool` 里 `const tabId = targetTab(request);` 之前加：

```ts
const skillPlay =
  request.name === 'browser.skills.play' ? await loadSkillForPlay(request, actor) : undefined;
```

并在函数外定义：

```ts
async function loadSkillForPlay(
  request: ToolRequest,
  actor: Actor,
): Promise<{ skill: Skill; fromStep: number; hash: string; approved: boolean }> {
  if (actor.principal === USER_PRINCIPAL) throw new Error('人工回放请使用技能库的播放');
  if (agentReplay) throw new Error('已有技能在回放');
  const args = SkillsPlayArgsSchema.parse(request.args);
  if (!(await library.hasSkill(args.skillId)))
    throw new Error('该技能未提炼，Agent 只能回放已提炼的技能');
  const { skill } = await library.readSkill(args.skillId);
  const fromStep = args.fromStep ?? 1;
  if (fromStep > skill.steps.length) throw new Error('起始步骤超出范围');
  const hash = stepsHash(skill.steps);
  const taskKey = workspace.current?.task?.id ?? 'no-task';
  return { skill, fromStep, hash, approved: approvedSkills.get(taskKey)?.has(hash) ?? false };
}
```

`verdict` 的计算改为：

```ts
  const verdict: PolicyVerdict = skillPlay
    ? skillPlay.approved
      ? {
          verdict: 'allow',
          policySetVersion: POLICY_VERSION,
          reasonCodes: ['PAGE_STATE_CHANGE'],
          obligations: [],
        }
      : {
          // 一份技能是一捆预授权副作用：full 模式也问，同任务内同哈希只问一次。
          verdict: 'require_approval',
          policySetVersion: POLICY_VERSION,
          reasonCodes: ['PAGE_STATE_CHANGE'],
          obligations: [{ type: 'trusted_approval', parameters: {} }],
        }
    : // 人工回放是人自己按的播放，不再问人；Agent 回放技能的每一步已由那次审批覆盖。
      workspace.data.permissionMode === 'full' ||
        actor.principal === USER_PRINCIPAL ||
        actor.replayApproval
      ? { …原有 allow 分支不变… }
      : evaluatePolicy({ …原有不变… });
```

`trustedCommandArguments` 里加（在 `if (element)` 之前）：

```ts
if (request.name === 'browser.skills.play')
  base.skill = {
    skillId: requireString(request.args.skillId, 'skillId'),
    fromStep: typeof request.args.fromStep === 'number' ? request.args.fromStep : 1,
  };
```

`runTool` 里 `canonicalizeCommand({ … arguments: … })` 之后、`createIntent` 之前，把技能哈希并进参数（canonical 只认可序列化值）：

```ts
if (skillPlay) command.arguments = { ...command.arguments, stepsHash: skillPlay.hash };
```

（`canonicalizeCommand` 返回的是规范化后的对象；此处在它之后追加字段再计算 `commandHash` / `digest`，两者都用 `command`，保持一致。）

审批 summary：`summary: skillPlay ? skillApprovalSummary(skillPlay.skill) : trustedApprovalSummary(command, trustedElement, effect)`，其中：

```ts
function skillApprovalSummary(skill: Skill): string {
  return [
    `回放技能「${skill.meta.name}」`,
    skill.meta.about,
    '',
    ...skill.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`),
  ].join('\n');
}
```

审批通过后（`approvalDigest` 拿到之后）、`return executePreparedAction(...)` 之前加：

```ts
if (skillPlay) {
  if (approvalId) {
    const taskKey = workspace.current?.task?.id ?? 'no-task';
    const set = approvedSkills.get(taskKey) ?? new Set<string>();
    set.add(skillPlay.hash);
    approvedSkills.set(taskKey, set);
  }
  pendingSkillPlays.set(request.requestId, {
    skill: skillPlay.skill,
    fromStep: skillPlay.fromStep,
    approvalId,
    actor,
  });
}
```

- [ ] **Step 4: `performTool` 的两个 case**

在 `performTool` 的 `switch` 里、`case 'browser.observe':` 之前加：

```ts
    case 'browser.skills.list':
      return (await library.list())
        .filter((row) => row.distilled && !row.error)
        .map(({ id, name, about, steps, needsHuman, recordedAt }) => ({
          id,
          name,
          about: about ?? '',
          steps,
          needsHuman,
          recordedAt,
        }));
    case 'browser.skills.play': {
      const play = pendingSkillPlays.get(request.requestId);
      pendingSkillPlays.delete(request.requestId);
      if (!play) throw new Error('技能回放没有经过裁决');
      return playSkillForAgent(request.args.skillId as string, play, play.actor);
    }
```

（`performTool(request, principal, boundTabId)` 的签名不变：执行者身份随 `pendingSkillPlays` 一起从 `runTool` 传过来。）

在 `stopReplay` 之后加：

```ts
/** Agent 的回放：每一步仍是它自己的 ToolRequest，记在它的 attachment 下；卡住就交还给人。 */
async function playSkillForAgent(
  skillId: string,
  play: { skill: Skill; fromStep: number; approvalId?: string },
  actor: Actor,
): Promise<unknown> {
  const abort = new AbortController();
  agentReplay = {
    name: play.skill.meta.name,
    step: play.fromStep,
    total: play.skill.steps.length,
    abort,
  };
  store.recordEvent('replay', skillId, 'replay.started', {
    fromStep: play.fromStep,
    attachmentId: actor.attachmentId,
    approvalId: play.approvalId,
    by: 'agent',
  });
  emit();
  try {
    const outcome = await playSteps(play.skill.steps, {
      fromStep: play.fromStep,
      signal: abort.signal,
      probe: async () => {
        const tabId = requireActiveTab();
        if (!browser.registry.has(tabId)) throw new Error('没有活动标签页');
        return browser.registry.get(tabId).page.snapshot();
      },
      execute: async (name, args) => {
        const requestId = randomUUID();
        store.recordEvent('replay', skillId, 'replay.step', {
          step: agentReplay?.step,
          requestId,
          approvalId: play.approvalId,
        });
        return executeTool(ToolRequestSchema.parse({ requestId, name, args, timeoutMs: 15_000 }), {
          ...actor,
          replayApproval: play.approvalId ?? 'approved-earlier',
        });
      },
      onProgress: (step) => {
        if (agentReplay) agentReplay.step = step;
        emit();
      },
    });
    store.recordEvent(
      'replay',
      skillId,
      `replay.${outcome.ok ? 'done' : outcome.reason === 'HUMAN' ? 'paused' : 'failed'}`,
      {
        by: 'agent',
        reason: outcome.ok ? undefined : outcome.reason,
      },
    );
    if (!outcome.ok && outcome.reason === 'HUMAN') {
      const task = workspace.current?.task;
      if (task)
        task.replayCursor = { skillId, name: play.skill.meta.name, nextStep: outcome.at + 1 };
      pauseForHuman(outcome.humanReason);
      return {
        ...outcome,
        message: '浏览器已交回用户，请结束本回合；用户继续后从 fromStep 续播。',
      };
    }
    return outcome;
  } finally {
    agentReplay = undefined;
    emit();
  }
}
```

- [ ] **Step 5: 取消与交接**

`interruptAgent(mode)` 里 `promptCancelled = true;` 之后加 `agentReplay?.abort.abort();`。

`executeAgentTask` 里构造 `handoverNote` 的地方改为：

```ts
const cursor = resuming ? conversation.task?.replayCursor : undefined;
const cursorNote = cursor
  ? `技能「${cursor.name}」停在第 ${cursor.nextStep - 1} 步交还给了我，请用 browser_skills_play 从 fromStep = ${cursor.nextStep} 续播。`
  : '';
const handoverNote = handover.length ? `我刚才接管了浏览器，期间：${handover.join('；')}。` : '';
const resumeText = [handoverNote, cursorNote, text].filter(Boolean).join('\n') || '继续任务';
```

并在 `resuming` 时把 `replayCursor: undefined` 加进 `conversation.task = { ...conversation.task!, … }` 的重置字段里；`if (resuming && (handoverNote || text))` 改为 `if (resuming && (handoverNote || cursorNote || text))`。

- [ ] **Step 6: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm format && pnpm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts.ts src/main/main.ts
git commit -m "feat(recording): let any Agent list kept skills and replay them through the ordinary tool path

browser.skills.play is a normal intent: the first replay of a skill in
a task asks the person once, even in full mode, and the approval digest
covers the step hash. The player then runs under the Agent's own
attachment with each step recorded; a human step hands the browser
back and the resume note tells the Agent where to continue."
```

---

### Task 8: 编辑保存 IPC 与校验

**Files:**

- Modify: `src/shared/contracts.ts`（`SkillSaveSchema`、IPC）
- Modify: `src/preload/index.ts`、`src/preload/entry.cts`
- Modify: `src/main/main.ts`

**Interfaces:**

- Consumes: `validateSkillEdit`（Task 3）、`StepSchema`（第一期）、`library.readSkill/writeSkill`（Task 2）
- Produces:
  - `SkillSaveSchema = z.object({ id, prose: z.string().max(20_000), steps: z.array(z.record(z.string(), z.unknown())).max(500) }).strict()`
  - IPC `skillsSave: 'skills:save'`；preload `skills.save(id, prose, steps)`
  - main.ts `saveSkillEdit(input)`：逐条 `StepSchema.parse`，`validateSkillEdit(existing, submitted)` 不过就抛中文错误并指出第几步，通过则 `writeSkill` 并刷新列表

- [ ] **Step 1: 契约与 preload**

`src/shared/contracts.ts` 在 `SkillRenameSchema` 之后加：

```ts
export const SkillSaveSchema = z
  .object({
    id: z.string().min(1).max(60),
    prose: z.string().max(20_000),
    /** 步骤原样交回主进程，由 StepSchema 与 validateSkillEdit 把关。 */
    steps: z.array(z.record(z.string(), z.unknown())).max(500),
  })
  .strict();
```

`IPC` 里加 `skillsSave: 'skills:save',`。两个 preload 的 `skills` 组各加：

```ts
    save: (id: string, prose: string, steps: Record<string, unknown>[]) =>
      ipcRenderer.invoke(IPC.skillsSave, { id, prose, steps }),
```

- [ ] **Step 2: `src/main/main.ts`**

import 加 `validateSkillEdit`、`StepSchema`（从 `./recording/index.js`）与 `SkillSaveSchema`。在 `discardDistilled` 之后加：

```ts
/** 界面只给结构化操作，但「不能新建动作步骤」在这里执行，不依赖界面。 */
async function saveSkillEdit(input: {
  id: string;
  prose: string;
  steps: Record<string, unknown>[];
}): Promise<void> {
  if (!(await library.hasSkill(input.id))) throw new Error('该技能尚未提炼，先提炼再编辑');
  if (pendingSkill?.id === input.id || distilling?.id === input.id)
    throw new Error('正在提炼，请先保留或丢弃提案');
  const { skill } = await library.readSkill(input.id);
  const submitted = input.steps.map((raw, index) => {
    const parsed = StepSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`第 ${index + 1} 步不合法：${parsed.error.issues[0].message}`);
    return parsed.data;
  });
  const verdict = validateSkillEdit(skill.steps, submitted);
  if (!verdict.ok)
    throw new Error(
      verdict.reason === 'NEW_ACTION'
        ? `第 ${verdict.step} 步是新增的动作，编辑不能新建动作步骤`
        : `第 ${verdict.step} 步重复了现有动作，编辑不能复制动作步骤`,
    );
  await library.writeSkill(input.id, input.prose, { ...skill, steps: submitted });
  store.recordEvent('skill', input.id, 'skill.edited', { steps: submitted.length });
  await refreshSkills();
}
```

IPC：`handle(IPC.skillsSave, SkillSaveSchema, (value) => saveSkillEdit(value));`

- [ ] **Step 3: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm format && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/shared/contracts.ts src/preload/index.ts src/preload/entry.cts src/main/main.ts
git commit -m "feat(recording): save an edited skill only when every action already existed

The editor may delete, reorder, change a value or insert a human
step; the main process re-validates every submitted step and refuses
any action the file did not already hold."
```

---

### Task 9: 技能库界面：编辑、提炼预览、Agent 回放状态

**Files:**

- Modify: `src/renderer/SkillLibrary.tsx`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/style.css`

**Interfaces:**

- Consumes: `SkillDetail` / `SkillStepView` / `DistillationState` / `AgentReplayState`（Task 6、7）、`window.pilion.skills.{distill, keep, discard, save}`（Task 6、8）
- Produces: 技能库详情页的编辑与提炼交互；Agent 操作条显示回放进度

- [ ] **Step 1: `SkillLibrary.tsx` 的 props 与状态**

Props 加 `distillation?: DistillationState;` 与 `agentConnected: boolean;`。组件内新增状态：

```ts
const [editing, setEditing] = useState(false);
const [prose, setProse] = useState('');
const [steps, setSteps] = useState<SkillStepView[]>([]);
const [dirty, setDirty] = useState(false);
```

进入编辑（按钮「编辑」，仅已提炼可用）时 `setProse(shown.prose ?? '')`、`setSteps(shown.steps)`、`setEditing(true)`；选中行变化时退出编辑（在现有 `onClick` 里 `setEditing(false)`）。

- [ ] **Step 2: 步骤编辑器**

编辑态下步骤列表每行显示 `text`，右侧操作：上移、下移、删除；`kind === 'type'` 显示可编辑的文本框（改 `raw.text`）、`kind === 'select'` 改 `raw.value`、`kind === 'human'` 改 `raw.reason`；行与行之间有「+ 需要我」按钮插入 `{ index: 0, kind: 'human', text: '', raw: { kind: 'human', onUrl: <上一步的 onUrl 或 steps[0].raw.url>, reason: '' } }`。修改后 `setDirty(true)`；行文本在编辑态用 `raw` 派生：

```ts
function describeRaw(raw: Record<string, unknown>): string {
  const target = raw.target as { name?: string } | undefined;
  switch (raw.kind) {
    case 'navigate':
      return `打开 ${raw.url}`;
    case 'type':
      return `输入 "${target?.name ?? ''}" = "${raw.text}"`;
    case 'select':
      return `选择 "${target?.name ?? ''}" = "${raw.value}"`;
    case 'human':
      return `需要我：${raw.reason}`;
    case 'note':
      return `备注：${raw.text}`;
    default:
      return String(raw.kind);
  }
}
```

（`click` / `check` / `press` 不可改，直接显示原 `text`。）保存：`run(() => window.pilion.skills.save(selected.id, prose, steps.map((s) => s.raw)))` 成功后 `setEditing(false); setDirty(false)`；取消：`setEditing(false)`。散文用 `<textarea>` + 右侧 `ReactMarkdown` 预览。

- [ ] **Step 3: 提炼入口与预览**

header 的动作区：仅轨迹显示「提炼」，已提炼显示「重炼」，`disabled={!agentConnected || busy || distillation?.status === 'running'}`，点击 `run(() => window.pilion.skills.distill(selected.id))`；未连 Agent 时 `title="先连接 Agent"`。

详情页顶部（`selected.error` 判断之前）按 `distillation?.id === selected.id` 渲染横幅：

- `running`：`<div className="distill-banner running">提炼中…（可在右侧对话里看到过程）</div>`
- `rejected`：`<div className="distill-banner rejected">提炼未通过：{reason} <button>重炼</button> <button>关闭</button></div>`（关闭 = `skills.discard()`）
- `proposed`：`<div className="distill-banner proposed">Agent 提炼好了，看一遍再决定 <button class="secondary-button">保留</button> <button>丢弃</button> <button>重炼</button></div>` 下方渲染提案：`ReactMarkdown` 显示 `markdown` 里块之前的散文（用 `markdown.split('```json pilion-skill')[0]`），再用 `<ol className="skills-steps">` 显示 `steps`（`manual` 的行标「手工添加」）

列表行副标题加状态：已提炼显示 `about`，仅轨迹显示「仅轨迹 · Agent 看不到」。

- [ ] **Step 4: `main.tsx`**

传入 `distillation={state.distillation}` 与 `agentConnected={state.agentStatus === 'ready' && state.attachmentStatus === 'attached'}`。Agent 操作条的 detail：把 `agentActivity.detail` 的渲染改为

```tsx
{
  state.agentReplay
    ? `回放「${state.agentReplay.name}」 ${state.agentReplay.step}/${state.agentReplay.total}`
    : agentActivity.detail;
}
```

（渲染条件同步改为 `state.agentReplay || agentActivity.detail`。）

- [ ] **Step 5: CSS**

`style.css` 末尾加：

```css
.distill-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--accent-border);
  border-radius: 8px;
  background: var(--accent-soft);
}
.distill-banner.rejected {
  border-color: var(--danger);
  background: var(--danger-soft);
}
.distill-banner.running {
  color: var(--muted);
}
.skills-editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 760px) {
  .skills-editor {
    grid-template-columns: 1fr;
  }
}
.skills-editor textarea {
  width: 100%;
  min-height: 160px;
  padding: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--input);
  color: var(--text);
  font: inherit;
}
.skills-steps li .step-actions {
  grid-column: 2;
  display: flex;
  gap: 6px;
}
.skills-steps li input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--input);
  color: var(--text);
}
.skills-steps li.manual .step-mark {
  color: var(--muted);
}
.skills-insert {
  color: var(--accent);
  font-size: 12px;
}
```

- [ ] **Step 6: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm format && pnpm build`
Expected: 全绿；`react-hooks` 规则无警告（不要在 effect 里同步 setState；用派生值或事件处理器）

- [ ] **Step 7: Commit**

```bash
git add src/renderer/SkillLibrary.tsx src/renderer/main.tsx src/renderer/style.css
git commit -m "feat(renderer): edit a skill's prose and steps, review a distillation, show Agent replay progress

Steps get only structural operations (delete, move, change a value,
insert a human step); there is no button that creates an action. A
proposed distillation is reviewed in place with keep, discard and
redo, and the Agent's replay progress shows in the operation bar."
```

---

### Task 10: fixture Agent、E2E、文档

**Files:**

- Modify: `tests/fixtures/e2e-agent.mjs`
- Modify: `tests/electron.e2e.ts`
- Modify: `docs/architecture.md`、`CHANGELOG.md`、`README.md`

**Interfaces:**

- Consumes: 全部前序任务

- [ ] **Step 1: fixture Agent 两个分支**

在 `e2e-agent.mjs` 的 `session.prompt` 处理里、`if (promptText === '继续任务')` 之前加：

````js
if (promptText.includes('提炼成一份可复用的技能文档')) {
  // 固定的提炼结果：只从轨迹里挑步骤，把邮箱换成占位符。
  const block = promptText.slice(promptText.indexOf('```json pilion-trajectory'));
  const trajectory = JSON.parse(
    block.split('\n').slice(1, block.split('\n').indexOf('```')).join('\n'),
  );
  const actions = trajectory.entries
    .filter((entry) => entry.kind === 'step' && entry.step.kind !== 'note')
    .map((entry) => entry.step);
  const doc = [
    `# ${trajectory.meta.name}`,
    '',
    '## 什么时候用',
    '',
    '需要打开示例站点并进入 IANA 说明页时。',
    '',
    '## 前置条件',
    '',
    '- 无',
    '',
    '## 已知坑',
    '',
    '- 无',
    '',
    '```json pilion-skill',
    JSON.stringify({ meta: { about: '打开示例站点并点进说明页' }, steps: actions }, null, 2),
    '```',
  ].join('\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `提炼结果如下：\n\n${doc}\n` },
    },
  });
  return { stopReason: 'end_turn' };
}
if (promptText.includes('用技能')) {
  const listed = await mcpClient.callTool({ name: 'browser_skills_list', arguments: {} });
  const skills = JSON.parse(listed.content.find((item) => item.type === 'text').text);
  const fromStepMatch = /fromStep = (\d+)/.exec(promptText);
  const played = await mcpClient.callTool({
    name: 'browser_skills_play',
    arguments: {
      skillId: skills[0].id,
      ...(fromStepMatch ? { fromStep: Number(fromStepMatch[1]) } : {}),
    },
  });
  const outcome = JSON.parse(played.content.find((item) => item.type === 'text').text);
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `技能结果：${JSON.stringify(outcome)}` },
    },
  });
  return { stopReason: 'end_turn' };
}
````

（「继续任务」分支收到的 prompt 带 `resumeText`；上面的 `fromStep` 解析靠 Task 7 的交接句 `fromStep = N`。「继续任务」分支只在 promptText 完全等于 `'继续任务'` 时命中，带交接说明时会落到 `用技能` 分支之外 —— 所以把 `用技能` 分支的条件写成 `promptText.includes('用技能') || promptText.includes('browser_skills_play')`。）

- [ ] **Step 2: E2E**

在 `tests/electron.e2e.ts` 末尾加四个用例。共用的准备：连接 fixture Agent（照文件里 `built-in local Agent selection` 用例的做法：`agents.save` + `agents.connect` + 等 `agentStatus === 'ready'`），录制 `navigate example.com → click Learn more`（照第一期用例），停止为 `'e2e 技能'`。

```ts
test('the Agent distils a recording, the person keeps it, and the Agent replays it after one approval', async () => {
  // …连接 fixture Agent、录制两步、stop('e2e 技能')（与第一期用例相同的调用）…
  await shell.evaluate(() => window.pilion.skills.distill('e2e-技能'));
  await expect
    .poll(async () => (await state()).distillation?.status, { timeout: 60_000 })
    .toBe('proposed');
  const proposal = (await state()).distillation!;
  expect(proposal.steps?.map((step) => step.kind)).toEqual(['navigate', 'click']);
  await shell.evaluate(() => window.pilion.skills.keep());
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'e2e-技能')?.distilled)
    .toBe(true);
  await shell.evaluate(() => window.pilion.tabs.open());
  await shell.evaluate(() => window.pilion.agents.task('用技能打开说明页'));
  // full 模式下也要审批：等审批出现，批准
  await expect.poll(async () => (await state()).approvals.length).toBe(1);
  const approval = (await state()).approvals[0];
  expect(approval.tool).toBe('browser.skills.play');
  expect(approval.summary).toContain('1. 打开 https://example.com/');
  await shell.evaluate(
    (a) => window.pilion.agents.approve(a.approvalId, a.nonce!, a.actionDigest!, 'approve'),
    approval,
  );
  await expect.poll(async () => (await state()).agentStatus, { timeout: 60_000 }).toBe('ready');
  const after = await state();
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('iana.org');
  const last = after.conversations
    ?.find((c) => c.id === after.activeConversationId)
    ?.messages.at(-1);
  expect(last?.text).toContain('"ok":true');
});
```

其余三个用例按 spec 的测试段写：② 手写一个已提炼但目标不存在的技能（`skill.md` 直接写入 `recordings/gone/`，`trajectory.md` 同 Task 11 第一期的做法）→ `agents.task('用技能')` → 审批 → 最后一条消息含 `"failedAt":2` 与 `"remaining"`；③ 技能第二步为 `human`（手写）→ 回放后 `task.status === 'manual'`、`task.replayCursor.nextStep === 3`，`agents.resume()` 后 fixture 收到含 `fromStep = 3` 的交接句并续播完成；④ `skills.save` 删一步 + 插 human → `skills.read` 的 `steps` 反映变化 → 再 `agents.task('用技能')` 时 `approvals.length` 再次为 1（哈希变了）。

- [ ] **Step 3: 跑 E2E**

Run: `pnpm test:e2e`
Expected: 新增四个用例 PASS；原有用例不受影响（本机 `codex` shim 那条除外）。若第一个用例在 `distillation.status` 处超时，先看右侧对话里 fixture 是否回了文档、再看主进程 `lastError`

- [ ] **Step 4: 文档**

`docs/architecture.md`「录制与技能」把最后一段「第二期：…」替换为：

````markdown
Agent 在一个专属对话里把轨迹提炼成 `skill.md`：那一轮没有浏览器工具，主进程从回合文本里取出 ```json pilion-skill 块并按四条规则与轨迹逐步对账 —— 每个动作步必须消耗一条同类型同目标的轨迹步、值不能改写（可用 `{{占位符}}` 隐去）、导航地址必须去过、只有 `human` 与 `note` 可以自由插入。人按保留才落盘；界面只能删、排、改值、插「需要我」，主进程再次校验，不能新建动作步骤。

`browser.skills.list` 只列已提炼的技能；`browser.skills.play` 走与其它工具相同的 Intent 路径，同一任务内首次回放某技能需人一次审批（`full` 模式也问），审批摘要列出全部步骤、digest 覆盖步骤哈希。之后每一步仍以 Agent 的 attachment 记账并附 `replay.step` 事件。目标解析失败时工具返回失败现场，Agent 只修那一步再以 `fromStep` 续播；遇到「需要我」或占位符则任务转人工，人继续时交接说明里注明从第几步续播。
````

「模块」表加 `main/recording/distill.ts`。`CHANGELOG.md`「未发布」加：

```markdown
- Agent 可以把录制提炼成技能：在一个专属对话里跑一次，Pilion 逐步核对它没有凭空造步骤，你看过再保留
- 任意 ACP Agent 都能通过 `browser_skills_list` / `browser_skills_play` 发现并回放已提炼的技能；同一任务内首次回放需要你确认一次（完全访问模式也问），卡在需要人的步骤会把浏览器交回给你
- 技能库可以编辑：散文随便改，步骤只能删、排、改值、插「需要我」，不能新建动作
```

`README.md` 第 5 行与第 41 行附近的 MCP 工具描述里加上 `browser_skills_list` / `browser_skills_play`。

- [ ] **Step 5: 全部检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add tests/fixtures/e2e-agent.mjs tests/electron.e2e.ts docs/architecture.md CHANGELOG.md README.md
git commit -m "test(recording): distil, approve and replay a skill end to end; document phase two"
```

---

## 自查记录

**Spec 覆盖**

| Spec 章节                                                                                                      | Task |
| -------------------------------------------------------------------------------------------------------------- | ---- |
| skill.md 格式、`isPlaceholder`                                                                                 | 1    |
| 库的 `hasSkill/readSkill/writeSkill`、summary `distilled/about`                                                | 2    |
| 提炼 prompt、取块、四条对账、非阻塞 manual、编辑校验                                                           | 3、8 |
| 占位符回放当 human                                                                                             | 4    |
| MCP 两个工具与描述、`ToolNameSchema`、空白页允许                                                               | 5    |
| 提炼会话、无浏览器工具、`distillation` 状态、保留/丢弃/重炼                                                    | 6    |
| `play` 主路径、首次审批（full 也问）、`replay.step`、HUMAN 交还、`replayCursor` 交接、`agentReplay` 互斥与取消 | 7    |
| 编辑分权（主进程校验）                                                                                         | 8    |
| 界面：编辑、预览、提炼入口、Agent 回放 detail                                                                  | 9    |
| E2E 四个、文档                                                                                                 | 10   |

**已知取舍**：Task 7 把 `play` 的审批与执行接在既有 `runTool → executePreparedAction → performTool` 上，`pendingSkillPlays` 以 `requestId` 为键在两段之间传递已加载的技能与执行者身份，`performTool` 签名不变。`agentReplay.step` 在 `execute` 里读取是为了给 `replay.step` 事件记序号，`onProgress` 先于每步的 `execute` 调用，所以序号正确。
