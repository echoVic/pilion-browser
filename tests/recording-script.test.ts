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
  contentEditable?: boolean;
}) {
  const attributes = spec.attributes ?? {};
  const element: Record<string, unknown> = {
    tagName: spec.tagName.toUpperCase(),
    type: spec.type,
    value: spec.value ?? '',
    checked: spec.checked,
    textContent: spec.text ?? '',
    isContentEditable: Boolean(spec.contentEditable),
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    closest: () => (spec.matches === false ? null : element),
    options: spec.options?.map((value) => ({ value })),
    labels: [],
    ownerDocument: undefined as unknown,
  };
  return element;
}

function harness(
  elements: Record<string, unknown>[] = [],
  options: { framed?: boolean; now?: number } = {},
) {
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
  // 脚本里的 now() 读的是这个 Date.now；测试用 setNow 直接拨它，不用等真实时间流逝。
  let clock = options.now ?? Date.now();
  const sandbox: Record<string, unknown> = {
    document,
    location: { href: 'https://report.example.com/login' },
    Date: { now: () => clock },
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
  sandbox.top = options.framed ? { framed: true } : sandbox;
  runInNewContext(buildRecorderScript(BINDING), sandbox);
  // 真实的人类点击 detail 至少为 1；默认给 1，只有合成激活那一例显式传 0。
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? [])
      listener({ isTrusted: true, detail: 1, ...event });
  };
  const setNow = (value: number) => {
    clock = value;
  };
  return { fire, payloads, listeners, sandbox, setNow };
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

  it('UA 合成的激活点击（detail 为 0）不上报，真实点击照常', () => {
    const button = fakeElement({ tagName: 'button', text: '登录' });
    const { fire, payloads } = harness([button]);
    fire('click', { target: button, button: 0, detail: 0 });
    expect(payloads).toEqual([]);
    fire('click', { target: button, button: 0, detail: 1 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ kind: 'click' });
  });

  it('内嵌框架里只由 click 报一次 iframe，pointerdown 不报', () => {
    const button = fakeElement({ tagName: 'button', text: '提交' });
    const { fire, payloads } = harness([button], { framed: true });
    fire('pointerdown', { target: button, button: 0 });
    expect(payloads).toEqual([]);
    fire('click', { target: button, button: 0 });
    expect(payloads).toEqual([
      {
        kind: 'unsupported',
        url: 'https://report.example.com/login',
        reason: 'iframe',
        at: expect.any(Number),
      },
    ]);
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

  it('滚动节流到 400 毫秒一条', () => {
    const { fire, payloads, setNow } = harness();
    setNow(1_000);
    fire('scroll', {});
    setNow(1_200);
    fire('scroll', {});
    setNow(1_500);
    fire('scroll', {});
    expect(payloads.filter((p) => (p as { kind: string }).kind === 'scroll')).toHaveLength(2);
  });

  it('contenteditable 只报长度，不报内容', () => {
    const editor = fakeElement({ tagName: 'div', contentEditable: true, text: '机密内容' });
    const { fire, payloads } = harness();
    fire('input', { target: editor });
    const edit = payloads.find((p) => (p as { kind: string }).kind === 'edit');
    expect(edit).toMatchObject({ length: 4 });
    expect(JSON.stringify(edit)).not.toContain('机密');
  });

  it('iframe 里的输入、变更与按键报成 unsupported，且只报一次', () => {
    const input = fakeElement({ tagName: 'input', type: 'text', value: '张三' });
    const { fire, payloads } = harness([], { framed: true });
    fire('input', { target: input });
    fire('change', { target: input });
    fire('keydown', { target: input, key: 'Enter' });
    const recordedKinds = ['input', 'change', 'select', 'check', 'key'];
    expect(
      payloads.filter((p) => recordedKinds.includes((p as { kind: string }).kind)),
    ).toHaveLength(0);
    expect(
      payloads.filter(
        (p) =>
          (p as { kind: string; reason?: string }).kind === 'unsupported' &&
          (p as { reason?: string }).reason === 'iframe',
      ),
    ).toHaveLength(1);
  });
});
