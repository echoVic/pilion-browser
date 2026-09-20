import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OBSERVE_SELECTOR } from '../src/main/browser/index';
import { RECORDER_WORLD, buildRecorderScript } from '../src/main/recording/index';

const BINDING = 'pilion_0123456789abcdef';

type Listener = (event: Record<string, unknown>) => void;

function fakeElement(spec: {
  tagName: string;
  attributes?: Record<string, string>;
  text?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  matches?: boolean;
}) {
  const attributes = spec.attributes ?? {};
  const element: Record<string, unknown> = {
    tagName: spec.tagName.toUpperCase(),
    type: spec.type,
    value: spec.value ?? '',
    checked: spec.checked,
    textContent: spec.text ?? '',
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    closest: () => (spec.matches === false ? null : element),
    options: spec.options?.map((value) => ({ value })),
    labels: [],
    ownerDocument: undefined as unknown,
  };
  return element;
}

function harness(elements: Record<string, unknown>[]) {
  const listeners = new Map<string, Listener[]>();
  const payloads: unknown[] = [];
  const document = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    querySelectorAll: () => elements,
    activeElement: null,
  };
  for (const element of elements) element.ownerDocument = document;
  const sandbox: Record<string, unknown> = {
    document,
    location: { href: 'https://report.example.com/login' },
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Math,
    Set,
    Boolean,
    RegExp,
    [BINDING]: (payload: string) => payloads.push(JSON.parse(payload)),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  runInNewContext(buildRecorderScript(BINDING), sandbox);
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) listener({ isTrusted: true, ...event });
  };
  return { fire, payloads, listeners, sandbox };
}

describe('buildRecorderScript', () => {
  it('拒绝不合规的 binding 名', () => {
    expect(() => buildRecorderScript('alert(1)')).toThrow(/binding/);
  });

  it('内嵌的选择器与 observe 用的是同一个常量', () => {
    expect(buildRecorderScript(BINDING)).toContain(JSON.stringify(OBSERVE_SELECTOR));
    expect(RECORDER_WORLD).toBe('pilion-recorder');
  });

  it('只上报 isTrusted 事件，页面派发的合成事件被忽略', () => {
    const button = fakeElement({ tagName: 'button', text: ' 登录 ' });
    const { fire, payloads } = harness([button]);
    fire('click', { target: button, button: 0, isTrusted: false });
    expect(payloads).toEqual([]);
    fire('click', { target: button, button: 0 });
    expect(payloads).toEqual([
      {
        kind: 'click',
        url: 'https://report.example.com/login',
        index: 0,
        el: { tagName: 'button', role: 'button', name: '登录' },
        at: expect.any(Number),
      },
    ]);
  });

  it('pointerdown 也上报，供主进程与随后的导航合成点击', () => {
    const link = fakeElement({ tagName: 'a', text: 'Learn more', attributes: { href: '/x' } });
    const { fire, payloads } = harness([link]);
    fire('pointerdown', { target: link, button: 0 });
    expect(payloads[0]).toMatchObject({
      kind: 'pointer',
      index: 0,
      el: { tagName: 'a', role: 'link' },
    });
  });

  it('input 上报当前值，密码框只上报 secret 且不带值', () => {
    const email = fakeElement({
      tagName: 'input',
      type: 'email',
      value: 'me@x.com',
      attributes: { 'aria-label': '邮箱' },
    });
    const password = fakeElement({ tagName: 'input', type: 'password', value: 'hunter2' });
    const { fire, payloads } = harness([email, password]);
    fire('input', { target: email });
    fire('focusin', { target: password });
    fire('input', { target: password });
    // focusin 与 input 各报一次 secret；连续同一字段的去重是主进程（Task 5）的事。
    expect(payloads).toEqual([
      expect.objectContaining({
        kind: 'input',
        index: 0,
        value: 'me@x.com',
        el: expect.objectContaining({ inputType: 'email', name: '邮箱' }),
      }),
      expect.objectContaining({ kind: 'secret', index: 1, otp: false }),
      expect.objectContaining({ kind: 'secret', index: 1, otp: false }),
    ]);
    expect(JSON.stringify(payloads)).not.toContain('hunter2');
  });

  it('一次性验证码按 secret 上报并标 otp', () => {
    const code = fakeElement({
      tagName: 'input',
      type: 'text',
      attributes: { autocomplete: 'one-time-code' },
    });
    const { fire, payloads } = harness([code]);
    fire('focusin', { target: code });
    expect(payloads[0]).toMatchObject({ kind: 'secret', otp: true });
  });

  it('select 与 checkbox 的 change 分别上报 select 与 check', () => {
    const month = fakeElement({
      tagName: 'select',
      value: '2026-09',
      options: ['2026-08', '2026-09'],
      attributes: { 'aria-label': '月份' },
    });
    const agree = fakeElement({ tagName: 'input', type: 'checkbox', checked: true });
    const { fire, payloads } = harness([month, agree]);
    fire('change', { target: month });
    fire('change', { target: agree });
    expect(payloads[0]).toMatchObject({
      kind: 'select',
      value: '2026-09',
      el: { optionValues: ['2026-08', '2026-09'], role: 'combobox' },
    });
    expect(payloads[1]).toMatchObject({ kind: 'check', checked: true, el: { role: 'checkbox' } });
  });

  it('文本框里只有 Enter 与 Escape 算按键，其它键已体现在最终值里', () => {
    const box = fakeElement({ tagName: 'input', type: 'text' });
    const { fire, payloads } = harness([box]);
    fire('keydown', { target: box, key: 'Backspace' });
    fire('keydown', { target: box, key: 'a' });
    fire('keydown', { target: box, key: 'Enter' });
    expect(payloads).toEqual([
      expect.objectContaining({ kind: 'key', key: 'Enter', shift: false }),
    ]);
  });

  it('空格键上报为 Space，按钮上的方向键也上报', () => {
    const button = fakeElement({ tagName: 'button', text: '下一页' });
    const { fire, payloads } = harness([button]);
    fire('keydown', { target: button, key: ' ' });
    fire('keydown', { target: button, key: 'ArrowDown', shiftKey: true });
    expect(payloads.map((p) => (p as { key: string; shift: boolean }).key)).toEqual([
      'Space',
      'ArrowDown',
    ]);
    expect((payloads[1] as { shift: boolean }).shift).toBe(true);
  });

  it('选择器范围外的点击上报 unsupported/out-of-scope', () => {
    const div = fakeElement({ tagName: 'div', text: '一块区域', matches: false });
    const { fire, payloads } = harness([]);
    fire('click', { target: div, button: 0 });
    expect(payloads[0]).toMatchObject({ kind: 'unsupported', reason: 'out-of-scope' });
  });

  it('拖拽与右键上报 unsupported/gesture', () => {
    const handle = fakeElement({ tagName: 'button', text: '滑块' });
    const { fire, payloads } = harness([handle]);
    fire('dragstart', { target: handle });
    fire('contextmenu', { target: handle });
    expect(payloads.map((p) => (p as { reason: string }).reason)).toEqual(['gesture', 'gesture']);
  });

  it('重复注入不会重复注册监听', () => {
    const button = fakeElement({ tagName: 'button', text: 'x' });
    const { listeners, sandbox } = harness([button]);
    runInNewContext(buildRecorderScript(BINDING), sandbox);
    expect(listeners.get('click')?.length).toBe(1);
  });
});
