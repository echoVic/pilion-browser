import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OBSERVE_SELECTOR, type Observation } from '../src/main/browser/index';
import {
  MAX_URL_LENGTH,
  RECORDER_WORLD,
  RawEventSchema,
  RecordingCapture,
  buildRecorderScript,
  resolveTarget,
  type RawEvent,
  type StepTarget,
} from '../src/main/recording/index';

const BINDING = 'pilion_0123456789abcdef';

type Listener = (event: Record<string, unknown>) => void;
type FakeNode = Record<string, unknown>;

/** 录制脚本判定编辑宿主用的选择器。假 DOM 的 closest/querySelector 只认它和 OBSERVE_SELECTOR。 */
const EDITING_HOST = '[contenteditable]:not([contenteditable="false"])';
/** 元素是否落在 OBSERVE_SELECTOR 里：沿父链找 scoped() 的结果时要用。 */
const observable = new WeakMap<FakeNode, boolean | undefined>();
/** 在哪些节点上调用过 querySelectorAll('*')：那是逐个摸子树找影子根的一步，只许给正在描述的元素跑。 */
const deepScans: FakeNode[] = [];

/** 与 EDITING_HOST 同义：写了 contenteditable，且值不是 "false"。 */
function isEditingHost(node: FakeNode): boolean {
  const value = (node.getAttribute as (name: string) => string | null)('contenteditable');
  return value !== null && value !== 'false';
}

/** 树序列出子孙元素，与真实的 querySelectorAll 一样不进影子根。 */
function descendants(scope: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const stack = [...(scope.childNodes as FakeNode[])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType !== 1) continue;
    out.push(node);
    stack.push(...[...(node.childNodes as FakeNode[])].reverse());
  }
  return out;
}

/** 元素与影子根共用的查询：querySelector 只认编辑宿主，querySelectorAll 只认 '*' 与 'input'。 */
function queries(scope: FakeNode) {
  return {
    querySelector: (selector: string) => {
      if (selector !== EDITING_HOST) throw new Error(`假 DOM 不认识的选择器：${selector}`);
      return descendants(scope).find(isEditingHost) ?? null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === '*') {
        deepScans.push(scope);
        return descendants(scope);
      }
      if (selector === 'input')
        return descendants(scope).filter((node) => node.tagName === 'INPUT');
      throw new Error(`假 DOM 不认识的选择器：${selector}`);
    },
  };
}

function toNodes(children: Array<FakeNode | string>): FakeNode[] {
  return children.map((child) =>
    typeof child === 'string' ? { nodeType: 3, nodeValue: child, textContent: child } : child,
  );
}

/** 挂到父节点下：影子根里的顶层节点 parentNode 是影子根、parentElement 为空，和真实 DOM 一样。 */
function adopt(parent: FakeNode, children: FakeNode[], parentElement: FakeNode | null): void {
  for (const child of children) {
    child.parentNode = parent;
    child.parentElement = parentElement;
  }
}

/** 把一个节点分配进影子树里的插槽：它在 DOM 里仍是宿主的子节点，渲染时却在插槽的位置。 */
function slotInto(node: FakeNode, slot: FakeNode): void {
  node.assignedSlot = slot;
}

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
  /** 子节点：字符串是文本节点，对象是别的 fakeElement。不给时 text 就是唯一的文本子节点。 */
  children?: Array<FakeNode | string>;
  labels?: FakeNode[];
  /** 开放影子根里的子节点。textContent 不含它们，和真实 DOM 一样。 */
  shadow?: Array<FakeNode | string>;
}) {
  const attributes = spec.attributes ?? {};
  const childNodes = toNodes(spec.children ?? (spec.text === undefined ? [] : [spec.text]));
  const element: FakeNode = {
    nodeType: 1,
    tagName: spec.tagName.toUpperCase(),
    type: spec.type,
    value: spec.value ?? '',
    checked: spec.checked,
    // 与真实 DOM 一样由子节点拼出来；只给 text 时就是 text 本身，和以前一样。
    textContent: childNodes.map((node) => node.textContent).join(''),
    isContentEditable: Boolean(spec.contentEditable),
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    // 与真实 closest 一样沿父元素走、出不了影子根。
    closest: (selector: string) => {
      const up = (node: FakeNode) => node.parentElement as FakeNode | null;
      if (selector === EDITING_HOST) {
        for (let node: FakeNode | null = element; node; node = up(node))
          if (isEditingHost(node)) return node;
        return null;
      }
      if (selector !== OBSERVE_SELECTOR) throw new Error(`假 DOM 不认识的选择器：${selector}`);
      // 找第一个落在选择器里的；没有父元素时就是原来的「matches 为 false 返回 null，否则返回自己」。
      for (let node: FakeNode | null = element; node; node = up(node))
        if (observable.get(node) !== false) return node;
      return null;
    },
    childNodes,
    parentNode: null,
    parentElement: null,
    options: spec.options?.map((value) => ({ value })),
    labels: spec.labels ?? [],
    ownerDocument: undefined as unknown,
  };
  Object.assign(element, queries(element));
  if (spec.shadow) {
    const shadowNodes = toNodes(spec.shadow);
    const root: FakeNode = { nodeType: 11, host: element, childNodes: shadowNodes };
    Object.assign(root, queries(root));
    adopt(root, shadowNodes, null);
    element.shadowRoot = root;
  }
  observable.set(element, spec.matches);
  adopt(element, childNodes, element);
  return element;
}

function harness(
  elements: Record<string, unknown>[] = [],
  options: {
    framed?: boolean;
    now?: number;
    href?: string;
    /** 文档里不在 observe 选择器之内、只能按 id 找到的节点（比如被 aria-labelledby 指着的编辑区）。 */
    extra?: FakeNode[];
    designMode?: string;
  } = {},
) {
  const listeners = new Map<string, Listener[]>();
  const payloads: unknown[] = [];
  /** binding 收到的原始字符串：「逐字节相同」比的就是它。 */
  const raw: string[] = [];
  const findable = [...elements, ...(options.extra ?? [])];
  deepScans.length = 0;
  const document = {
    designMode: options.designMode,
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    querySelectorAll: () => elements,
    // aria-labelledby 指向自己（或同文档里另一个元素）时，labelText() 靠它按 id 找节点。
    getElementById: (id: string) =>
      findable.find(
        (el) => (el as { getAttribute: (name: string) => string | null }).getAttribute('id') === id,
      ) ?? null,
    activeElement: null,
  };
  for (const element of findable) element.ownerDocument = document;
  // 脚本里的 now() 读的是这个 Date.now；测试用 setNow 直接拨它，不用等真实时间流逝。
  let clock = options.now ?? Date.now();
  const sandbox: Record<string, unknown> = {
    document,
    location: { href: options.href ?? 'https://report.example.com/login' },
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
    [BINDING]: (payload: string) => {
      raw.push(payload);
      payloads.push(JSON.parse(payload));
    },
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
  return { fire, payloads, raw, listeners, sandbox, setNow };
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

  it('autocomplete 标着当前密码或新密码的明文框也算密码：只报 secret，不带值', () => {
    for (const autocomplete of ['current-password', 'new-password', 'section-login new-password']) {
      const field = fakeElement({
        tagName: 'input',
        type: 'text',
        value: 'hunter22',
        attributes: { autocomplete },
      });
      const { fire, payloads } = harness([field]);
      fire('focusin', { target: field });
      fire('input', { target: field });
      expect(payloads, autocomplete).toEqual([
        expect.objectContaining({ kind: 'secret', otp: false }),
        expect.objectContaining({ kind: 'secret', otp: false }),
      ]);
      expect(JSON.stringify(payloads)).not.toContain('hunter22');
    }
  });

  describe('「显示密码」把密码框切成明文之后', () => {
    const password = () =>
      fakeElement({
        tagName: 'input',
        type: 'password',
        value: 'hunter22',
        attributes: { 'aria-label': '密码' },
      });

    it('获得过焦点的密码框被切成明文，再打字仍只报 secret，不带值', () => {
      // 密码框在脚本开始之后才出现（单页应用弹出的登录框）：脚本第一次见到它，是它获得焦点的时候。
      const elements: FakeNode[] = [];
      const { fire, payloads } = harness(elements);
      const field = password();
      elements.push(field);
      fire('focusin', { target: field });
      field.type = 'text';
      fire('input', { target: field });
      expect(payloads).toEqual([
        expect.objectContaining({ kind: 'secret', otp: false }),
        expect.objectContaining({ kind: 'secret', otp: false }),
      ]);
      expect(JSON.stringify(payloads)).not.toContain('hunter22');
    });

    it('脚本开始时就是密码框的：没获得过焦点就被切成明文，打字照样只报 secret', () => {
      const field = password();
      const { fire, payloads } = harness([field]);
      field.type = 'text';
      fire('focusin', { target: field });
      fire('input', { target: field });
      expect(payloads.map((payload) => (payload as { kind: string }).kind)).toEqual([
        'secret',
        'secret',
      ]);
      expect(JSON.stringify(payloads)).not.toContain('hunter22');
    });

    it('脚本开始之后才出现、先按了「显示密码」再点框：按下开关的那一下已经把它记下', () => {
      for (const press of ['pointerdown', 'keydown']) {
        const toggle = fakeElement({ tagName: 'button', text: '显示密码' });
        const elements: FakeNode[] = [toggle];
        const { fire, payloads } = harness(elements);
        const field = password();
        elements.push(field);
        // 页面自己的处理在这之后才把框换成明文。
        fire(press, { target: toggle, button: 0, key: 'Enter' });
        field.type = 'text';
        fire('focusin', { target: field });
        fire('input', { target: field });
        const kinds = payloads.map((payload) => (payload as { kind: string }).kind);
        expect(kinds, press).toEqual([
          press === 'pointerdown' ? 'pointer' : 'key',
          'secret',
          'secret',
        ]);
        expect(JSON.stringify(payloads)).not.toContain('hunter22');
      }
    });
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

  it('富文本的 name 一律置空：aria-label、title、指向自己的 aria-labelledby 都不能把正文带出去', () => {
    // 三条来源一起给：aria-label 镜像正文、title 镜像正文、aria-labelledby 指向编辑器自己
    // （labelText() 会去 document.getElementById 找它，取到的就是编辑器自身的 textContent）。
    const editor = fakeElement({
      tagName: 'div',
      contentEditable: true,
      text: '机密内容我刚打的',
      attributes: {
        id: 'editor-1',
        'aria-labelledby': 'editor-1',
        'aria-label': '机密标签',
        title: '机密标题',
      },
    });
    const { fire, payloads } = harness([editor]);
    fire('input', { target: editor });
    const edit = payloads.find((p) => (p as { kind: string }).kind === 'edit') as
      { length: number; el: { name: string } } | undefined;
    expect(edit).toMatchObject({ length: 8 });
    expect(edit?.el.name).toBe('');
    expect(JSON.stringify(edit)).not.toContain('机密');
  });

  it('富文本分支里密码字段仍然只报 secret，不报长度', () => {
    // 万一某个密码输入框把自己报成 contenteditable，也不能从富文本这条岔路漏出字符数。
    const passwordish = fakeElement({
      tagName: 'input',
      type: 'password',
      contentEditable: true,
      value: 'hunter2',
    });
    const { fire, payloads } = harness();
    fire('input', { target: passwordish });
    expect(payloads).toEqual([expect.objectContaining({ kind: 'secret', otp: false })]);
    expect(payloads.some((p) => (p as { kind: string }).kind === 'edit')).toBe(false);
    expect(JSON.stringify(payloads)).not.toContain('hunter2');
  });

  it('地址超过 MAX_URL_LENGTH 时脚本层先截断，点击事件照常发出并通过 RawEventSchema', () => {
    const base = 'https://report.example.com/login?x=';
    const longHref = base + 'a'.repeat(9000 - base.length); // 正好 9000 个字符
    expect(longHref).toHaveLength(9000);
    const button = fakeElement({ tagName: 'button', text: '登录' });
    const { fire, payloads } = harness([button], { href: longHref });
    fire('click', { target: button, button: 0 });
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { url: string };
    expect(payload.url).toHaveLength(MAX_URL_LENGTH);
    expect(payload.url).toBe(longHref.slice(0, MAX_URL_LENGTH));
    expect(RawEventSchema.safeParse(payload).success).toBe(true);
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

// 以下为录制待办 Task 3 新增：富文本编辑区里人打的字，不能经元素名带出页面。
describe('富文本正文不进元素名', () => {
  const URL = 'https://report.example.com/login';
  /** 一个编辑宿主：写了 contenteditable="true"，本身不在 observe 选择器里。 */
  const editorOf = (children: Array<FakeNode | string>, attributes: Record<string, string> = {}) =>
    fakeElement({
      tagName: 'div',
      attributes: { contenteditable: 'true', ...attributes },
      matches: false,
      children,
    });

  it('不在任何编辑上下文里的按钮与链接，载荷与以前逐字节相同，不带 editable', () => {
    const button = fakeElement({ tagName: 'button', text: ' 登录 ' });
    const link = fakeElement({ tagName: 'a', text: 'Learn more', attributes: { href: '/x' } });
    const { fire, payloads, raw } = harness([button, link], { now: 1_000 });
    fire('click', { target: button, button: 0 });
    fire('pointerdown', { target: link, button: 0 });
    expect(payloads).toStrictEqual([
      {
        kind: 'click',
        url: URL,
        index: 0,
        el: { tagName: 'button', role: 'button', name: '登录' },
        at: 1_000,
      },
      {
        kind: 'pointer',
        url: URL,
        index: 1,
        el: { tagName: 'a', role: 'link', name: 'Learn more' },
        at: 1_000,
      },
    ]);
    expect(raw).toEqual([
      '{"kind":"click","url":"https://report.example.com/login","index":0,"el":{"tagName":"button","role":"button","name":"登录"},"at":1000}',
      '{"kind":"pointer","url":"https://report.example.com/login","index":1,"el":{"tagName":"a","role":"link","name":"Learn more"},"at":1000}',
    ]);
  });

  it('页面别处有编辑区时，普通按钮照旧按原来的名字数同名，载荷逐字节相同', () => {
    const first = fakeElement({ tagName: 'button', text: '保存' });
    const second = fakeElement({ tagName: 'button', text: '保存' });
    // 编辑区里也有一个写着「保存」的按钮：它的干净名是空串，但普通按钮的计数不能因此变。
    const inside = fakeElement({ tagName: 'button', text: '保存' });
    editorOf([inside]);
    const { fire, raw } = harness([first, second, inside], { now: 1_000 });
    fire('click', { target: second, button: 0 });
    expect(raw).toEqual([
      '{"kind":"click","url":"https://report.example.com/login","index":1,"el":{"tagName":"button","role":"button","name":"保存","duplicates":3,"position":2},"at":1000}',
    ]);
  });

  it('带角色属性的外壳包着编辑区：点进编辑区时名字只取编辑区之外的字，并带 editable', () => {
    const editor = editorOf(['机密正文，刚打的']);
    const card = fakeElement({
      tagName: 'span',
      attributes: { role: 'button' },
      children: ['卡片标题', editor],
    });
    const { fire, payloads } = harness([card], { now: 1_000 });
    // 真实点击落在编辑区上，scoped() 沿父链找到带角色的外壳。
    fire('pointerdown', { target: editor, button: 0 });
    fire('click', { target: editor, button: 0 });
    const el = { tagName: 'span', role: 'button', name: '卡片标题', editable: true };
    expect(payloads).toStrictEqual([
      { kind: 'pointer', url: URL, index: 0, el, at: 1_000 },
      { kind: 'click', url: URL, index: 0, el, at: 1_000 },
    ]);
    expect(JSON.stringify(payloads)).not.toContain('机密');
    for (const payload of payloads) expect(RawEventSchema.safeParse(payload).success).toBe(true);
  });

  it('编辑区里的链接完全不从内容取名', () => {
    const link = fakeElement({
      tagName: 'a',
      attributes: { href: 'https://x.example/' },
      text: '机密链接文字',
    });
    editorOf(['前文', link, '后文']);
    const { fire, payloads } = harness([link], { now: 1_000 });
    fire('click', { target: link, button: 0 });
    expect(payloads).toStrictEqual([
      {
        kind: 'click',
        url: URL,
        index: 0,
        el: { tagName: 'a', role: 'link', name: '', editable: true },
        at: 1_000,
      },
    ]);
    expect(RawEventSchema.safeParse(payloads[0]).success).toBe(true);
  });

  it('没有标签的编辑框自己就是编辑宿主，点它也不从内容取名', () => {
    const editor = fakeElement({
      tagName: 'div',
      attributes: { contenteditable: 'true', role: 'textbox' },
      text: '机密正文',
    });
    const { fire, payloads } = harness([editor], { now: 1_000 });
    fire('click', { target: editor, button: 0 });
    expect(payloads).toStrictEqual([
      {
        kind: 'click',
        url: URL,
        index: 0,
        el: { tagName: 'div', role: 'textbox', name: '', editable: true },
        at: 1_000,
      },
    ]);
  });

  it('编辑区里 contenteditable="false" 的提及标签，走越界上报那条路也不带正文', () => {
    const chip = fakeElement({
      tagName: 'span',
      attributes: { contenteditable: 'false' },
      matches: false,
      text: '@机密同事',
    });
    editorOf(['你好 ', chip]);
    const { fire, payloads } = harness([], { now: 1_000 });
    fire('click', { target: chip, button: 0 });
    expect(payloads).toStrictEqual([
      {
        kind: 'unsupported',
        url: URL,
        reason: 'out-of-scope',
        el: { tagName: 'span', role: 'generic', name: '', editable: true },
        at: 1_000,
      },
    ]);
    expect(RawEventSchema.safeParse(payloads[0]).success).toBe(true);
  });

  it('aria-labelledby 直接指向编辑区的按钮：名字跳过编辑区，退回按钮自己的文字', () => {
    const draft = editorOf(['机密草稿'], { id: 'draft' });
    const send = fakeElement({
      tagName: 'button',
      attributes: { 'aria-labelledby': 'draft' },
      text: '发送',
    });
    const { fire, payloads } = harness([send], { now: 1_000, extra: [draft] });
    fire('click', { target: send, button: 0 });
    // 原来的名字是编辑区里的字，里面没有「发送」：observe 里叫「发送」的一行证明不了就是它，带 split。
    expect(payloads).toStrictEqual([
      {
        kind: 'click',
        url: URL,
        index: 0,
        el: { tagName: 'button', role: 'button', name: '发送', editable: true, split: true },
        at: 1_000,
      },
    ]);
  });

  it('aria-labelledby 指向包着编辑区的容器：只读容器里编辑区之外的字', () => {
    const compose = fakeElement({
      tagName: 'div',
      attributes: { id: 'compose' },
      matches: false,
      children: ['收件人', editorOf(['机密草稿'])],
    });
    const send = fakeElement({
      tagName: 'button',
      attributes: { 'aria-labelledby': 'compose' },
      text: '发送',
    });
    const { fire, payloads } = harness([send], { now: 1_000, extra: [compose] });
    fire('click', { target: send, button: 0 });
    expect(payloads[0]).toStrictEqual({
      kind: 'click',
      url: URL,
      index: 0,
      el: { tagName: 'button', role: 'button', name: '收件人', editable: true },
      at: 1_000,
    });
  });

  it('label 里包着编辑区的输入框同样带标记，名字只取 label 里编辑区之外的字', () => {
    const label = fakeElement({
      tagName: 'label',
      matches: false,
      children: ['备注：', editorOf(['机密批注'])],
    });
    const input = fakeElement({ tagName: 'input', type: 'text', labels: [label] });
    const { fire, payloads } = harness([input], { now: 1_000 });
    fire('click', { target: input, button: 0 });
    expect(payloads[0]).toStrictEqual({
      kind: 'click',
      url: URL,
      index: 0,
      el: { tagName: 'input', role: 'textbox', name: '备注：', inputType: 'text', editable: true },
      at: 1_000,
    });
  });

  it('编辑框用 aria-labelledby 指向编辑区之外的标题时，照常用标题取名，只是带上 editable', () => {
    const heading = fakeElement({
      tagName: 'h2',
      attributes: { id: 'compose-title' },
      matches: false,
      text: '邮件正文',
    });
    const editor = fakeElement({
      tagName: 'div',
      attributes: { contenteditable: 'true', role: 'textbox', 'aria-labelledby': 'compose-title' },
      text: '机密正文',
    });
    const { fire, payloads } = harness([editor], { now: 1_000, extra: [heading] });
    fire('click', { target: editor, button: 0 });
    expect(payloads[0]).toStrictEqual({
      kind: 'click',
      url: URL,
      index: 0,
      el: { tagName: 'div', role: 'textbox', name: '邮件正文', editable: true },
      at: 1_000,
    });
  });

  it('带标记的元素按同一套干净名数同名，一定数得到它自己，载荷过得了 RawEventSchema', () => {
    // 编辑区外两个没有名字的图标链接，编辑区里两个链接：干净名全是空串，一共四个。
    const iconA = fakeElement({ tagName: 'a', attributes: { href: '/a' } });
    const iconB = fakeElement({ tagName: 'a', attributes: { href: '/b' } });
    const one = fakeElement({ tagName: 'a', attributes: { href: '/1' }, text: '机密一' });
    const two = fakeElement({ tagName: 'a', attributes: { href: '/2' }, text: '机密二' });
    editorOf([one, two]);
    const { fire, payloads } = harness([iconA, iconB, one, two], { now: 1_000 });
    fire('click', { target: two, button: 0 });
    expect(payloads[0]).toStrictEqual({
      kind: 'click',
      url: URL,
      index: 3,
      el: { tagName: 'a', role: 'link', name: '', duplicates: 4, position: 4, editable: true },
      at: 1_000,
    });
    expect(RawEventSchema.safeParse(payloads[0]).success).toBe(true);
  });

  it('编辑区自己的 edit 载荷照旧抹掉名字，并带上 editable', () => {
    const editor = fakeElement({
      tagName: 'div',
      contentEditable: true,
      attributes: { contenteditable: 'true', 'aria-label': '机密标签' },
      text: '机密内容',
    });
    const { fire, payloads } = harness([editor], { now: 1_000 });
    fire('input', { target: editor });
    expect(payloads).toStrictEqual([
      {
        kind: 'edit',
        url: URL,
        index: 0,
        el: { tagName: 'div', role: 'generic', name: '', editable: true },
        at: 1_000,
        length: 4,
      },
    ]);
    expect(RawEventSchema.safeParse(payloads[0]).success).toBe(true);
  });
});

// 以下为录制待办 Task 3 修订一：影子根、designMode、密码框与验证码框。
describe('名字可能取自人打的字或密码框的值', () => {
  const URL = 'https://report.example.com/login';
  const editorOf = (children: Array<FakeNode | string>) =>
    fakeElement({
      tagName: 'div',
      attributes: { contenteditable: 'true' },
      matches: false,
      children,
    });
  /** 点一下，返回那条 click 的 el；顺带核对整条载荷过得了 RawEventSchema。 */
  const clickEl = (elements: FakeNode[], target: FakeNode, options = {}) => {
    const { fire, payloads } = harness(elements, { now: 1_000, ...options });
    fire('click', { target, button: 0 });
    const click = payloads.find((p) => (p as { kind: string }).kind === 'click');
    expect(RawEventSchema.safeParse(click).success).toBe(true);
    return { el: (click as { el: unknown }).el, text: JSON.stringify(payloads) };
  };

  it('外壳下开放影子根里的编辑区也算：名字只取影子根之外的字，并带 editable', () => {
    const inner = fakeElement({
      tagName: 'x-ed',
      matches: false,
      shadow: [editorOf(['机密影子'])],
    });
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['影子卡片', inner],
    });
    const { el } = clickEl([card], card);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '影子卡片', editable: true });
  });

  it('影子根里的元素、宿主在编辑区里：同样不从内容取名', () => {
    const chip = fakeElement({
      tagName: 'span',
      attributes: { role: 'button' },
      text: '@机密同事',
    });
    const host = fakeElement({ tagName: 'x-mention', matches: false, shadow: [chip] });
    editorOf(['你好 ', host]);
    const { el, text } = clickEl([chip], chip);
    expect(el).toStrictEqual({ tagName: 'span', role: 'button', name: '', editable: true });
    expect(text).not.toContain('机密');
  });

  it('分配进影子编辑区插槽里的内容算编辑区里的字：外壳的名字跳过它', () => {
    const slot = fakeElement({ tagName: 'slot', matches: false });
    const typed = fakeElement({ tagName: 'p', matches: false, text: '机密插槽' });
    const host = fakeElement({
      tagName: 'x-slot',
      matches: false,
      shadow: [editorOf([slot])],
      children: [typed],
    });
    slotInto(typed, slot);
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['插槽卡片', host],
    });
    const { el, text } = clickEl([card], card);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '插槽卡片', editable: true });
    expect(text).not.toContain('机密');
  });

  it('分配进影子编辑区插槽里的链接，自己就身处编辑区：完全不从内容取名', () => {
    const slot = fakeElement({ tagName: 'slot', matches: false });
    const link = fakeElement({ tagName: 'a', attributes: { href: '#x' }, text: '机密插槽链接' });
    fakeElement({
      tagName: 'x-slot',
      matches: false,
      shadow: [editorOf([slot])],
      children: [link],
    });
    slotInto(link, slot);
    const { el } = clickEl([link], link);
    expect(el).toStrictEqual({ tagName: 'a', role: 'link', name: '', editable: true });
  });

  it('嵌套的开放影子根里的编辑区也算', () => {
    const inner = fakeElement({ tagName: 'x-inner', matches: false, shadow: [editorOf(['机密'])] });
    const outer = fakeElement({ tagName: 'x-outer', matches: false, shadow: [inner] });
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['套娃卡片', outer],
    });
    const { el } = clickEl([card], card);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '套娃卡片', editable: true });
  });

  it('开放影子根里的密码框同样让外壳带标记', () => {
    const password = fakeElement({ tagName: 'input', type: 'password', value: 'hunter2' });
    const field = fakeElement({ tagName: 'x-password', matches: false, shadow: [password] });
    const wrapper = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['登录 ', field],
    });
    const { el } = clickEl([wrapper], wrapper);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '登录', editable: true });
  });

  it('只因影子根带标记的元素，按干净名数同名时一定数得到它自己', () => {
    // 两张普通卡片正好也叫「插槽卡片」；目标卡片的原始 textContent 带着插槽里的字，与干净名不同。
    const plainA = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      text: '插槽卡片',
    });
    const plainB = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      text: '插槽卡片',
    });
    const slot = fakeElement({ tagName: 'slot', matches: false });
    const typed = fakeElement({ tagName: 'p', matches: false, text: '机密插槽' });
    const host = fakeElement({
      tagName: 'x-slot',
      matches: false,
      shadow: [editorOf([slot])],
      children: [typed],
    });
    slotInto(typed, slot);
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['插槽卡片', host],
    });
    const { el } = clickEl([plainA, plainB, card], card);
    expect(el).toStrictEqual({
      tagName: 'div',
      role: 'button',
      name: '插槽卡片',
      duplicates: 3,
      position: 3,
      editable: true,
    });
  });

  it('整份文档开着 designMode：处处都是编辑区，点哪里都不从内容取名', () => {
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      text: '卡片 机密设计模式',
    });
    const { el } = clickEl([card], card, { designMode: 'on' });
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '', editable: true });
  });

  it('aria-labelledby 指向编辑区里的一段字：那段字不算名字，退回按钮自己的文字', () => {
    const source = fakeElement({
      tagName: 'span',
      attributes: { id: 's' },
      matches: false,
      text: '机密标签源',
    });
    editorOf(['前文', source]);
    const send = fakeElement({
      tagName: 'button',
      attributes: { 'aria-labelledby': 's' },
      text: '发送',
    });
    const { el } = clickEl([send], send, { extra: [source] });
    // 原来的名字是那段字，里面没有「发送」，所以带 split。
    expect(el).toStrictEqual({
      tagName: 'button',
      role: 'button',
      name: '发送',
      editable: true,
      split: true,
    });
  });

  it('包着一次性验证码框的外壳带标记，载荷里没有验证码', () => {
    const code = fakeElement({
      tagName: 'input',
      type: 'text',
      value: '482913',
      attributes: { autocomplete: 'one-time-code' },
    });
    const wrapper = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['验证 ', code],
    });
    const { el, text } = clickEl([wrapper, code], wrapper);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '验证', editable: true });
    expect(text).not.toContain('482913');
  });

  it('包着密码框的外壳带标记，载荷里没有密码也没有它的长度', () => {
    const password = fakeElement({ tagName: 'input', type: 'password', value: 'hunter2hunter2' });
    const wrapper = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['登录 ', password],
    });
    const { el, text } = clickEl([wrapper, password], wrapper);
    expect(el).toStrictEqual({ tagName: 'div', role: 'button', name: '登录', editable: true });
    expect(text).not.toContain('hunter2');
  });

  it('aria-labelledby 指向密码框的按钮带标记', () => {
    const password = fakeElement({
      tagName: 'input',
      type: 'password',
      value: 'hunter2hunter2',
      attributes: { id: 'pw' },
    });
    const confirm = fakeElement({
      tagName: 'button',
      attributes: { 'aria-labelledby': 'pw' },
      text: '确定',
    });
    const { el } = clickEl([password, confirm], confirm);
    expect(el).toStrictEqual({ tagName: 'button', role: 'button', name: '确定', editable: true });
  });

  it('密码框自己被外面的 label 包着时不因此带标记：它的名字从不含自己的值', () => {
    const password = fakeElement({ tagName: 'input', type: 'password', value: 'hunter2' });
    const label = fakeElement({ tagName: 'label', matches: false, children: ['密码 ', password] });
    password.labels = [label];
    const { fire, payloads } = harness([password], { now: 1_000 });
    fire('focusin', { target: password });
    expect(payloads).toStrictEqual([
      {
        kind: 'secret',
        url: URL,
        index: 0,
        el: { tagName: 'input', role: 'textbox', name: '密码', inputType: 'password' },
        at: 1_000,
        otp: false,
      },
    ]);
  });

  it('同名计数那一圈不逐个找影子根：只有正在描述的元素摸一次子树', () => {
    // 目标卡片只因影子根里的编辑区带标记，另有三张同类卡片：计数时要给每张取名。
    const inner = fakeElement({
      tagName: 'x-ed',
      matches: false,
      shadow: [editorOf(['机密影子'])],
    });
    const target = fakeElement({
      tagName: 'div',
      attributes: { role: 'button' },
      children: ['卡片', inner],
    });
    const others = [1, 2, 3].map((n) =>
      fakeElement({ tagName: 'div', attributes: { role: 'button' }, text: `卡片${n}` }),
    );
    const { fire, payloads } = harness([...others, target], { now: 1_000 });
    fire('click', { target, button: 0 });
    expect(payloads[0]).toMatchObject({ el: { editable: true } });
    expect(deepScans).toHaveLength(1);
    expect(deepScans[0]).toBe(target);
    // 普通元素同理：只摸它自己，计数那一圈照旧按原来的名字比，一个影子根都不找。
    deepScans.length = 0;
    fire('click', { target: others[0], button: 0 });
    expect(deepScans).toHaveLength(1);
    expect(deepScans[0]).toBe(others[0]);
  });
});

// 以下为录制待办 Task 3 修订二：自己当标签的密码框、aria-owns、只按作者标签取名的角色，以及脚本到回放的整条链。
describe('修订二：名字来源与整条链', () => {
  const editorOf = (children: Array<FakeNode | string>, tagName = 'div', id?: string) =>
    fakeElement({
      tagName,
      attributes: { contenteditable: 'true', ...(id ? { id } : {}) },
      matches: false,
      children,
    });
  /** 点一下，返回那条 click 的 el；顺带核对整条载荷过得了 RawEventSchema。 */
  const clickEl = (elements: FakeNode[], target: FakeNode, options = {}) => {
    const { fire, payloads } = harness(elements, { now: 1_000, ...options });
    fire('click', { target, button: 0 });
    const click = payloads.find((p) => (p as { kind: string }).kind === 'click');
    expect(RawEventSchema.safeParse(click).success).toBe(true);
    return (click as { el: unknown }).el;
  };
  /** 一份 observe：行的写法与 observeElements 一致，指纹是 64 位十六进制。 */
  const observation = (
    rows: { role: string; name: string; tagName: string; fingerprint?: string }[],
  ): Observation => ({
    observationId: 'o',
    tabId: 'tab',
    documentEpoch: 1,
    elements: rows.map((row, i) => ({
      ref: {
        id: `r${i}`,
        tabId: 'tab',
        frameId: 'main',
        documentEpoch: 1,
        frameEpoch: 0,
        localFingerprint: row.fingerprint ?? `${i}`.padStart(64, 'e'),
      },
      role: row.role,
      name: row.name,
      disabled: false,
      tagName: row.tagName,
    })),
  });
  /** 脚本 → 采集：真脚本在假 DOM 上报出点击，采集层拿给定的 observe 把它写成日志里的一条。 */
  const logged = (
    elements: FakeNode[],
    target: FakeNode,
    observed: Observation,
    extra: FakeNode[] = [],
  ) => {
    const { fire, payloads } = harness(elements, { now: 1_000, extra });
    fire('click', { target, button: 0 });
    const click = payloads.find((p) => (p as { kind: string }).kind === 'click') as RawEvent;
    const capture = new RecordingCapture();
    capture.raw(click, observed);
    return capture.finish()[0] as unknown as { el: unknown; target: StepTarget };
  };
  const captured = (elements: FakeNode[], target: FakeNode, observed: Observation) =>
    logged(elements, target, observed).target;
  const fp = (head: string) => head.repeat(8).padEnd(64, '0');

  it('aria-labelledby 连自己也算进去的验证码框带标记：可访问名里的验证码不进日志', () => {
    const caption = fakeElement({
      tagName: 'span',
      attributes: { id: 'ol' },
      matches: false,
      text: '验证码',
    });
    const code = fakeElement({
      tagName: 'input',
      type: 'text',
      value: '482913',
      attributes: { id: 'otp', autocomplete: 'one-time-code', 'aria-labelledby': 'ol otp' },
    });
    expect(clickEl([code], code, { extra: [caption] })).toStrictEqual({
      tagName: 'input',
      role: 'textbox',
      name: '验证码',
      inputType: 'text',
      editable: true,
    });
    // 浏览器取名时读进框自己的值：打完码、页内地址一变就重新观察，那一行的名字是「验证码 482913」。
    const event = logged(
      [code],
      code,
      observation([{ role: 'textbox', name: '验证码 482913', tagName: 'input' }]),
      [caption],
    );
    expect(event.target).toStrictEqual({
      role: 'textbox',
      name: '',
      tagName: 'input',
      inputType: 'text',
      editable: true,
    });
    expect(JSON.stringify(event)).not.toContain('482913');
  });

  it('aria-labelledby 连自己也算进去的密码框同样带标记：名字里按位数排开的圆点不进日志', () => {
    const caption = fakeElement({
      tagName: 'span',
      attributes: { id: 'pl' },
      matches: false,
      text: '密码',
    });
    const password = fakeElement({
      tagName: 'input',
      type: 'password',
      value: 'hunter2hunter2',
      attributes: { id: 'pw', 'aria-labelledby': 'pl pw' },
    });
    expect(clickEl([password], password, { extra: [caption] })).toStrictEqual({
      tagName: 'input',
      role: 'textbox',
      name: '密码',
      inputType: 'password',
      editable: true,
    });
    const event = logged(
      [password],
      password,
      observation([{ role: 'textbox', name: '密码 ••••••••••••••', tagName: 'input' }]),
      [caption],
    );
    expect(event.target).toStrictEqual({
      role: 'textbox',
      name: '',
      tagName: 'input',
      inputType: 'password',
      editable: true,
    });
    expect(JSON.stringify(event)).not.toContain('•');
  });

  it('aria-owns 拥有别处的编辑区：外壳带标记，名字不含那段字，可访问名里的正文也不进日志', () => {
    const owned = editorOf(['机密拥有'], 'div', 'ed');
    const card = fakeElement({
      tagName: 'div',
      attributes: { role: 'button', 'aria-owns': 'ed' },
      text: '卡片',
    });
    expect(clickEl([card], card, { extra: [owned] })).toStrictEqual({
      tagName: 'div',
      role: 'button',
      name: '卡片',
      editable: true,
    });
    // 可访问性树把拥有的元素当成它的子节点，按内容取名时连编辑区里的字一起读。
    const event = logged(
      [card],
      card,
      observation([{ role: 'button', name: '卡片 机密拥有', tagName: 'div' }]),
      [owned],
    );
    expect(event.target).toStrictEqual({
      role: 'button',
      name: '',
      tagName: 'div',
      editable: true,
    });
    expect(JSON.stringify(event)).not.toContain('机密');
  });

  it('aria-owns 拥有别处的密码框：外壳同样带标记，圆点不进日志', () => {
    const password = fakeElement({
      tagName: 'input',
      type: 'password',
      value: 'hunter2hunter2',
      attributes: { id: 'pw' },
    });
    const wrapper = fakeElement({
      tagName: 'div',
      attributes: { role: 'button', 'aria-owns': 'pw' },
      text: '登录',
    });
    expect(clickEl([wrapper, password], wrapper)).toStrictEqual({
      tagName: 'div',
      role: 'button',
      name: '登录',
      editable: true,
    });
    const event = logged(
      [wrapper, password],
      wrapper,
      observation([
        { role: 'button', name: '登录 ••••••••••••••', tagName: 'div' },
        { role: 'textbox', name: '', tagName: 'input' },
      ]),
    );
    expect(event.target).toStrictEqual({
      role: 'button',
      name: '',
      tagName: 'div',
      editable: true,
    });
    expect(JSON.stringify(event)).not.toContain('•');
  });

  it('带标记的表单、对话框、应用外壳不从内容取名：这些角色的可访问名只来自作者给的标签', () => {
    const form = fakeElement({
      tagName: 'form',
      attributes: { role: 'form' },
      children: ['账号表单', fakeElement({ tagName: 'input', type: 'password' })],
    });
    const heading = fakeElement({ tagName: 'h2', matches: false, text: '登录' });
    const dialog = fakeElement({
      tagName: 'div',
      attributes: { role: 'dialog' },
      children: [heading, fakeElement({ tagName: 'input', type: 'password' })],
    });
    const shell = fakeElement({
      tagName: 'div',
      attributes: { role: 'application' },
      children: ['编辑器', editorOf(['机密'])],
    });
    expect(clickEl([form], form)).toStrictEqual({
      tagName: 'form',
      role: 'form',
      name: '',
      editable: true,
    });
    expect(clickEl([dialog], heading)).toStrictEqual({
      tagName: 'div',
      role: 'dialog',
      name: '',
      editable: true,
    });
    expect(clickEl([shell], shell)).toStrictEqual({
      tagName: 'div',
      role: 'application',
      name: '',
      editable: true,
    });
  });

  it('WAI-ARIA 1.2 从内容取名的十八种角色带标记时照旧取编辑区之外的字，别的角色只认作者给的标签', () => {
    const contentNamed = [
      'button',
      'cell',
      'checkbox',
      'columnheader',
      'gridcell',
      'heading',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'radio',
      'row',
      'rowheader',
      'switch',
      'tab',
      'tooltip',
      'treeitem',
    ];
    for (const role of contentNamed) {
      const wrapper = fakeElement({
        tagName: 'div',
        attributes: { role },
        children: ['标题', editorOf(['机密'])],
      });
      expect(clickEl([wrapper], wrapper)).toStrictEqual({
        tagName: 'div',
        role,
        name: '标题',
        editable: true,
      });
    }
    // 作者给的标签照用：title 在可访问性树里同样是名字。改动之前的路径不管角色、照样读内容，算出的
    // 「标题机密」里没有「作者标题」，所以带 split：采集层拿它与 observe 那一行比时，与改动之前一样对不上。
    for (const role of ['form', 'dialog', 'application', 'group', 'region']) {
      const wrapper = fakeElement({
        tagName: 'div',
        attributes: { role, title: '作者标题' },
        children: ['标题', editorOf(['机密'])],
      });
      expect(clickEl([wrapper], wrapper)).toStrictEqual({
        tagName: 'div',
        role,
        name: '作者标题',
        editable: true,
        split: true,
      });
    }
  });

  it('不带标记的表单、对话框照旧从内容取名，载荷与以前逐字节相同', () => {
    const search = fakeElement({
      tagName: 'form',
      attributes: { role: 'form' },
      children: ['搜索 ', fakeElement({ tagName: 'input', type: 'text' })],
    });
    const notice = fakeElement({
      tagName: 'div',
      attributes: { role: 'dialog' },
      text: '提示 已保存',
    });
    const { fire, raw } = harness([search, notice], { now: 1_000 });
    fire('click', { target: search, button: 0 });
    fire('click', { target: notice, button: 0 });
    expect(raw).toEqual([
      '{"kind":"click","url":"https://report.example.com/login","index":0,"el":{"tagName":"form","role":"form","name":"搜索"},"at":1000}',
      '{"kind":"click","url":"https://report.example.com/login","index":1,"el":{"tagName":"div","role":"dialog","name":"提示 已保存"},"at":1000}',
    ]);
  });

  // 审查里的两种卡片：observe 时页面上只有卡片 B、它的编辑区还是空的；之后在它前面插进同标题的新卡片 A，
  // 人在 A 里打了字再点 A。B 那一行的名字正好等于 A 的干净名。
  const cards = [
    {
      shape: '标题后面接块级编辑区',
      build: (typed: string[]) =>
        fakeElement({
          tagName: 'div',
          attributes: { role: 'button' },
          children: [
            fakeElement({ tagName: 'span', matches: false, text: '无标题' }),
            editorOf(typed),
          ],
        }),
      staleName: '无标题',
    },
    {
      shape: '标题与徽标之间夹着行内编辑区',
      build: (typed: string[]) =>
        fakeElement({
          tagName: 'div',
          attributes: { role: 'button' },
          children: [
            fakeElement({ tagName: 'span', matches: false, text: '无标题' }),
            editorOf(typed, 'span'),
            fakeElement({ tagName: 'span', matches: false, text: '草稿' }),
          ],
        }),
      staleName: '无标题草稿',
    },
  ];
  for (const { shape, build, staleName } of cards) {
    it(`同名计数与 observe 对不上就扣下（${shape}）：回放不会点到旧卡片`, () => {
      const cardA = build(['机密C']);
      const cardB = build([]);
      const stale = observation([
        { role: 'button', name: staleName, tagName: 'div', fingerprint: fp('b0') },
      ]);
      const target = captured([cardA, cardB], cardA, stale);
      const replay = observation([
        { role: 'button', name: `${staleName} 机密C`, tagName: 'div', fingerprint: fp('a0') },
        { role: 'button', name: staleName, tagName: 'div', fingerprint: fp('b0') },
      ]);
      expect(resolveTarget(target, replay)).toEqual({
        ok: false,
        reason: 'NO_MATCH',
        candidates: 0,
      });
      expect(target).toStrictEqual({ role: 'button', name: '', tagName: 'div', editable: true });
    });
  }

  it('同标题卡片换了先后、个数没变：序号上那一行是另一张卡片，名字相等也照样扣下', () => {
    // 加载时取的 observe：A 在前、B 在后，行内编辑区都还空着，两行同名。人在 B 里打了字，列表按最后编辑
    // 时间重排，B 排到了 A 前面；地址没变，observe 没有重取。B 的序号上那一行成了 A，同名的仍是两张，
    // 个数那道关拦不住。改动之前名字带着打的字，与那一行对不上，回放停在这一步。
    const cardA = cards[1].build([]);
    const cardB = cards[1].build(['机密C']);
    const stale = observation([
      { role: 'button', name: '无标题草稿', tagName: 'div', fingerprint: fp('a0') },
      { role: 'button', name: '无标题草稿', tagName: 'div', fingerprint: fp('b0') },
    ]);
    const { el, target } = logged([cardB, cardA], cardB, stale);
    const replay = observation([
      { role: 'button', name: '无标题 机密C 草稿', tagName: 'div', fingerprint: fp('b0') },
      { role: 'button', name: '无标题草稿', tagName: 'div', fingerprint: fp('a0') },
    ]);
    expect(resolveTarget(target, replay)).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 0 });
    expect(target).toStrictEqual({ role: 'button', name: '', tagName: 'div', editable: true });
    // 页面只多报一位：打的字把干净名在原来的名字里隔断了。原来的名字带着打的字，不出页面。
    expect(el).toStrictEqual({
      tagName: 'div',
      role: 'button',
      name: '无标题草稿',
      duplicates: 2,
      position: 1,
      editable: true,
      split: true,
    });
  });

  it('两张同标题卡片都在 observe 里、编辑区都还空着：个数对得上，照常用那一行', () => {
    const cardA = cards[0].build([]);
    const cardB = cards[0].build([]);
    const fresh = observation([
      { role: 'button', name: '无标题', tagName: 'div', fingerprint: fp('a0') },
      { role: 'button', name: '无标题', tagName: 'div', fingerprint: fp('b0') },
    ]);
    const target = captured([cardA, cardB], cardB, fresh);
    expect(target).toStrictEqual({
      role: 'button',
      name: '无标题',
      tagName: 'div',
      nth: 2,
      fingerprint: 'b0b0b0b0',
    });
    expect(resolveTarget(target, fresh)).toMatchObject({ ok: true, ref: { id: 'r1' } });
  });

  it('带标记的 role="form" 登录表单，可访问名是空串：目标与改动前一样，回放照常点到它', () => {
    const password = fakeElement({ tagName: 'input', type: 'password' });
    const form = fakeElement({
      tagName: 'form',
      attributes: { role: 'form' },
      children: ['账号表单', password],
    });
    const observed = observation([
      { role: 'form', name: '', tagName: 'form', fingerprint: fp('f0') },
      { role: 'textbox', name: '', tagName: 'input' },
    ]);
    const target = captured([form, password], form, observed);
    expect(target).toStrictEqual({
      role: 'form',
      name: '',
      tagName: 'form',
      fingerprint: 'f0f0f0f0',
    });
    expect(resolveTarget(target, observed)).toMatchObject({ ok: true, ref: { id: 'r0' } });
  });

  it('没有名字的 role="dialog" 登录弹窗，点在它的标题上：目标与改动前一样，回放照常点到它', () => {
    const heading = fakeElement({ tagName: 'h2', matches: false, text: '登录' });
    const password = fakeElement({ tagName: 'input', type: 'password' });
    const dialog = fakeElement({
      tagName: 'div',
      attributes: { role: 'dialog' },
      children: [heading, password],
    });
    const observed = observation([
      { role: 'dialog', name: '', tagName: 'div', fingerprint: fp('d0') },
      { role: 'textbox', name: '', tagName: 'input' },
    ]);
    const target = captured([dialog, password], heading, observed);
    expect(target).toStrictEqual({
      role: 'dialog',
      name: '',
      tagName: 'div',
      fingerprint: 'd0d0d0d0',
    });
    expect(resolveTarget(target, observed)).toMatchObject({ ok: true, ref: { id: 'r0' } });
  });

  it('页面上两个没有名字的表单：两边的点击都与改动前一样，空名不做同名计数的比对', () => {
    const password = fakeElement({ tagName: 'input', type: 'password' });
    const login = fakeElement({
      tagName: 'form',
      attributes: { role: 'form' },
      children: ['账号', password],
    });
    const query = fakeElement({ tagName: 'input', type: 'text' });
    const search = fakeElement({
      tagName: 'form',
      attributes: { role: 'form' },
      children: ['搜索', query],
    });
    const observed = observation([
      { role: 'form', name: '', tagName: 'form', fingerprint: fp('f1') },
      { role: 'textbox', name: '', tagName: 'input' },
      { role: 'form', name: '', tagName: 'form', fingerprint: fp('f2') },
      { role: 'textbox', name: '', tagName: 'input' },
    ]);
    const elements = [login, password, search, query];
    expect(captured(elements, login, observed)).toStrictEqual({
      role: 'form',
      name: '',
      tagName: 'form',
      nth: 1,
      fingerprint: 'f1f1f1f1',
    });
    expect(captured(elements, search, observed)).toStrictEqual({
      role: 'form',
      name: '',
      tagName: 'form',
      nth: 2,
      fingerprint: 'f2f2f2f2',
    });
  });
});
