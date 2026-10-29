import { useState } from 'react';
import { GitBranchPlus } from 'lucide-react';
import type { RecordingSummary, SkillProposalView } from '../../shared/contracts.js';

type Props = {
  proposals: readonly SkillProposalView[];
  skills: readonly RecordingSummary[];
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * Agent 在普通聊天里提出的技能修改。只有人选定一份已提炼技能并点「采用」，主进程才写入；
 * 写之前主进程还会过编辑分权校验（不能新增动作），所以这里只是预览与选择。
 */
export function SkillProposalPanel({ proposals, skills, run }: Props) {
  const targets = skills.filter((skill) => skill.distilled && !skill.error);
  const [targetsMap, setTargetsMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  if (proposals.length === 0) return null;
  return (
    <div className="skill-proposals">
      {proposals.map((proposal) => {
        const target = targetsMap[proposal.proposalId] ?? '';
        return (
          <div className="skill-proposal" key={proposal.proposalId}>
            <GitBranchPlus size={15} className="proposal-icon" />
            <div className="skill-proposal-body">
              <strong>Agent 提出技能修改：{proposal.name}</strong>
              <p>{proposal.stepCount} 个步骤。写入前仍须通过编辑分权校验（不能新增动作）。</p>
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
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!target}
                  onClick={() =>
                    void run(async () => {
                      try {
                        await window.pilion.skills.proposalApply(proposal.proposalId, target);
                        setError(undefined);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
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
