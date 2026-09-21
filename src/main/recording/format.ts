import {
  LoggedEventSchema,
  SkillSchema,
  TrajectorySchema,
  type LoggedEvent,
  type Skill,
  type Step,
  type Trajectory,
  type TrajectoryEntry,
} from './types.js';

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

function parseBlock(md: string, tag: string): unknown {
  const { body, startLine } = locateBlock(md, tag);
  try {
    return JSON.parse(body);
  } catch (error) {
    const offset = /position (\d+)/.exec(String(error))?.[1];
    const before = offset ? body.slice(0, Number(offset)).split('\n').length - 1 : 0;
    throw new RecordingFormatError(
      startLine + before,
      `代码块里的 JSON 无法解析：${String(error)}`,
    );
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
  const head = prose.trimEnd() || `# ${skill.meta.name}`;
  return [head, '', `\`\`\`json ${SKILL_TAG}`, JSON.stringify(skill, null, 2), '```', ''].join(
    '\n',
  );
}

/** 审批摘要按行编号，所以步骤描述里的值必须是一行：换行可以伪造出看起来像步骤的行。 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function describeStep(step: Step): string {
  if (step.kind === 'navigate') return `打开 ${oneLine(step.url)}`;
  if (step.kind === 'note') return `备注：${oneLine(step.text)}`;
  if (step.kind === 'human') return `需要我：${oneLine(step.reason)}`;
  const { role, nth } = step.target;
  const name = oneLine(step.target.name);
  // 点击与勾选的目标歧义才是人需要看见的，所以只有它们带 role 与 nth。
  const where = nth ? `（${role}，第 ${nth} 个）` : `（${role}）`;
  const subject = `"${name}"${where}`;
  if (step.kind === 'click') return `点击 ${subject}`;
  if (step.kind === 'check') return `${step.checked ? '勾选' : '取消勾选'} ${subject}`;
  if (step.kind === 'type') return `输入 "${name}" = "${oneLine(step.text)}"`;
  if (step.kind === 'select') return `选择 "${name}" = "${oneLine(step.value)}"`;
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
 * 有 source（第二期起）说明步骤是从同目录的事件日志算出来的：文件本身只作展示，
 * 手改不作数，下次读取会被日志重算覆盖。没有 source 的是第一期的老录制，
 * md 里的步骤就是全部真相，说明保持原样。
 */
export function serializeTrajectory(value: Trajectory): string {
  const parsed = TrajectorySchema.parse(value);
  const timeline = parsed.entries.map((entry) => `- ${describeEntry(entry)}`);
  const prose = parsed.meta.source
    ? `录制于 ${parsed.meta.recordedAt}。步骤由同目录的 events.jsonl 算出，时间线又由下方代码块渲染；` +
      `直接修改本文件不作数，下次读取会按事件日志重算。要改请先提炼成技能，在技能库里改。`
    : `录制于 ${parsed.meta.recordedAt}。以下时间线由下方代码块渲染，加载时忽略；代码块是唯一真相。`;
  return [
    `# ${parsed.meta.name}`,
    '',
    prose,
    '',
    ...timeline,
    '',
    `\`\`\`json ${TRAJECTORY_TAG}`,
    JSON.stringify(parsed, null, 2),
    '```',
    '',
  ].join('\n');
}

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
