import { describe, expect, it } from 'vitest';
import {
  RecordingFormatError,
  isPlaceholder,
  parseSkill,
  serializeSkill,
  type Skill,
} from '../src/main/recording/index';

const skill: Skill = {
  meta: {
    app: 'pilion',
    version: 1,
    kind: 'skill',
    name: '月度导出',
    about: '登录后选月份并导出 CSV',
    recordedAt: '2026-09-20T14:03:11+08:00',
    distilledBy: 'claude-code',
    trajectory: 'trajectory.md',
  },
  steps: [
    { kind: 'navigate', url: 'https://report.example.com/login' },
    {
      kind: 'type',
      onUrl: 'https://report.example.com/login',
      target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
      text: '{{邮箱}}',
      replace: true,
    },
    { kind: 'human', onUrl: 'https://report.example.com/login', reason: '填写密码' },
    {
      kind: 'click',
      onUrl: 'https://report.example.com/login',
      target: { role: 'button', name: '登录', tagName: 'button' },
    },
  ],
};
const prose = [
  '# 月度导出',
  '',
  '## 什么时候用',
  '',
  '每月初要给财务那份 CSV 时。',
  '',
  '## 前置条件',
  '',
  '- 已登录',
  '',
  '## 已知坑',
  '',
  '- 无',
].join('\n');

describe('skill format', () => {
  it('serialize 后再 parse 得到同一份技能，散文原样保留', () => {
    const md = serializeSkill(prose, skill);
    expect(md).toContain('```json pilion-skill');
    const parsed = parseSkill(md);
    expect(parsed.skill).toEqual(skill);
    expect(parsed.prose).toBe(prose);
  });

  it('散文为空时用名字生成一行标题', () => {
    expect(parseSkill(serializeSkill('', skill)).prose).toBe('# 月度导出');
  });

  it('没有 pilion-skill 块时报错并指出行号', () => {
    try {
      parseSkill('# 月度导出\n\n什么都没有\n');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingFormatError);
      expect((error as RecordingFormatError).line).toBe(1);
      expect((error as RecordingFormatError).message).toContain('pilion-skill');
    }
  });

  it('meta.kind 不是 skill 时被拒绝', () => {
    const md = serializeSkill(prose, skill).replace('"kind": "skill"', '"kind": "trajectory"');
    expect(() => parseSkill(md)).toThrow(RecordingFormatError);
  });

  it('about 超过 200 字被拒绝', () => {
    const md = serializeSkill(prose, { ...skill, meta: { ...skill.meta, about: 'x'.repeat(201) } });
    expect(() => parseSkill(md)).toThrow(RecordingFormatError);
  });

  it('轨迹文件不会被当成技能读取', () => {
    const md = serializeSkill(prose, skill).replace(
      '```json pilion-skill',
      '```json pilion-trajectory',
    );
    expect(() => parseSkill(md)).toThrow(/pilion-skill/);
  });
});

describe('isPlaceholder', () => {
  it('只认 {{…}} 且内容不含花括号、不超过 60 字', () => {
    expect(isPlaceholder('{{邮箱}}')).toBe(true);
    expect(isPlaceholder('{{ 公司邮箱地址 }}')).toBe(true);
    expect(isPlaceholder('me@x.com')).toBe(false);
    expect(isPlaceholder('{{}}')).toBe(false);
    expect(isPlaceholder('{{a{b}}')).toBe(false);
    expect(isPlaceholder(`{{${'x'.repeat(61)}}}`)).toBe(false);
    expect(isPlaceholder('前缀{{邮箱}}')).toBe(false);
  });
});
