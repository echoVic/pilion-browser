import { describe, expect, it } from 'vitest';
import {
  RecordingFormatError,
  describeStep,
  parseTrajectory,
  serializeTrajectory,
  type Trajectory,
} from '../src/main/recording/index';

const sample: Trajectory = {
  meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: '2026-09-20T14:03:11+08:00' },
  entries: [
    {
      kind: 'page',
      at: '2026-09-20T14:03:12+08:00',
      url: 'https://report.example.com/login',
      title: '登录',
      text: '请输入邮箱和密码',
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:20+08:00',
      step: { kind: 'navigate', url: 'https://report.example.com/login' },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:25+08:00',
      step: {
        kind: 'type',
        onUrl: 'https://report.example.com/login',
        target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
        text: 'me@x.com',
        replace: true,
      },
    },
    {
      kind: 'step',
      at: '2026-09-20T14:03:31+08:00',
      step: { kind: 'human', onUrl: 'https://report.example.com/login', reason: '填写密码' },
    },
  ],
};

describe('trajectory format', () => {
  it('serialize 后再 parse 得到同一个值', () => {
    expect(parseTrajectory(serializeTrajectory(sample))).toEqual(sample);
  });

  it('序列化结果里有人读得懂的时间线和一个 fenced block', () => {
    const md = serializeTrajectory(sample);
    expect(md).toContain('```json pilion-trajectory');
    expect(md).toContain('输入 "邮箱"');
    expect(md).toContain('需要我：填写密码');
  });

  it('没有 fenced block 时报错并指出行号', () => {
    expect(() => parseTrajectory('# 月度导出\n\n什么都没有\n')).toThrow(RecordingFormatError);
    try {
      parseTrajectory('# 月度导出\n\n什么都没有\n');
    } catch (error) {
      expect((error as RecordingFormatError).line).toBe(1);
      expect((error as RecordingFormatError).message).toContain('pilion-trajectory');
    }
  });

  it('json 语法错误时报出 block 内的行号', () => {
    const md = ['# x', '', '```json pilion-trajectory', '{', '  "meta": {,', '}', '```', ''].join(
      '\n',
    );
    try {
      parseTrajectory(md);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingFormatError);
      expect((error as RecordingFormatError).line).toBeGreaterThanOrEqual(4);
    }
  });

  it('未知步骤类型被拒绝', () => {
    const md = serializeTrajectory(sample).replace('"navigate"', '"evaluate"');
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('type 步骤的 replace 必须是 true', () => {
    const md = serializeTrajectory(sample).replace('"replace": true', '"replace": false');
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('navigate 之外的步骤缺 onUrl 被拒绝', () => {
    const md = serializeTrajectory(sample).replace(
      '"onUrl": "https://report.example.com/login",\n        "reason"',
      '"reason"',
    );
    expect(() => parseTrajectory(md)).toThrow(RecordingFormatError);
  });

  it('describeStep 把每种步骤渲染成一行中文', () => {
    expect(describeStep({ kind: 'navigate', url: 'https://a.com/' })).toBe('打开 https://a.com/');
    expect(
      describeStep({
        kind: 'click',
        onUrl: 'https://a.com/',
        target: { role: 'button', name: '导出 CSV', tagName: 'button', nth: 2 },
      }),
    ).toBe('点击 "导出 CSV"（button，第 2 个）');
    expect(
      describeStep({
        kind: 'select',
        onUrl: 'https://a.com/',
        target: { role: 'combobox', name: '月份', tagName: 'select' },
        value: '2026-09',
      }),
    ).toBe('选择 "月份" = "2026-09"');
    expect(describeStep({ kind: 'note', text: '这里要选上个月' })).toBe('备注：这里要选上个月');
  });
});
