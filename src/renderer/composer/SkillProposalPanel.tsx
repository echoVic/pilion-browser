import { useState } from 'react';
import { ChevronRight, GitBranchPlus } from 'lucide-react';
import type { RecordingSummary, SkillProposalView } from '../../shared/contracts.js';
import { failureText } from '../ui.js';

type Props = {
  proposals: readonly SkillProposalView[];
  /** 只显示这条对话里 Agent 提出的修改；没有对话（预览）时不显示。 */
  conversationId: string | undefined;
  skills: readonly RecordingSummary[];
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * Agent 在普通聊天里提出的技能修改。只有人选定一份已提炼技能并点「采用」，主进程才写入；
 * 写之前主进程还会过编辑分权校验（不能新增动作），所以这里只是预览与选择。
 */
export function SkillProposalPanel({ proposals, conversationId, skills, run }: Props) {
  const targets = skills.filter((skill) => skill.distilled && !skill.error);
  const [targetsMap, setTargetsMap] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const shown = proposals.filter((proposal) => proposal.conversationId === conversationId);
  if (!conversationId || shown.length === 0) return null;
  return (
    <div className="skill-proposals">
      {shown.map((proposal) => {
        const target = targetsMap[proposal.proposalId] ?? '';
        const error = errors[proposal.proposalId];
        return (
          <div className="skill-proposal" key={proposal.proposalId}>
            <GitBranchPlus size={15} className="proposal-icon" />
            <div className="skill-proposal-body">
              <strong>Agent 提出技能修改：{proposal.name}</strong>
              <p>{proposal.stepCount} 个步骤。写入前仍须通过编辑分权校验（不能新增动作）。</p>
              {proposal.preview && (
                <details className="appr-details">
                  <summary>
                    查看修改内容
                    <ChevronRight size={12} className="chev-sm" />
                  </summary>
                  <pre tabIndex={0}>{proposal.preview}</pre>
                </details>
              )}
              <div className="skill-proposal-actions">
                <select
                  aria-label="目标技能"
                  value={target}
                  onChange={(event) =>
                    setTargetsMap((current) => ({
                      ...current,
                      [proposal.proposalId]: event.target.value,
                    }))
                  }
                >
                  <option value="">应用到哪份已提炼技能…</option>
                  {targets.map((skill) => (
                    <option value={skill.id} key={skill.id}>
                      {skill.name}
                    </option>
                  ))}
                </select>
                <div className="skill-proposal-buttons">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!target}
                    onClick={() =>
                      void run(async () => {
                        try {
                          await window.pilion.skills.proposalApply(proposal.proposalId, target);
                          setErrors((current) => {
                            const next = { ...current };
                            delete next[proposal.proposalId];
                            return next;
                          });
                        } catch (e) {
                          setErrors((current) => ({
                            ...current,
                            [proposal.proposalId]: failureText(e),
                          }));
                        }
                      })
                    }
                  >
                    采用为修改
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      void run(() => window.pilion.skills.proposalDiscard(proposal.proposalId))
                    }
                  >
                    丢弃
                  </button>
                </div>
              </div>
              {error && (
                <p className="skill-proposal-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
