import { sha256 } from '../host/canonical.js';
import { oneLine } from './format.js';
import { normalizeName } from './resolve.js';
import {
  isPlaceholder,
  NAVIGATE_CAUSES,
  type LoggedEvent,
  type Skill,
  type Step,
  type Trajectory,
} from './types.js';

const SKILL_FENCE = '```json pilion-skill';
type ActionStep = Extract<Step, { target: unknown }>;

export type ReconcileResult =
  | { ok: true }
  | { ok: false; step: number; reason: 'NO_EVIDENCE' | 'VALUE_CHANGED' | 'URL_UNKNOWN' };
export type EditVerdict =
  { ok: true } | { ok: false; step: number; reason: 'NEW_ACTION' | 'TOO_MANY' };

/**
 * 固定说明 + 轨迹原文，选配过程记录。规则写给任意 ACP Agent 看，所以每条都直白。
 * 不给 process 时输出必须和过程记录上线之前逐字节相同——这段 prompt 已经在生产里跑着，
 * 谁在这加东西都不能悄悄改到没给 process 的老路径。
 */
export function buildDistillPrompt(
  name: string,
  trajectoryMarkdown: string,
  process?: string,
): string {
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
    ...(process
      ? [
          '',
          '过程记录（你在浏览器里看不到的那部分）：',
          '',
          process,
          '',
          '过程记录是给你判断「什么时候用」「前置条件」「已知坑」和哪些步骤是误操作用的上下文。步骤仍然只能从 pilion-trajectory 代码块里挑选、合并、重排。',
        ]
      : []),
  ].join('\n');
}

const GAP_MS = 3_000;

const NAVIGATE_CAUSE_LABEL: Record<(typeof NAVIGATE_CAUSES)[number], string> = {
  address: '地址栏',
  back: '后退',
  forward: '前进',
  reload: '刷新',
};

/** 目标的可访问名可能是空串（富文本被刻意抹掉、或元素本来就没有名字），退回标签名，绝不留一对空引号。 */
function targetLabel(event: { target: { name: string }; el: { tagName: string } }): string {
  return oneLine(event.target.name) || oneLine(event.el.tagName);
}

/**
 * 除了 renderEvents 里已经折叠处理的滚动、输入、富文本编辑，以及并入点击的按下外，
 * 每种事件给一句中文；不解释、不猜意图，只如实转述发生了什么。
 * secret 不带任何值或长度——只说填过密码/验证码；unsupported 沿用 project.ts 里已经在用的三种原因说法。
 */
function describeLoggedEvent(
  event: Exclude<LoggedEvent, { kind: 'scroll' | 'input' | 'edit' }>,
): string {
  switch (event.kind) {
    case 'page': {
      const title = oneLine(event.title);
      const url = oneLine(event.url);
      return title && title !== url ? `打开页面 "${title}"（${url}）` : `打开页面 ${url}`;
    }
    case 'navigate':
      return `打开 ${oneLine(event.url)}（${NAVIGATE_CAUSE_LABEL[event.cause]}）`;
    case 'note':
      return `备注：${oneLine(event.text)}`;
    case 'pointer':
      return `按下 "${targetLabel(event)}"`;
    case 'click':
      return `点击 "${targetLabel(event)}"`;
    case 'select':
      return `选择 "${targetLabel(event)}" = "${oneLine(event.value)}"`;
    case 'check':
      return `${event.checked ? '勾选' : '取消勾选'} "${targetLabel(event)}"`;
    case 'key':
      return `按键 ${event.shift ? 'Shift+' : ''}${event.key} 于 "${targetLabel(event)}"`;
    case 'secret':
      return event.otp ? '填写验证码' : '填写密码';
    case 'unsupported': {
      const what = event.el
        ? `"${oneLine(event.el.name) || oneLine(event.el.tagName)}"`
        : '页面内嵌框架';
      if (event.reason === 'gesture') return `手动完成在 ${what} 上的拖拽或右键操作`;
      if (event.reason === 'iframe') return '手动完成内嵌框架里的操作';
      return `手动点击 ${what}`;
    }
  }
}

/** 不超就原样返回；超了砍中间，两头各留一半，让 Agent 看得到开头怎么开始、结尾怎么收。 */
function clamp(lines: readonly string[], limit: number): string[] {
  if (lines.length <= limit) return [...lines];
  const front = Math.floor(limit / 2);
  const back = limit - front;
  return [
    ...lines.slice(0, front),
    `- 省略 ${lines.length - limit} 条`,
    ...lines.slice(lines.length - back),
  ];
}

/**
 * 给 Agent 与人看的过程时间线：折叠连续滚动、同一字段的连续输入与连续富文本编辑，
 * 把紧跟点击的那次按下并进点击的同一行（跟 project.ts 里投影层的规则一致：
 * 按下从不单独产出条目，除非后面没有等到点击），标出超过三秒（含等于）的停顿，总行数封顶。
 * 纯函数——时间差只从事件自带的 `at` 算，不读当前时钟、不做任何 I/O。
 */
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
      lines.push(`- 在 "${targetLabel(last)}" 里填 "${oneLine(last.value)}"${times}`);
      continue;
    }
    if (event.kind === 'edit') {
      // 同一字段的连续富文本编辑跟 input 一样折叠：只留最终字数、注明改了几次。
      // 字数是数字插值、不进引号，不会被读成“真的填了这么几个字符的内容”。
      let run = 1;
      let last = event;
      while (
        events[index + 1]?.kind === 'edit' &&
        (events[index + 1] as typeof event).index === event.index
      ) {
        index += 1;
        last = events[index] as typeof event;
        run += 1;
      }
      previousAt = Date.parse(last.at);
      const times = run > 1 ? `（改了 ${run} 次）` : '';
      lines.push(`- 在富文本里输入了 ${last.length} 个字${times}`);
      continue;
    }
    if (event.kind === 'pointer') {
      // 紧跟着同一个 index 上的点击时，这次按下不单独占一行——它就是那次点击的前半程。
      // 没有跟上（比如按下之后页面直接跳走，click 事件没来得及触发）就落到下面按普通事件渲染。
      const next = events[index + 1];
      if (next?.kind === 'click' && next.index === event.index) continue;
    }
    lines.push(`- ${describeLoggedEvent(event)}`);
  }
  return clamp(lines, limit).join('\n');
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

/**
 * 对账要认的是整个目标，不只是它的名字：resolve 会先用指纹匹配，而指纹只校验角色与标签，
 * 所以「甲的名字 + 乙的指纹」这种步骤必须在这里就被判成没有依据。
 */
function targetKey(step: ActionStep): string {
  return `${step.kind}|${sha256({ ...step.target, name: normalizeName(step.target.name) })}`;
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
