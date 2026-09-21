import { describe, expect, it } from 'vitest';
import {
  buildDistillPrompt,
  extractSkillMarkdown,
  reconcile,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
  type Skill,
  type Step,
  type Trajectory,
} from '../src/main/recording/index';

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
const trajectory: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    { kind: 'step', at: 't1', step: { kind: 'navigate', url: LOGIN } },
    { kind: 'page', at: 't2', url: LOGIN, title: '登录', text: '请输入邮箱' },
    { kind: 'step', at: 't3', step: email },
    { kind: 'step', at: 't4', step: { kind: 'human', onUrl: LOGIN, reason: '填写密码' } },
    { kind: 'step', at: 't5', step: login },
    { kind: 'page', at: 't6', url: DASH, title: '仪表盘', text: '本月数据' },
    { kind: 'step', at: 't7', step: month },
    { kind: 'step', at: 't8', step: exportCsv },
    { kind: 'step', at: 't9', step: { kind: 'note', onUrl: DASH, text: '上面那个按钮' } },
  ],
};
function skillWith(steps: Step[]): Skill {
  return {
    meta: {
      app: 'pilion',
      version: 1,
      kind: 'skill',
      name: '月度导出',
      about: '导出 CSV',
      recordedAt: '2026-09-20T14:03:11+08:00',
      distilledBy: 'claude-code',
      trajectory: 'trajectory.md',
    },
    steps,
  };
}

describe('reconcile', () => {
  it('从轨迹里挑选、合并、重排并插入 human/note 都通过', () => {
    const skill = skillWith([
      { kind: 'navigate', url: LOGIN },
      email,
      { kind: 'human', onUrl: LOGIN, reason: '填写密码' },
      login,
      { kind: 'note', text: '等表格出现' },
      exportCsv,
      month,
    ]);
    expect(reconcile(skill, trajectory)).toEqual({ ok: true });
  });

  it('凭空造的动作被拒：NO_EVIDENCE 指到那一步', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    expect(reconcile(skillWith([{ kind: 'navigate', url: LOGIN }, invented]), trajectory)).toEqual({
      ok: false,
      step: 2,
      reason: 'NO_EVIDENCE',
    });
  });

  it('一条轨迹步骤不能被复用成两步（消耗式匹配）', () => {
    expect(reconcile(skillWith([login, login]), trajectory)).toEqual({
      ok: false,
      step: 2,
      reason: 'NO_EVIDENCE',
    });
  });

  it('改写人输入过的值被拒：VALUE_CHANGED', () => {
    expect(reconcile(skillWith([{ ...email, text: 'boss@x.com' }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
    expect(reconcile(skillWith([{ ...month, value: '2026-10' }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
  });

  it('值换成占位符可以通过', () => {
    expect(reconcile(skillWith([{ ...email, text: '{{邮箱}}' }]), trajectory)).toEqual({
      ok: true,
    });
    expect(reconcile(skillWith([{ ...month, value: '{{月份}}' }]), trajectory)).toEqual({
      ok: true,
    });
  });

  it('navigate 的 URL 必须在轨迹里出现过：navigate 步或 page 条目都算', () => {
    expect(reconcile(skillWith([{ kind: 'navigate', url: DASH }]), trajectory)).toEqual({
      ok: true,
    });
    expect(
      reconcile(skillWith([{ kind: 'navigate', url: 'https://evil.example.com/' }]), trajectory),
    ).toEqual({ ok: false, step: 1, reason: 'URL_UNKNOWN' });
  });

  it('目标名只差空白与大小写时算同一目标', () => {
    const spaced: Step = { ...login, target: { ...login.target, name: ' 登录 ' } };
    expect(reconcile(skillWith([spaced]), trajectory)).toEqual({ ok: true });
  });

  it('同名不同角色不算同一目标', () => {
    const asLink: Step = { ...login, target: { ...login.target, role: 'link', tagName: 'a' } };
    expect(reconcile(skillWith([asLink]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'NO_EVIDENCE',
    });
  });
});

describe('unsupportedSteps', () => {
  it('非阻塞地列出所有没有依据的步骤序号', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    const skill = skillWith([
      login,
      invented,
      { kind: 'navigate', url: 'https://evil.example.com/' },
      exportCsv,
    ]);
    expect(unsupportedSteps(skill, trajectory)).toEqual([2, 3]);
  });
});

describe('validateSkillEdit', () => {
  const existing: Step[] = [{ kind: 'navigate', url: LOGIN }, email, login, month, exportCsv];

  it('删步、重排、改值、插入 human 都通过', () => {
    const submitted: Step[] = [
      { kind: 'navigate', url: LOGIN },
      { ...email, text: '{{邮箱}}' },
      { kind: 'human', onUrl: LOGIN, reason: '填写密码' },
      exportCsv,
      { ...month, value: '2026-10' },
    ];
    expect(validateSkillEdit(existing, submitted)).toEqual({ ok: true });
  });

  it('新增动作步骤被拒', () => {
    const invented: Step = {
      kind: 'click',
      onUrl: DASH,
      target: { role: 'button', name: '删除全部', tagName: 'button' },
    };
    expect(validateSkillEdit(existing, [...existing, invented])).toEqual({
      ok: false,
      step: 6,
      reason: 'NEW_ACTION',
    });
  });

  it('把一个动作步骤复制成两份被拒', () => {
    expect(validateSkillEdit(existing, [...existing, exportCsv])).toEqual({
      ok: false,
      step: 6,
      reason: 'TOO_MANY',
    });
  });

  it('新增 navigate 到别的 URL 被拒', () => {
    expect(
      validateSkillEdit(existing, [{ kind: 'navigate', url: 'https://evil.example.com/' }]),
    ).toEqual({ ok: false, step: 1, reason: 'NEW_ACTION' });
  });
});

describe('extractSkillMarkdown', () => {
  const doc = [
    '# 月度导出',
    '',
    '## 什么时候用',
    '',
    '月初。',
    '',
    '```json pilion-skill',
    '{"a":1}',
    '```',
  ].join('\n');

  it('去掉块前的闲聊和块后的尾巴，保留从标题到闭合栏', () => {
    expect(extractSkillMarkdown(`好的，这是提炼结果：\n\n${doc}\n\n还有什么需要吗？`)).toBe(doc);
  });

  it('没有块时返回 undefined', () => {
    expect(extractSkillMarkdown('# 月度导出\n\n没有块')).toBeUndefined();
  });

  it('有多个块时取第一个', () => {
    expect(extractSkillMarkdown(`${doc}\n\n\`\`\`json pilion-skill\n{"b":2}\n\`\`\``)).toBe(doc);
  });

  it('没有标题时从块开始', () => {
    expect(extractSkillMarkdown('前言\n```json pilion-skill\n{}\n```')).toBe(
      '```json pilion-skill\n{}\n```',
    );
  });
});

describe('buildDistillPrompt / stepsHash', () => {
  it('prompt 含轨迹原文与四条规则的关键词', () => {
    const prompt = buildDistillPrompt(
      '月度导出',
      '# 月度导出\n\n```json pilion-trajectory\n{}\n```',
    );
    expect(prompt).toContain('pilion-trajectory');
    expect(prompt).toContain('pilion-skill');
    expect(prompt).toContain('不得新增');
    expect(prompt).toContain('{{');
    expect(prompt).toContain('不要调用任何工具');
  });

  it('stepsHash 对内容敏感、对顺序敏感', () => {
    expect(stepsHash([login, month])).toBe(stepsHash([login, month]));
    expect(stepsHash([login, month])).not.toBe(stepsHash([month, login]));
    expect(stepsHash([login])).toMatch(/^[a-f0-9]{64}$/);
  });
});
