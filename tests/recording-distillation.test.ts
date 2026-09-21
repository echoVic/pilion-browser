import { describe, expect, it } from 'vitest';
import { DistillationState, unsupportedSteps } from '../src/main/recording/index';
import type { Skill, Step, Trajectory } from '../src/main/recording/index';

const LOGIN = 'https://report.example.com/login';
const DASH = 'https://report.example.com/dashboard';
const email: Step = {
  kind: 'type',
  onUrl: LOGIN,
  target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
  text: 'me@x.com',
  replace: true,
};
const login: Step = {
  kind: 'click',
  onUrl: LOGIN,
  target: { role: 'button', name: '登录', tagName: 'button' },
};
const month: Step = {
  kind: 'select',
  onUrl: DASH,
  target: { role: 'combobox', name: '月份', tagName: 'select' },
  value: '2026-09',
};
const exportCsv: Step = {
  kind: 'click',
  onUrl: DASH,
  target: { role: 'button', name: '导出 CSV', tagName: 'button' },
};
const invented: Step = {
  kind: 'click',
  onUrl: DASH,
  target: { role: 'button', name: '删除全部', tagName: 'button' },
};
const human: Step = { kind: 'human', onUrl: LOGIN, reason: '填写密码' };

const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    { kind: 'step', at: 't1', step: { kind: 'navigate', url: LOGIN } },
    { kind: 'page', at: 't2', url: LOGIN, title: '登录', text: '请输入邮箱' },
    { kind: 'step', at: 't3', step: email },
    { kind: 'step', at: 't4', step: human },
    { kind: 'step', at: 't5', step: login },
    { kind: 'page', at: 't6', url: DASH, title: '仪表盘', text: '本月数据' },
    { kind: 'step', at: 't7', step: month },
    { kind: 'step', at: 't8', step: exportCsv },
  ],
};

/** Agent 那一回合的回复：散文 + 一个技能块，meta 里只给 about，其余键由主进程补。 */
function reply(steps: Step[], meta: Record<string, unknown> = { about: '导出本月 CSV' }): string {
  return [
    '# 月度导出',
    '',
    '## 什么时候用',
    '每月初要一份 CSV 的时候。',
    '',
    '```json pilion-skill',
    JSON.stringify({ meta, steps }, null, 2),
    '```',
    '',
  ].join('\n');
}

const goodSteps: Step[] = [{ kind: 'navigate', url: LOGIN }, email, human, login, exportCsv];
const goodReply = reply(goodSteps);
const replyWithInventedClick = reply([{ kind: 'navigate', url: LOGIN }, login, invented]);

type Written = { id: string; prose: string; skill: Skill };
function fakeDeps() {
  const written: Written[] = [];
  const recorded: { id: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const logged: string[] = [];
  const counts = { emit: 0, refresh: 0 };
  return {
    written,
    recorded,
    logged,
    counts,
    library: {
      writeSkill: async (id: string, prose: string, skill: Skill) => {
        written.push({ id, prose, skill });
      },
    },
    recordEvent: (id: string, eventType: string, payload: Record<string, unknown>) => {
      recorded.push({ id, eventType, payload });
    },
    emit: () => {
      counts.emit += 1;
    },
    refreshSkills: async () => {
      counts.refresh += 1;
    },
    log: (line: string) => {
      logged.push(line);
    },
  };
}

const base = {
  id: 'monthly',
  name: '月度导出',
  conversationId: 'conv-1',
  trajectory,
  distilledBy: 'claude-code',
};

describe('DistillationState 对账', () => {
  it('Agent 凭空造的步骤会被拒绝，pending 保持空', () => {
    const state = new DistillationState(fakeDeps());
    const result = state.accept({ ...base, reply: replyWithInventedClick });
    expect(result.ok).toBe(false);
    expect(state.pending).toBeUndefined();
    expect(state.rejected?.reason).toContain('第 3 步在轨迹里找不到依据');
    expect(state.rejected?.reason).toContain('没有对应的动作');
    expect(state.rejected?.conversationId).toBe('conv-1');
  });

  it('改写了人输入过的值也被拒绝，理由指到那一步', () => {
    const state = new DistillationState(fakeDeps());
    const result = state.accept({
      ...base,
      reply: reply([{ ...email, text: 'someone@else.com' }]),
    });
    expect(result.ok).toBe(false);
    expect(state.rejected?.reason).toContain('第 1 步');
    expect(state.rejected?.reason).toContain('改写了输入值');
  });

  it('编造轨迹里没去过的地址会被拒绝', () => {
    const state = new DistillationState(fakeDeps());
    state.accept({
      ...base,
      reply: reply([{ kind: 'navigate', url: 'https://evil.example.com' }]),
    });
    expect(state.pending).toBeUndefined();
    expect(state.rejected?.reason).toContain('轨迹里没去过这个地址');
  });

  it('回复里没有技能块、或块里缺 meta，都不产出提案', () => {
    const state = new DistillationState(fakeDeps());
    state.accept({ ...base, reply: '我觉得这份录制没什么好提炼的。' });
    expect(state.rejected?.reason).toContain('没有 ```json pilion-skill 代码块');
    state.accept({ ...base, reply: reply(goodSteps).replace('"meta"', '"信息"') });
    expect(state.rejected?.reason).toContain('缺少 meta');
    expect(state.pending).toBeUndefined();
  });

  it('技能块不合法时拒绝，不抛给调用方', () => {
    const state = new DistillationState(fakeDeps());
    const result = state.accept({
      ...base,
      reply: reply([{ kind: 'navigate', url: LOGIN }], { about: 42 }),
    });
    expect(result.ok).toBe(false);
    expect(state.rejected?.reason).toBeTruthy();
  });

  it('meta 以 Pilion 为准：Agent 改不了名字、出处与提炼者', () => {
    const state = new DistillationState(fakeDeps());
    state.accept({
      ...base,
      reply: reply(goodSteps, {
        about: '导出本月 CSV',
        name: '我自己起的名字',
        distilledBy: '别人',
        recordedAt: '1999-01-01T00:00:00+08:00',
      }),
    });
    expect(state.pending?.skill.meta).toMatchObject({
      name: '月度导出',
      recordedAt: trajectory.meta.recordedAt,
      distilledBy: 'claude-code',
      trajectory: 'trajectory.md',
    });
  });

  it('接受时把需要人做的步骤算出来，不再是恒 false', () => {
    const state = new DistillationState(fakeDeps());
    state.accept({ ...base, reply: goodReply });
    const skill = state.pending!.skill;
    // 与已保留技能详情走同一个助手：对账过关的提案本来就一步都不该标手工。
    expect(state.pending?.manual).toEqual(unsupportedSteps(skill, trajectory));
    expect(state.pending?.manual).toEqual([]);
  });

  it('提案的 markdown 就是保留时会落盘的那份原文', () => {
    const deps = fakeDeps();
    const state = new DistillationState(deps);
    const result = state.accept({ ...base, reply: goodReply });
    expect(result).toMatchObject({ ok: true, manual: [] });
    expect(state.pending?.markdown).toContain('```json pilion-skill');
    expect(state.pending?.skill.steps).toHaveLength(goodSteps.length);
    // 接受只是交给人看，磁盘上此时什么都没有。
    expect(deps.written).toHaveLength(0);
  });
});

describe('DistillationState 保留与丢弃', () => {
  it('保留才落盘，丢弃什么也不写', async () => {
    const deps = fakeDeps();
    const state = new DistillationState(deps);
    state.accept({ ...base, reply: goodReply });
    state.discard();
    expect(deps.written).toHaveLength(0);
    expect(state.pending).toBeUndefined();
    state.accept({ ...base, reply: goodReply });
    await state.keep();
    expect(deps.written).toHaveLength(1);
    expect(deps.written[0]).toMatchObject({ id: 'monthly' });
    expect(deps.written[0].skill.steps).toHaveLength(goodSteps.length);
    expect(state.pending).toBeUndefined();
  });

  it('保留会记台账、刷技能列表；没有提案时保留要报错', async () => {
    const deps = fakeDeps();
    const state = new DistillationState(deps);
    await expect(state.keep()).rejects.toThrow('没有待保留的提炼结果');
    expect(deps.written).toHaveLength(0);
    state.accept({ ...base, reply: goodReply });
    await state.keep();
    expect(deps.recorded).toEqual([
      { id: 'monthly', eventType: 'skill.kept', payload: { distilledBy: 'claude-code' } },
    ]);
    expect(deps.counts.refresh).toBe(1);
  });

  it('丢弃把拒绝理由也一起清掉，并通知界面', () => {
    const deps = fakeDeps();
    const state = new DistillationState(deps);
    state.reject({ ...base, reason: '已取消' });
    expect(state.rejected?.reason).toBe('已取消');
    state.discard();
    expect(state.rejected).toBeUndefined();
    expect(deps.counts.emit).toBe(1);
  });
});

describe('DistillationState 名额', () => {
  it('同一份录制正在提炼或有待决预览时，改名与删除要被挡住', () => {
    const state = new DistillationState(fakeDeps());
    state.begin('monthly', '月度导出', 'conv-1');
    expect(state.busyReasonFor('monthly')).toBeTruthy();
    expect(state.busyReasonFor('another')).toBeUndefined();
  });

  it('占住名额的那一刻起就挡住，提案还在手上时也挡住', () => {
    const state = new DistillationState(fakeDeps());
    state.claim('monthly');
    expect(state.busyReasonFor('monthly')).toBeTruthy();
    expect(state.active).toBe(true);
    state.release();
    expect(state.busyReasonFor('monthly')).toBeUndefined();
    state.accept({ ...base, reply: goodReply });
    expect(state.busyReasonFor('monthly')).toBeTruthy();
    expect(state.busyReasonFor('another')).toBeUndefined();
  });

  it('名额只有一个：第一个 await 之前就占住，重复进入要报错', () => {
    const state = new DistillationState(fakeDeps());
    state.claim('monthly');
    expect(() => state.claim('another')).toThrow('已有提炼在进行');
    state.begin('monthly', '月度导出', 'conv-1');
    expect(() => state.claim('another')).toThrow('已有提炼在进行');
    expect(state.running).toEqual({ id: 'monthly', name: '月度导出', conversationId: 'conv-1' });
    state.release();
    expect(state.running).toBeUndefined();
    expect(() => state.claim('another')).not.toThrow();
  });

  it('重炼开头就把上一轮的提案与拒绝理由清掉', () => {
    const state = new DistillationState(fakeDeps());
    state.accept({ ...base, reply: goodReply });
    state.reject({ ...base, reason: '上一轮失败了' });
    state.begin('monthly', '月度导出', 'conv-2');
    expect(state.pending).toBeUndefined();
    expect(state.rejected).toBeUndefined();
  });

  it('退出时一次清干净：名额、进行中、提案、拒绝理由', () => {
    const deps = fakeDeps();
    const state = new DistillationState(deps);
    state.claim('monthly');
    state.begin('monthly', '月度导出', 'conv-1');
    state.accept({ ...base, reply: goodReply });
    state.finish();
    expect(state.active).toBe(false);
    expect(state.running).toBeUndefined();
    expect(state.pending).toBeUndefined();
    expect(state.rejected).toBeUndefined();
    expect(state.busyReasonFor('monthly')).toBeUndefined();
    expect(deps.written).toHaveLength(0);
  });
});
