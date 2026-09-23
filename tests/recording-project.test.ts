import { describe, expect, it } from 'vitest';
import { project, Projector } from '../src/main/recording/project';
import type { LoggedEvent } from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const target = { role: 'button', name: '导出 CSV', tagName: 'button' };
const URL = 'https://example.com/';

let seq = 0;
/** 把一条事件写全：seq 自增，at 按 seq 生成，元素类事件补上必填的 target/ambiguous。 */
function ev(partial: Record<string, unknown>): LoggedEvent {
  seq += 1;
  const at = new Date(Date.UTC(2026, 8, 21, 12, 0, Math.min(seq, 59))).toISOString();
  const base = { seq, at, url: URL, ...partial };
  if ('index' in base || 'el' in base)
    return { pageAt: seq * 1000, el, target, ambiguous: false, ...base } as LoggedEvent;
  return base as LoggedEvent;
}

function steps(events: LoggedEvent[]) {
  return project(events).entries.flatMap((entry) => (entry.kind === 'step' ? [entry] : []));
}

// 以下这批夹具/辅助函数只给从 recording-recorder.test.ts 搬迁过来的用例用。
const button = { tagName: 'button', role: 'button', name: '登录' };
const buttonTarget = { role: 'button', name: '登录', tagName: 'button' };
const email = { tagName: 'input', role: 'textbox', name: '邮箱', inputType: 'email' };
const emailTarget = { role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' };

function click(
  index: number,
  elArg = button,
  targetArg = buttonTarget,
  pageAt?: number,
): LoggedEvent {
  return ev({
    kind: 'click',
    index,
    el: elArg,
    target: targetArg,
    ...(pageAt === undefined ? {} : { pageAt }),
  });
}
function pointer(index: number, elArg = button, targetArg = buttonTarget): LoggedEvent {
  return ev({ kind: 'pointer', index, el: elArg, target: targetArg });
}
function input(index: number, value: string, elArg = email, targetArg = emailTarget): LoggedEvent {
  return ev({ kind: 'input', index, value, el: elArg, target: targetArg });
}
/** unsupported 事件没有 target/ambiguous，得绕开 ev() 的元素分支，直接拼字面量。 */
function unsupportedEvent(partial: {
  reason: 'iframe' | 'out-of-scope' | 'gesture';
  el?: { tagName: string; role: string; name: string };
}): LoggedEvent {
  seq += 1;
  const at = new Date(Date.UTC(2026, 8, 21, 12, 0, Math.min(seq, 59))).toISOString();
  return { kind: 'unsupported', seq, at, url: URL, ...partial } as LoggedEvent;
}

describe('project', () => {
  it('后退与刷新也产出 navigate 步骤', () => {
    seq = 0;
    const out = steps([
      ev({ kind: 'page', url: URL, title: '列表', text: '' }),
      ev({ kind: 'navigate', url: 'https://example.com/list', cause: 'back' }),
      ev({ kind: 'page', url: 'https://example.com/list', title: '列表', text: '' }),
      ev({ kind: 'navigate', url: 'https://example.com/list', cause: 'reload' }),
    ]);
    expect(out.map((entry) => entry.step)).toEqual([
      { kind: 'navigate', url: 'https://example.com/list' },
      { kind: 'navigate', url: 'https://example.com/list' },
    ]);
  });

  // 录制待办 Task 2：截断过的导航不能原样回放，去一个被截短的地址会悄悄走错。
  it('截断过的导航产出带 url-too-long 的「需要我」', () => {
    seq = 0;
    const longUrl = 'https://example.com/' + 'x'.repeat(200);
    const out = steps([
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'navigate', url: longUrl, cause: 'address', truncated: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].unsupported).toBe('url-too-long');
    expect(out[0].step).toEqual({
      kind: 'human',
      onUrl: longUrl,
      reason: '手动打开录制时的那个地址：地址太长，回放无法原样还原',
    });
  });

  it('没截断过的导航与现在逐字节相同', () => {
    seq = 0;
    const out = steps([ev({ kind: 'navigate', url: 'https://example.com/x', cause: 'reload' })]);
    expect(out).toHaveLength(1);
    expect(out[0].unsupported).toBeUndefined();
    expect(out[0].step).toEqual({ kind: 'navigate', url: 'https://example.com/x' });
  });

  it('富文本输入变成带 rich-text 的「需要我」，不是超纲提示', () => {
    seq = 0;
    const out = steps([
      ev({ kind: 'page', url: URL, title: '编辑器', text: '' }),
      ev({
        kind: 'edit',
        index: -1,
        el: { tagName: 'div', role: 'generic', name: '' },
        target: { role: 'generic', name: '', tagName: 'div' },
        length: 12,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].unsupported).toBe('rich-text');
    expect(out[0].step).toEqual({ kind: 'human', onUrl: URL, reason: '手动填写富文本内容' });
  });

  it('滚动完全不进投影', () => {
    seq = 0;
    expect(steps([ev({ kind: 'scroll', x: 0, y: 900 })])).toHaveLength(0);
  });

  it('条目的时间来自事件，不来自当前时钟', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'input', index: 1, value: '张三' }),
      ev({ kind: 'click', index: 2 }),
    ];
    const out = project(events).entries;
    // type 步骤落的是那条 input 自己的时间戳
    expect(out[1].at).toBe(events[1].at);
    expect(out[2].at).toBe(events[2].at);
  });

  it('增量喂入与一次性 project 结果逐条相同', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'input', index: 1, value: '张三' }),
      ev({ kind: 'pointer', index: 2 }),
      ev({ kind: 'click', index: 2 }),
    ];
    const incremental = new Projector();
    for (const event of events) incremental.push(event);
    expect(incremental.done().entries).toEqual(project(events).entries);
  });

  it('同一份日志算两次结果相同', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      ev({ kind: 'click', index: 2 }),
    ];
    expect(project(events)).toEqual(project(events));
  });

  it('counts 把挂起的输入也算一步', () => {
    seq = 0;
    const projector = new Projector();
    projector.push(ev({ kind: 'page', url: URL, title: '页', text: '' }));
    projector.push(ev({ kind: 'input', index: 1, value: '张三' }));
    expect(projector.counts.steps).toBe(1);
  });

  // 以下用例从 tests/recording-recorder.test.ts 搬迁而来：断言保持不变，
  // 只把「调用 TrajectoryRecorder 的方法」换成「构造 LoggedEvent 数组喂 project()」。

  it('page 产出页面条目，navigate 与 note 直接成步骤', () => {
    seq = 0;
    const events = [
      ev({ kind: 'navigate', url: URL, cause: 'address' }),
      ev({ kind: 'page', url: URL, title: '登录', text: '请输入' }),
      ev({ kind: 'note', text: '这里要用公司邮箱' }),
    ];
    const entries = project(events).entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page', 'step']);
    expect(entries[0]).toMatchObject({ step: { kind: 'navigate', url: URL } });
    expect(entries[1]).toMatchObject({ kind: 'page', url: URL, title: '登录', text: '请输入' });
    expect(entries[2]).toMatchObject({
      step: { kind: 'note', text: '这里要用公司邮箱', onUrl: URL },
    });
  });

  it('同一输入框的连续 input 合并成一条 type，只留最终值，且 replace 为 true', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '', text: '' }),
      input(0, 'm'),
      input(0, 'me'),
      input(0, 'me@x.com'),
    ];
    const result = steps(events);
    expect(result).toHaveLength(1);
    expect(result[0].step).toEqual({
      kind: 'type',
      onUrl: URL,
      target: emailTarget,
      text: 'me@x.com',
      replace: true,
    });
  });

  it('换到别的元素时先提交挂起的输入，顺序保持', () => {
    seq = 0;
    const events = [input(0, 'me@x.com'), click(1)];
    expect(steps(events).map((e) => e.step.kind)).toEqual(['type', 'click']);
  });

  it('pointer 紧跟 click 只产出一条 click', () => {
    seq = 0;
    const events = [pointer(1), click(1)];
    expect(steps(events).map((e) => e.step.kind)).toEqual(['click']);
  });

  it('pointer 后页面直接跳走也算一次 click', () => {
    seq = 0;
    const events = [
      pointer(1),
      ev({ kind: 'page', url: 'https://example.com/dashboard', title: '仪表盘', text: '' }),
    ];
    const entries = project(events).entries;
    expect(entries.map((e) => e.kind)).toEqual(['step', 'page']);
    expect(entries[0]).toMatchObject({
      step: { kind: 'click', onUrl: URL, target: { name: '登录' } },
    });
  });

  it('孤立的 pointer 被丢弃', () => {
    seq = 0;
    const events = [pointer(1), input(0, 'a')];
    expect(steps(events).map((e) => e.step.kind)).toEqual(['type']);
  });

  it('pointer 之后有别的事件再换页，不会伪造点击', () => {
    seq = 0;
    const events = [
      pointer(1),
      ev({
        kind: 'key',
        index: 3,
        el: { tagName: 'button', role: 'button', name: '下一页' },
        target: { role: 'button', name: '下一页', tagName: 'button' },
        key: 'Enter',
        shift: false,
      }),
      ev({ kind: 'page', url: 'https://example.com/dashboard', title: '仪表盘', text: '' }),
    ];
    expect(steps(events).map((e) => e.step.kind)).toEqual(['press']);
  });

  it('换页后同 index 的点击不算双击', () => {
    seq = 0;
    const events = [
      click(1, button, buttonTarget, 5_000),
      ev({ kind: 'page', url: 'https://example.com/dashboard', title: '仪表盘', text: '' }),
      click(1, button, buttonTarget, 5_100),
    ];
    expect(steps(events).map((e) => e.step.kind)).toEqual(['click', 'click']);
  });

  it('400ms 内的双击折叠成一次', () => {
    seq = 0;
    const events = [
      click(1, button, buttonTarget, 5_000),
      click(1, button, buttonTarget, 5_200),
      click(1, button, buttonTarget, 9_000),
    ];
    expect(steps(events)).toHaveLength(2);
  });

  it('secret 产出「需要我」步骤，连续的只留一条，且从不带值', () => {
    seq = 0;
    const password = { tagName: 'input', role: 'textbox', name: '密码', inputType: 'password' };
    const passwordTarget = {
      role: 'textbox',
      name: '密码',
      tagName: 'input',
      inputType: 'password',
    };
    const events = [
      ev({ kind: 'secret', index: 2, el: password, target: passwordTarget, otp: false }),
      ev({ kind: 'secret', index: 2, el: password, target: passwordTarget, otp: false }),
      ev({
        kind: 'secret',
        index: 3,
        el: { ...password, name: '验证码', inputType: 'text' },
        target: { ...passwordTarget, name: '验证码', inputType: 'text' },
        otp: true,
      }),
    ];
    const result = steps(events);
    expect(result.map((e) => e.step)).toEqual([
      { kind: 'human', onUrl: URL, reason: '填写密码' },
      { kind: 'human', onUrl: URL, reason: '填写验证码' },
    ]);
  });

  it('Enter 先提交挂起输入再产出 press', () => {
    seq = 0;
    const events = [
      input(0, 'hello'),
      ev({ kind: 'key', index: 0, el: email, target: emailTarget, key: 'Enter', shift: false }),
    ];
    const result = steps(events);
    expect(result.map((e) => e.step.kind)).toEqual(['type', 'press']);
    expect(result[1].step).toMatchObject({ key: 'Enter', modifiers: [] });
  });

  it('Shift 作为唯一支持的修饰键写入 modifiers', () => {
    seq = 0;
    const events = [
      ev({ kind: 'key', index: 1, el: button, target: buttonTarget, key: 'Tab', shift: true }),
    ];
    expect(steps(events)[0].step).toMatchObject({
      kind: 'press',
      key: 'Tab',
      modifiers: ['Shift'],
    });
  });

  it('unsupported 变成带原因的「需要我」步骤', () => {
    seq = 0;
    const events = [
      unsupportedEvent({
        reason: 'gesture',
        el: { tagName: 'button', role: 'button', name: '滑块' },
      }),
      unsupportedEvent({ reason: 'iframe' }),
    ];
    const result = steps(events);
    expect(result[0]).toMatchObject({
      unsupported: 'gesture',
      step: { kind: 'human', reason: expect.stringContaining('滑块') },
    });
    expect(result[1]).toMatchObject({ unsupported: 'iframe', step: { kind: 'human' } });
    const projector = new Projector();
    for (const event of events) projector.push(event);
    expect(projector.counts).toEqual({ steps: 2, unsupported: 2 });
  });

  it('序号超出 observe 上限标 beyond-observe-limit', () => {
    seq = 0;
    const events = [click(250)];
    expect(steps(events)[0]).toMatchObject({ unsupported: 'beyond-observe-limit' });
    const projector = new Projector();
    for (const event of events) projector.push(event);
    expect(projector.counts.unsupported).toBe(1);
  });

  it('超纲的 pointer 加 click 只提醒一次', () => {
    seq = 0;
    const events = [pointer(250), click(250)];
    const result = steps(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      unsupported: 'beyond-observe-limit',
      step: { kind: 'human' },
    });
    const projector = new Projector();
    for (const event of events) projector.push(event);
    expect(projector.counts).toEqual({ steps: 1, unsupported: 1 });
  });

  it('超纲的 pointer 之后页面跳走，补的也是那一条「需要我」', () => {
    seq = 0;
    const events = [
      pointer(250),
      ev({ kind: 'page', url: 'https://example.com/dashboard', title: '仪表盘', text: '' }),
    ];
    const result = steps(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      unsupported: 'beyond-observe-limit',
      step: { kind: 'human', onUrl: URL },
    });
  });

  it('空值下拉变成「需要我」而不是让 finish 抛错', () => {
    seq = 0;
    const events = [
      ev({
        kind: 'select',
        index: 4,
        el: { tagName: 'select', role: 'combobox', name: '月份' },
        target: { role: 'combobox', name: '月份', tagName: 'select' },
        value: '',
      }),
    ];
    expect(() => project(events)).not.toThrow();
    expect(steps(events)[0]).toMatchObject({
      unsupported: 'out-of-scope',
      step: { kind: 'human', onUrl: URL, reason: '手动完成：在 "月份" 里选择空选项' },
    });
  });

  it('到达 2000 条上限后不再增长，capped 置位', () => {
    seq = 0;
    const events: LoggedEvent[] = [];
    for (let i = 0; i < 2100; i += 1) events.push(click(1));
    const result = project(events);
    expect(result.capped).toBe(true);
    expect(result.entries).toHaveLength(2000);
    expect(result.entries.every((entry) => entry.kind === 'step')).toBe(true);
  });

  // 修复轮次 1 的回归用例：scroll 曾经在 push() 里直接 return，跳过了规则 3 的 pointer 清理。

  it('滚动之后换页不会伪造点击', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      pointer(2),
      ev({ kind: 'scroll', x: 0, y: 400 }),
      ev({ kind: 'page', url: 'https://example.com/dashboard', title: '仪表盘', text: '' }),
    ];
    expect(steps(events).map((entry) => entry.step.kind)).not.toContain('click');
  });

  it('滚动不会把一次输入拆成两步', () => {
    seq = 0;
    const events = [
      ev({ kind: 'page', url: URL, title: '页', text: '' }),
      input(1, '张三'),
      ev({ kind: 'scroll', x: 0, y: 300 }),
    ];
    const result = steps(events);
    expect(result).toHaveLength(1);
    expect(result[0].step).toMatchObject({ kind: 'type', text: '张三' });
  });
});
