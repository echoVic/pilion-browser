import { extractSkillMarkdown } from './distill.js';
import { validateSkillEdit } from './distill.js';
import { parseSkill } from './format.js';
import type { Skill, Step } from './types.js';

/**
 * 普通对话回合里 Agent 自己吐出来的 ```json pilion-skill 块。和提炼（distillation.ts）不同：
 * 提炼有一份录制轨迹，跑完四条对账才待人保留；这里没有轨迹，Agent 只是在聊天里"写"了一段。
 *
 * 安全折中：提案永不直接落盘，也不凭它新建可回放技能——没有录制证据的动作步骤是无源之水。
 * 人把它指给某份**已存在、已提炼**的技能当修改时，才走 validateSkillEdit（与界面手工编辑同一道关）：
 * 提案里每个动作步必须能在目标技能里找到同 kind 同目标的一条，不能新增动作、不能复制动作。
 * 也就是说 Agent 对技能库的写权限，被限制成"只能在人录过的步骤里重排、删改值、插 human/note"。
 */
export interface SkillProposal {
  proposalId: string;
  conversationId: string;
  messageId: string;
  name: string;
  prose: string;
  steps: Step[];
}

export interface SkillProposalDeps {
  library: {
    hasSkill(id: string): Promise<boolean>;
    readSkill(id: string): Promise<{ prose: string; skill: Skill; markdown: string }>;
    writeSkill(id: string, prose: string, skill: Skill): Promise<void>;
  };
  recordEvent(id: string, eventType: string, payload: Record<string, unknown>): void;
  emit(): void;
  refreshSkills(): Promise<void>;
  log(line: string): void;
}

function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkillProposalState {
  readonly #deps: SkillProposalDeps;
  readonly #items = new Map<string, SkillProposal>();
  #next = 0;

  constructor(deps: SkillProposalDeps) {
    this.#deps = deps;
  }

  list(): SkillProposal[] {
    return [...this.#items.values()];
  }

  /**
   * 从一条 Agent 回合回复里取技能块。取不出来（没有块 / 缺 meta / 解析失败）就返回 undefined，
   * 当作普通聊天，不报错。解析失败只意味着 Agent 格式不对，不代表它在捣乱。
   */
  capture(input: {
    conversationId: string;
    messageId: string;
    reply: string;
  }): SkillProposal | undefined {
    const extracted = extractSkillMarkdown(input.reply);
    if (!extracted) return undefined;
    let parsed: { prose: string; skill: Skill };
    try {
      parsed = parseSkill(extracted);
    } catch {
      return undefined;
    }
    if (parsed.skill.steps.length === 0) return undefined;
    this.#next += 1;
    const proposal: SkillProposal = {
      proposalId: `prop-${Date.now().toString(36)}-${this.#next}`,
      conversationId: input.conversationId,
      messageId: input.messageId,
      name: parsed.skill.meta.name || '未命名技能',
      prose: parsed.prose,
      steps: parsed.skill.steps,
    };
    this.#items.set(proposal.proposalId, proposal);
    this.#deps.log(`Agent 提出技能修改提案：${proposal.name}，待人确认`);
    this.#deps.emit();
    return proposal;
  }

  discard(proposalId: string): void {
    this.#items.delete(proposalId);
    this.#deps.emit();
  }

  discardConversation(conversationId: string): void {
    for (const [id, proposal] of this.#items)
      if (proposal.conversationId === conversationId) this.#items.delete(id);
  }

  finish(): void {
    this.#items.clear();
  }

  /**
   * 人确认：把提案作为对 targetSkillId 的修改写入。写之前必须过 validateSkillEdit——
   * 这是与界面手工编辑完全相同的分权校验，Agent 绕不过去。目标技能必须已提炼。
   */
  async apply(proposalId: string, targetSkillId: string): Promise<void> {
    const proposal = this.#items.get(proposalId);
    if (!proposal) throw new Error('提案不存在或已处理');
    if (!(await this.#deps.library.hasSkill(targetSkillId)))
      throw new Error('目标技能尚未提炼，提案只能修改已存在的技能');
    const { skill } = await this.#deps.library.readSkill(targetSkillId);
    const verdict = validateSkillEdit(skill.steps, proposal.steps);
    if (!verdict.ok)
      throw new Error(
        verdict.reason === 'NEW_ACTION'
          ? `提案第 ${verdict.step} 步是新增动作，没有录制依据，不能写入`
          : `提案第 ${verdict.step} 步重复了现有动作，不能写入`,
      );
    // 保留目标技能自己的 meta（名字、id、录制时间），只换散文与步骤。
    await this.#deps.library.writeSkill(targetSkillId, proposal.prose, {
      ...skill,
      steps: proposal.steps,
    });
    this.#items.delete(proposalId);
    this.#deps.recordEvent(targetSkillId, 'skill.proposal-applied', {
      proposalFrom: proposal.messageId,
      steps: proposal.steps.length,
    });
    this.#deps.log(`技能提案已写入：${skill.meta.name}`);
    await this.#deps.refreshSkills();
    this.#deps.emit();
  }
}

export { readable as proposalReadable };
