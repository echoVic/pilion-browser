import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import { TrajectoryRecorder, type RawEvent } from '../src/main/recording/index';

const URL = 'https://report.example.com/login';
let t = 1_000;
const tick = (ms = 10) => (t += ms);
function recorder() {
  let n = 0;
  return new TrajectoryRecorder({
    name: 'x',
    now: () => new Date(Date.UTC(2026, 8, 20, 6, 3, (n += 1))),
  });
}
const button = { tagName: 'button', role: 'button', name: '登录' };
const email = { tagName: 'input', role: 'textbox', name: '邮箱', inputType: 'email' };
const click = (index: number, el = button, at = tick()): RawEvent => ({
  kind: 'click',
  url: URL,
  index,
  el,
  at,
});
const pointer = (index: number, el = button, at = tick()): RawEvent => ({
  kind: 'pointer',
  url: URL,
  index,
  el,
  at,
});
const input = (index: number, value: string, el = email): RawEvent => ({
  kind: 'input',
  url: URL,
  index,
  el,
  value,
  at: tick(),
});
function steps(r: TrajectoryRecorder) {
  return r.finish().entries.filter((e) => e.kind === 'step');
}
function observed(
  rows: { role: string; name: string; tagName: string; inputType?: string; fingerprint?: string }[],
): Observation {
  return {
    observationId: 'o',
    tabId: 'tab',
    documentEpoch: 1,
    elements: rows.map((row, i) => {
      const ref: ElementRef = {
        id: `r${i}`,
        tabId: 'tab',
        frameId: 'main',
        documentEpoch: 1,
        frameEpoch: 0,
        localFingerprint: row.fingerprint ?? 'e'.repeat(64),
      };
      return {
        ref,
        role: row.role,
        name: row.name,
        disabled: false,
        tagName: row.tagName,
        inputType: row.inputType,
      };
    }),
  };
}

describe('TrajectoryRecorder', () => {
  it('page 产出页面条目，navigate 与 note 直接成步骤', () => {
    const r = recorder();
    r.navigate(URL);
    r.page({ url: URL, title: '登录', text: '请输入' });
    r.note('这里要用公司邮箱');
    const entries = r.finish().entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page', 'step']);
    expect(entries[0]).toMatchObject({ step: { kind: 'navigate', url: URL } });
    expect(entries[1]).toMatchObject({ kind: 'page', url: URL, title: '登录', text: '请输入' });
    expect(entries[2]).toMatchObject({
      step: { kind: 'note', text: '这里要用公司邮箱', onUrl: URL },
    });
  });

  it('同一输入框的连续 input 合并成一条 type，只留最终值，且 replace 为 true', () => {
    const r = recorder();
    r.page({ url: URL, title: '', text: '' });
    r.raw(input(0, 'm'));
    r.raw(input(0, 'me'));
    r.raw(input(0, 'me@x.com'));
    const result = steps(r);
    expect(result).toHaveLength(1);
    expect(result[0].step).toEqual({
      kind: 'type',
      onUrl: URL,
      target: { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' },
      text: 'me@x.com',
      replace: true,
    });
  });

  it('换到别的元素时先提交挂起的输入，顺序保持', () => {
    const r = recorder();
    r.raw(input(0, 'me@x.com'));
    r.raw(click(1));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['type', 'click']);
  });

  it('pointer 紧跟 click 只产出一条 click', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.raw(click(1));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['click']);
  });

  it('pointer 后页面直接跳走也算一次 click', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.page({ url: 'https://report.example.com/dashboard', title: '仪表盘', text: '' });
    const entries = r.finish().entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page']);
    expect(entries[0]).toMatchObject({
      step: { kind: 'click', onUrl: URL, target: { name: '登录' } },
    });
  });

  it('孤立的 pointer 被丢弃', () => {
    const r = recorder();
    r.raw(pointer(1));
    r.raw(input(0, 'a'));
    expect(steps(r).map((e) => e.step.kind)).toEqual(['type']);
  });

  it('400ms 内的双击折叠成一次', () => {
    const r = recorder();
    r.raw(click(1, button, 5_000));
    r.raw(click(1, button, 5_200));
    r.raw(click(1, button, 9_000));
    expect(steps(r)).toHaveLength(2);
  });

  it('secret 产出「需要我」步骤，连续的只留一条，且从不带值', () => {
    const r = recorder();
    const password = { tagName: 'input', role: 'textbox', name: '密码', inputType: 'password' };
    r.raw({ kind: 'secret', url: URL, index: 2, el: password, otp: false, at: tick() });
    r.raw({ kind: 'secret', url: URL, index: 2, el: password, otp: false, at: tick() });
    r.raw({
      kind: 'secret',
      url: URL,
      index: 3,
      el: { ...password, name: '验证码', inputType: 'text' },
      otp: true,
      at: tick(),
    });
    const result = steps(r);
    expect(result.map((e) => e.step)).toEqual([
      { kind: 'human', onUrl: URL, reason: '填写密码' },
      { kind: 'human', onUrl: URL, reason: '填写验证码' },
    ]);
  });

  it('Enter 先提交挂起输入再产出 press', () => {
    const r = recorder();
    r.raw(input(0, 'hello'));
    r.raw({ kind: 'key', url: URL, index: 0, el: email, key: 'Enter', shift: false, at: tick() });
    const result = steps(r);
    expect(result.map((e) => e.step.kind)).toEqual(['type', 'press']);
    expect(result[1].step).toMatchObject({ key: 'Enter', modifiers: [] });
  });

  it('Shift 作为唯一支持的修饰键写入 modifiers', () => {
    const r = recorder();
    r.raw({ kind: 'key', url: URL, index: 1, el: button, key: 'Tab', shift: true, at: tick() });
    expect(steps(r)[0].step).toMatchObject({ kind: 'press', key: 'Tab', modifiers: ['Shift'] });
  });

  it('unsupported 变成带原因的「需要我」步骤', () => {
    const r = recorder();
    r.raw({
      kind: 'unsupported',
      url: URL,
      reason: 'gesture',
      el: { tagName: 'button', role: 'button', name: '滑块' },
      at: tick(),
    });
    r.raw({ kind: 'unsupported', url: URL, reason: 'iframe', at: tick() });
    const result = steps(r);
    expect(result[0]).toMatchObject({
      unsupported: 'gesture',
      step: { kind: 'human', reason: expect.stringContaining('滑块') },
    });
    expect(result[1]).toMatchObject({ unsupported: 'iframe', step: { kind: 'human' } });
    expect(r.counts).toEqual({ steps: 2, unsupported: 2 });
  });

  it('对上预取的 observe 时用它那一行取词，并带上指纹与 nth', () => {
    const r = recorder();
    const obs = observed([
      { role: 'button', name: '查看', tagName: 'button' },
      { role: 'button', name: '查看', tagName: 'button', fingerprint: 'abcd1234' + '0'.repeat(56) },
    ]);
    r.raw(click(1, { tagName: 'button', role: 'button', name: '看' }), obs);
    const [entry] = steps(r);
    expect(entry.step).toMatchObject({
      kind: 'click',
      target: { role: 'button', name: '查看', tagName: 'button', nth: 2, fingerprint: 'abcd1234' },
    });
    expect(entry.ambiguous).toBe(true);
  });

  it('observe 行的 tagName 对不上时退回脚本描述', () => {
    const r = recorder();
    const obs = observed([{ role: 'link', name: '首页', tagName: 'a' }]);
    r.raw(click(0, button), obs);
    expect(steps(r)[0].step).toMatchObject({
      target: { role: 'button', name: '登录', tagName: 'button' },
    });
  });

  it('脚本描述里的 duplicates/position 变成 nth', () => {
    const r = recorder();
    r.raw({
      kind: 'click',
      url: URL,
      index: 3,
      el: {
        tagName: 'button',
        role: 'button',
        name: '查看',
        duplicates: 4,
        position: 3,
      },
      at: tick(),
    } as RawEvent);
    expect(steps(r)[0].step).toMatchObject({ target: { name: '查看', nth: 3 } });
    expect(steps(r)[0].step).not.toHaveProperty('target.duplicates');
  });

  it('序号超出 observe 上限标 beyond-observe-limit', () => {
    const r = recorder();
    r.raw(click(250));
    expect(steps(r)[0]).toMatchObject({ unsupported: 'beyond-observe-limit' });
    expect(r.counts.unsupported).toBe(1);
  });

  it('finish 产出的轨迹通过 schema，meta 带名字与时间', () => {
    const r = recorder();
    r.raw(click(1));
    const trajectory = r.finish();
    expect(trajectory.meta).toEqual({
      app: 'pilion',
      version: 1,
      name: 'x',
      recordedAt: expect.stringMatching(/^2026-09-20T/),
    });
  });
});
