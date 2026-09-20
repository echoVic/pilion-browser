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
  if (close < 0) throw new RecordingFormatError(open + 1, `\`\`\`json ${tag} 代码块没有闭合`);
  return { body: lines.slice(open + 1, close).join('\n'), startLine: open + 2 };
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
