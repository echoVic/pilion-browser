import { extractSkillMarkdown, reconcile, unsupportedSteps } from './distill.js';
import { parseSkill, serializeSkill } from './format.js';
import type { Skill, Step, Trajectory } from './types.js';

/**
 * 提炼自己的状态机：一份录制的名额、进行中的那一轮、待人定夺的提案、上一次的拒绝理由。
 * 对话与 prompt 的编排不在这里——那部分和通用任务共用连接与状态，留在 main.ts。
 */
export interface DistillationDeps {
  /** 提炼只用得到写技能这一件事；真身是 RecordingLibrary。 */
  library: { writeSkill(id: string, prose: string, skill: Skill): Promise<void> };
  /** 台账：aggregateType 固定是 skill，由主进程钉住。 */
  recordEvent(id: string, eventType: string, payload: Record<string, unknown>): void;
  /** 状态变了就通知渲染进程；就是 main.ts 的 emit。 */
  emit(): void;
  refreshSkills(): Promise<void>;
  log(line: string): void;
}

export interface DistillRound {
  id: string;
  name: string;
  conversationId: string;
}
export interface DistillProposal extends DistillRound {
  prose: string;
  skill: Skill;
  /** 预览给人看的、也正是按下保留时会写进文件的那份原文。 */
  markdown: string;
  /** 对账时算出来的「手工添加」序号（从 1 起）；视图由 main.ts 组装。 */
  manual: number[];
}
export interface DistillRejection extends DistillRound {
  reason: string;
}
export interface AcceptInput extends DistillRound {
  /** 这一轮里 Agent 说过的话，按顺序拼起来。 */
  reply: string;
  trajectory: Trajectory;
  /** 提炼它的 Agent 配置 id。 */
  distilledBy: string;
}
export type AcceptResult =
  { ok: true; steps: readonly Step[]; manual: readonly number[] } | { ok: false; reason: string };

function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DistillationState {
  readonly #deps: DistillationDeps;
  /** 占位到 begin 真正开跑为止：startDistillation 在第一个 await 前就把名额占住。 */
  #claimed: string | undefined;
  /** 提炼那一轮：Agent 只准输出文档。 */
  #running: DistillRound | undefined;
  #pending: DistillProposal | undefined;
  #rejected: DistillRejection | undefined;

  constructor(deps: DistillationDeps) {
    this.#deps = deps;
  }

  /** 名额被占着（含还没真正开跑的那一刻）。 */
  get active(): boolean {
    return this.#claimed !== undefined || this.#running !== undefined;
  }
  get running(): DistillRound | undefined {
    return this.#running;
  }
  get pending(): DistillProposal | undefined {
    return this.#pending;
  }
  get rejected(): DistillRejection | undefined {
    return this.#rejected;
  }

  /**
   * 这份录制此刻动不得的理由前半句，后果由调用方接上（「，无法删除」「，请先保留或丢弃提案」）。
   * 提案还在手上时也要挡：改名与删除都会重写那份随时可能被保留覆盖掉的文件。
   */
  busyReasonFor(id: string): string | undefined {
    return this.#claimed === id || this.#running?.id === id || this.#pending?.id === id
      ? '正在提炼'
      : undefined;
  }

  /** 占住名额；读轨迹与重连都是 await，不先占住的话两次点击都能进来。 */
  claim(id: string): void {
    if (this.active) throw new Error('已有提炼在进行');
    this.#claimed = id;
  }

  /** 放开名额：开跑前失败了就是退掉占位，跑完了就是这一轮结束；提案与拒绝理由不动。 */
  release(): void {
    this.#claimed = undefined;
    this.#running = undefined;
  }

  /** 这一轮真的开跑了：重炼时上一轮的提案与拒绝理由到此为止。 */
  begin(id: string, name: string, conversationId: string): void {
    this.#claimed = undefined;
    this.#pending = undefined;
    this.#rejected = undefined;
    this.#running = { id, name, conversationId };
  }

  /**
   * 取块、补齐 meta、解析、对账，过了才成为待人定夺的提案——此刻磁盘上还什么都没有。
   * 对账这一关的意义在于：提炼不能变成「Agent 写出一串你没做过的操作，然后请你批准」。
   */
  accept(input: AcceptInput): AcceptResult {
    const { id, name, conversationId, reply, trajectory, distilledBy } = input;
    const reject = (reason: string): AcceptResult => {
      this.#rejected = { id, name, conversationId, reason };
      return { ok: false, reason };
    };
    const extracted = extractSkillMarkdown(reply);
    if (!extracted) return reject('回复里没有 ```json pilion-skill 代码块');
    // 元信息以 Pilion 为准：Agent 只需要给 about，其余键在解析前补齐。
    const metaOpen = /"meta"\s*:\s*\{/;
    if (!metaOpen.test(extracted)) return reject('回复的技能块缺少 meta');
    const withMeta = extracted.replace(
      metaOpen,
      () =>
        `"meta": { "app": "pilion", "version": 1, "kind": "skill", "name": ${JSON.stringify(name)}, "recordedAt": ${JSON.stringify(trajectory.meta.recordedAt)}, "distilledBy": ${JSON.stringify(distilledBy)}, "trajectory": "trajectory.md", `,
    );
    let parsed: ReturnType<typeof parseSkill>;
    try {
      parsed = parseSkill(withMeta);
    } catch (error) {
      return reject(readable(error));
    }
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
    // 「这一步要人来做」和已保留技能的详情走同一个助手算，不再写死成空。
    const manual = unsupportedSteps(skill, trajectory);
    this.#pending = {
      id,
      name,
      conversationId,
      prose: parsed.prose,
      skill,
      markdown: serializeSkill(parsed.prose, skill),
      manual,
    };
    this.#deps.log(`提炼完成，等待保留：${name}`);
    return { ok: true, steps: skill.steps, manual };
  }

  /** 这一轮没拿到成品：取消、报错都走这里。 */
  reject(input: DistillRejection): void {
    this.#rejected = { ...input };
  }

  /** 人按下保留才落盘。 */
  async keep(): Promise<void> {
    const proposal = this.#pending;
    if (!proposal) throw new Error('没有待保留的提炼结果');
    await this.#deps.library.writeSkill(proposal.id, proposal.prose, proposal.skill);
    this.#pending = undefined;
    this.#deps.recordEvent(proposal.id, 'skill.kept', {
      distilledBy: proposal.skill.meta.distilledBy,
    });
    this.#deps.log(`技能已保留：${proposal.name}`);
    await this.#deps.refreshSkills();
  }

  discard(): void {
    this.#pending = undefined;
    this.#rejected = undefined;
    this.#deps.emit();
  }

  /** 退出：名额、进行中、提案、拒绝理由一次清干净。 */
  finish(): void {
    this.release();
    this.discard();
  }
}
