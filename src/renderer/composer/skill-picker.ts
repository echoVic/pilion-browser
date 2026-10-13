import type { RecordingSummary } from '../../shared/contracts.js';

export interface SkillOption {
  id: string;
  name: string;
  about?: string;
}

/**
 * 「/」唤起的技能选择器：只列已提炼（有 skill.md）的技能，按查询匹配名字或 about。
 * 查询为空时全部列出（按最近使用排序已在主进程给定的顺序里）。纯函数，便于单测过滤逻辑。
 */
export function filterSkills(
  skills: readonly RecordingSummary[],
  query: string,
): SkillOption[] {
  const q = query.trim().toLowerCase();
  const distilled = skills.filter((skill) => skill.distilled && !skill.error);
  if (!q) return distilled.map(({ id, name, about }) => ({ id, name, about }));
  return distilled
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) || (skill.about ?? '').toLowerCase().includes(q),
    )
    .map(({ id, name, about }) => ({ id, name, about }));
}

/**
 * 选中后插进输入框的提示：让 Agent 用 browser.skills.play 跑这份技能。
 * 工具入参是 skillId；名字一并给上，方便 Agent 向人复述。
 */
export function skillInsertText(option: SkillOption): string {
  return `请使用 browser.skills.play 运行技能 ${option.id}（「${option.name}」），按它的步骤操作；遇到需要我介入的地方就停下来。`;
}
