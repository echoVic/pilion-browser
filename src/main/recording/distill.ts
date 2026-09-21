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
  return sha256(steps);
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
