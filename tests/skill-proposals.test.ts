import { describe, expect, it, vi } from 'vitest';
import type { Skill, Step } from '../src/main/recording/types.js';
import { SkillProposalState } from '../src/main/recording/proposals.js';

const navigate = (url: string): Step => ({ kind: 'navigate', url });

function skillBlock(steps: Step[], name = '示例技能'): string {
  const skill: Skill = {
    meta: {
      app: 'pilion',
      version: 1,
      kind: 'skill',
      name,
      about: '',
      recordedAt: '2026-01-01',
      distilledBy: 'agent-fixture',
      trajectory: 'trajectory.md',
    },
    steps,
  };
  return `散文说明。\n\n\`\`\`json pilion-skill\n${JSON.stringify(skill)}\n\`\`\`\n`;
}

function depsOf(existing: Map<string, { prose: string; skill: Skill }>) {
  const writes: Array<{ id: string; steps: Step[] }> = [];
  const deps = {
    library: {
      hasSkill: async (id: string) => existing.has(id),
      readSkill: async (id: string) => {
        const entry = existing.get(id)!;
        return { prose: entry.prose, skill: entry.skill, markdown: '' };
      },
      writeSkill: async (id: string, prose: string, skill: Skill) => {
        writes.push({ id, steps: skill.steps });
        existing.set(id, { prose, skill });
      },
    },
    recordEvent: vi.fn(),
    emit: vi.fn(),
    refreshSkills: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  return { deps, writes };
}

describe('Agent 技能提案', () => {
  it('普通回复没有技能块时不收作提案', () => {
    const { deps } = depsOf(new Map());
    const state = new SkillProposalState(deps);
    expect(
      state.capture({ conversationId: 'c1', messageId: 'm1', reply: '就是一段普通聊天' }),
    ).toBeUndefined();
    expect(state.list()).toEqual([]);
  });

  it('不确认就不落盘：capture 只进内存，writeSkill 一次都不调用', async () => {
    const { deps, writes } = depsOf(new Map());
    const state = new SkillProposalState(deps);
    const proposal = state.capture({
      conversationId: 'c1',
      messageId: 'm1',
      reply: skillBlock([navigate('https://a'), navigate('https://b')]),
    });
    expect(proposal?.steps.length).toBe(2);
    expect(writes).toEqual([]);
  });

  it('采用时必须指向已存在技能；目标没提炼直接拒绝', async () => {
    const { deps } = depsOf(new Map());
    const state = new SkillProposalState(deps);
    const proposal = state.capture({
      conversationId: 'c1',
      messageId: 'm1',
      reply: skillBlock([navigate('https://a')]),
    })!;
    await expect(state.apply(proposal.proposalId, 'missing')).rejects.toThrow('尚未提炼');
  });

  it('提案新增了录制里没有的动作时被编辑分权拦下，不写入', async () => {
    const existing = new Map<string, { prose: string; skill: Skill }>();
    existing.set('s1', {
      prose: '旧散文',
      skill: {
        meta: {
          app: 'pilion', version: 1, kind: 'skill', name: '旧', about: '',
          recordedAt: 'x', distilledBy: 'p', trajectory: 'trajectory.md',
        },
        steps: [navigate('https://a')],
      },
    });
    const { deps, writes } = depsOf(existing);
    const state = new SkillProposalState(deps);
    // 提案里多了一条录制时没发生过的导航。
    const proposal = state.capture({
      conversationId: 'c1',
      messageId: 'm1',
      reply: skillBlock([navigate('https://a'), navigate('https://https://evil.test'.replace('https://https://', 'https://'))]),
    })!;
    await expect(state.apply(proposal.proposalId, 's1')).rejects.toThrow('新增动作');
    expect(writes).toEqual([]);
  });

  it('提案只是在已录步骤范围内重排/删改时，确认后写入并留审计', async () => {
    const existing = new Map<string, { prose: string; skill: Skill }>();
    existing.set('s1', {
      prose: '旧散文',
      skill: {
        meta: {
          app: 'pilion', version: 1, kind: 'skill', name: '旧', about: '',
          recordedAt: 'x', distilledBy: 'p', trajectory: 'trajectory.md',
        },
        steps: [navigate('https://a'), navigate('https://b')],
      },
    });
    const { deps, writes } = depsOf(existing);
    const state = new SkillProposalState(deps);
    // 只保留、并删掉一条录制过的导航：不新增动作，应当放行。
    const proposal = state.capture({
      conversationId: 'c1',
      messageId: 'm1',
      reply: skillBlock([navigate('https://b')], '改名后的技能'),
    })!;
    await state.apply(proposal.proposalId, 's1');
    expect(writes).toEqual([{ id: 's1', steps: [navigate('https://b')] }]);
    expect(deps.recordEvent).toHaveBeenCalledWith(
      's1',
      'skill.proposal-applied',
      expect.objectContaining({ proposalFrom: 'm1' }),
    );
  });
});
