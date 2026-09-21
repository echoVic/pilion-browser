import { describe, expect, it } from 'vitest';
import {
  buildDistillPrompt,
  extractSkillMarkdown,
  reconcile,
  renderEvents,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
  type LoggedEvent,
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
const agree: Step = {
  kind: 'check',
  onUrl: DASH,
  target: { role: 'checkbox', name: '同意', tagName: 'input', inputType: 'checkbox' },
  checked: true,
};
const submit: Step = {
  kind: 'press',
  onUrl: DASH,
  target: { role: 'textbox', name: '备注', tagName: 'textarea' },
  key: 'Enter',
  modifiers: ['Shift'],
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
    { kind: 'step', at: 't10', step: agree },
    { kind: 'step', at: 't11', step: submit },
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

  it('借用另一个元素的指纹会被判成没有依据', () => {
    const withFingerprint: Step = {
      ...login,
      target: { ...login.target, fingerprint: 'a1b2c3d4' },
    };
    expect(reconcile(skillWith([withFingerprint]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'NO_EVIDENCE',
    });
  });

  it('伪造 nth 也会被判成没有依据', () => {
    expect(
      reconcile(skillWith([{ ...login, target: { ...login.target, nth: 2 } }]), trajectory),
    ).toEqual({ ok: false, step: 1, reason: 'NO_EVIDENCE' });
  });

  it('同名不同角色不算同一目标', () => {
    const asLink: Step = { ...login, target: { ...login.target, role: 'link', tagName: 'a' } };
    expect(reconcile(skillWith([asLink]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'NO_EVIDENCE',
    });
  });

  it('check 与 press 的值也受第二条对账约束', () => {
    expect(reconcile(skillWith([agree, submit]), trajectory)).toEqual({ ok: true });
    expect(reconcile(skillWith([{ ...agree, checked: false }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
    expect(reconcile(skillWith([{ ...submit, key: 'Tab' }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
    });
    expect(reconcile(skillWith([{ ...submit, modifiers: [] }]), trajectory)).toEqual({
      ok: false,
      step: 1,
      reason: 'VALUE_CHANGED',
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

  it('stepsHash 不受对象键顺序影响', () => {
    const a: Step = {
      kind: 'click',
      onUrl: LOGIN,
      target: { role: 'button', name: '登录', tagName: 'button' },
    };
    const b = {
      target: { tagName: 'button', name: '登录', role: 'button' },
      onUrl: LOGIN,
      kind: 'click',
    } as Step;
    expect(stepsHash([a])).toBe(stepsHash([b]));
  });
});

// ---- Task 7：renderEvents 用的事件夹具，跟上面 Step/Trajectory 那组各自独立 ----
const EVENT_URL = 'https://events.example.com/';
const buttonEl = { tagName: 'button', role: 'button', name: '按钮' };
const buttonTarget = { role: 'button', name: '按钮', tagName: 'button' };
const fieldEl = { tagName: 'input', role: 'textbox', name: '备注', inputType: 'text' };
const fieldTarget = { role: 'textbox', name: '备注', tagName: 'input', inputType: 'text' };
const secretEl = { tagName: 'input', role: 'textbox', name: '密码', inputType: 'password' };
const secretTarget = { role: 'textbox', name: '密码', tagName: 'input', inputType: 'password' };
const richTextEl = { tagName: 'div', role: 'generic', name: '' };
const richTextTarget = { role: 'generic', name: '', tagName: 'div' };

const EVENT_BASE_MS = Date.UTC(2026, 8, 21, 12, 0, 0);
let eventSeq = 0;
/** 按调用顺序单调递增，间隔远小于 3 秒的停顿阈值；具体数值与断言无关，只求递增且不触发停顿。 */
function stampedFields(): { seq: number; at: string; pageAt: number } {
  eventSeq += 1;
  const offset = eventSeq * 300;
  return { seq: eventSeq, at: new Date(EVENT_BASE_MS + offset).toISOString(), pageAt: offset };
}

function scroll(n: number): LoggedEvent {
  const { seq, at } = stampedFields();
  return { kind: 'scroll', seq, at, url: EVENT_URL, x: 0, y: n * 100 };
}

function input(index: number, value: string): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'input',
    seq,
    at,
    url: EVENT_URL,
    index,
    el: fieldEl,
    target: fieldTarget,
    pageAt,
    value,
    ambiguous: false,
  };
}

function secret(index: number, otp: boolean): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'secret',
    seq,
    at,
    url: EVENT_URL,
    index,
    el: secretEl,
    target: secretTarget,
    pageAt,
    otp,
    ambiguous: false,
  };
}

function edit(length: number): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'edit',
    seq,
    at,
    url: EVENT_URL,
    index: -1,
    el: richTextEl,
    target: richTextTarget,
    pageAt,
    length,
    ambiguous: false,
  };
}

/** time 是当天的 `HH:mm:ss`；seq 只用来给同一时刻的大量事件区分序号，不影响间隔判断。 */
function clickAt(time: string, seq = 1): LoggedEvent {
  return {
    kind: 'click',
    seq,
    at: `2026-09-21T${time}.000Z`,
    url: EVENT_URL,
    index: 1,
    el: buttonEl,
    target: buttonTarget,
    pageAt: seq,
    ambiguous: false,
  };
}

function clickNamed(name: string): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'click',
    seq,
    at,
    url: EVENT_URL,
    index: 1,
    el: { tagName: 'button', role: 'button', name },
    target: { role: 'button', name, tagName: 'button' },
    pageAt,
    ambiguous: false,
  };
}

function unsupportedEvent(
  reason: 'iframe' | 'out-of-scope' | 'gesture',
  el?: { tagName: string; role: string; name: string },
): LoggedEvent {
  const { seq, at } = stampedFields();
  return { kind: 'unsupported', seq, at, url: EVENT_URL, reason, ...(el ? { el } : {}) };
}

function navigateEvent(cause: 'address' | 'back' | 'forward' | 'reload'): LoggedEvent {
  const { seq, at } = stampedFields();
  return { kind: 'navigate', seq, at, url: EVENT_URL, cause };
}

function pageEvent(title: string): LoggedEvent {
  const { seq, at } = stampedFields();
  return { kind: 'page', seq, at, url: EVENT_URL, title, text: '' };
}

function noteEvent(text: string): LoggedEvent {
  const { seq, at } = stampedFields();
  return { kind: 'note', seq, at, text };
}

function pointerEvent(): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'pointer',
    seq,
    at,
    url: EVENT_URL,
    index: 1,
    el: buttonEl,
    target: buttonTarget,
    pageAt,
    ambiguous: false,
  };
}

function selectEvent(value: string): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'select',
    seq,
    at,
    url: EVENT_URL,
    index: 2,
    el: { tagName: 'select', role: 'combobox', name: '月份' },
    target: { role: 'combobox', name: '月份', tagName: 'select' },
    pageAt,
    value,
    ambiguous: false,
  };
}

function checkEvent(checked: boolean): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'check',
    seq,
    at,
    url: EVENT_URL,
    index: 3,
    el: { tagName: 'input', role: 'checkbox', name: '同意', inputType: 'checkbox' },
    target: { role: 'checkbox', name: '同意', tagName: 'input', inputType: 'checkbox' },
    pageAt,
    checked,
    ambiguous: false,
  };
}

function keyEvent(key: 'Enter' | 'Tab', shift: boolean): LoggedEvent {
  const { seq, at, pageAt } = stampedFields();
  return {
    kind: 'key',
    seq,
    at,
    url: EVENT_URL,
    index: 4,
    el: fieldEl,
    target: fieldTarget,
    pageAt,
    key,
    shift,
    ambiguous: false,
  };
}

describe('renderEvents', () => {
  it('连续滚动折叠成一行', () => {
    const text = renderEvents([scroll(1), scroll(2), scroll(3)]);
    expect(text).toContain('滚动了 3 次');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('同一字段的连续输入只留最终值并注明改了几次', () => {
    const text = renderEvents([input(1, '张'), input(1, '张三'), input(1, '张三丰')]);
    expect(text).toContain('张三丰');
    expect(text).toContain('改了 3 次');
    expect(text).not.toContain('"张"');
  });

  it('超过三秒的间隔插一行停顿', () => {
    const text = renderEvents([clickAt('12:00:00'), clickAt('12:00:09')]);
    expect(text).toContain('停顿 9 秒');
  });

  it('总行数封顶，中间折叠', () => {
    const many = Array.from({ length: 800 }, (_, n) => clickAt('12:00:00', n + 1));
    const lines = renderEvents(many, 300).trim().split('\n');
    expect(lines).toHaveLength(301); // 150 + 省略行 + 150
    expect(lines[150]).toContain('省略');
  });

  it('密码事件只说填了密码，不带任何值', () => {
    expect(renderEvents([secret(1, false)])).toContain('填写密码');
  });
});

describe('renderEvents 覆盖其余事件种类与边界', () => {
  it('验证码事件照实说验证码', () => {
    expect(renderEvents([secret(1, true)])).toContain('填写验证码');
  });

  it('富文本只报字数，不把字数当成引号里的值', () => {
    const text = renderEvents([edit(9)]);
    expect(text).toContain('输入了 9 个字');
    expect(text).not.toContain('"9"');
  });

  it('目标没有可访问名字时退回标签名，不留空引号', () => {
    const text = renderEvents([clickNamed('')]);
    expect(text).toContain('"button"');
    expect(text).not.toContain('""');
  });

  it('unsupported 复用现有三种原因的说法', () => {
    expect(renderEvents([unsupportedEvent('iframe')])).toContain('手动完成内嵌框架里的操作');
    expect(
      renderEvents([
        unsupportedEvent('gesture', { tagName: 'div', role: 'generic', name: '卡片' }),
      ]),
    ).toContain('手动完成在 "卡片" 上的拖拽或右键操作');
    expect(
      renderEvents([
        unsupportedEvent('out-of-scope', { tagName: 'span', role: 'generic', name: '' }),
      ]),
    ).toContain('手动点击 "span"');
  });

  it('navigate 带上来源的中文说法', () => {
    expect(renderEvents([navigateEvent('address')])).toContain('地址栏');
    expect(renderEvents([navigateEvent('back')])).toContain('后退');
    expect(renderEvents([navigateEvent('forward')])).toContain('前进');
    expect(renderEvents([navigateEvent('reload')])).toContain('刷新');
  });

  it('间隔不到三秒不插停顿行', () => {
    const text = renderEvents([clickAt('12:00:00'), clickAt('12:00:02', 2)]);
    expect(text).not.toContain('停顿');
  });

  it('行数没超上限时原样返回，不出现省略行', () => {
    const text = renderEvents([clickAt('12:00:00')]);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).not.toContain('省略');
  });

  it('页面、备注、按下、选择、勾选、按键各给一句人话', () => {
    expect(renderEvents([pageEvent('仪表盘')])).toContain('仪表盘');
    expect(renderEvents([pageEvent('')])).toBe(`- 打开页面 ${EVENT_URL}`);
    expect(renderEvents([noteEvent('等表格出现')])).toBe('- 备注：等表格出现');
    expect(renderEvents([pointerEvent()])).toContain('按下 "按钮"');
    expect(renderEvents([selectEvent('2026-09')])).toContain('选择 "月份" = "2026-09"');
    expect(renderEvents([checkEvent(true)])).toContain('勾选 "同意"');
    expect(renderEvents([checkEvent(false)])).toContain('取消勾选 "同意"');
    expect(renderEvents([keyEvent('Enter', true)])).toContain('按键 Shift+Enter 于 "备注"');
  });
});

/**
 * Phase 3 之前 buildDistillPrompt('月度导出', '轨迹原文') 的完整输出，逐字节从当前实现复制而来。
 * 不给 process 参数时必须继续原样吐出这段文本，谁改了固定说明都会被这条测试拦住。
 */
const PROMPT_BEFORE_PHASE_3 =
  '下面是我在浏览器里录制的一段操作轨迹「月度导出」。请把它提炼成一份可复用的技能文档。\n\n只输出一个 Markdown 文档，不要输出其它内容，也不要调用任何工具。文档结构：\n1. `# 月度导出`\n2. `## 什么时候用`：一两句话，写清楚什么情况下该用这份技能\n3. `## 前置条件`：列表，例如需要已登录哪个站点、页面要处于什么状态\n4. `## 已知坑`：列表，轨迹里看得出的陷阱；没有就写「- 无」\n5. 一个 ```json pilion-skill 代码块，内容是 { "meta": { "about": "<一句话说明>" }, "steps": [ … ] }\n\n步骤规则：\n- 步骤只能从轨迹的 pilion-trajectory 代码块里挑选、合并、重排；不得新增任何动作，也不得改写目标\n- 不得改写人输入过的值；需要隐去的值（邮箱、姓名等）改成 {{说明}} 形式的占位符\n- 可以插入 { "kind": "human", "onUrl": "...", "reason": "..." } 说明哪一步要人来做，也可以插入 { "kind": "note", "text": "..." }\n- 删掉误点和无意义的步骤；散文里不要复述步骤\n\n轨迹原文：\n\n轨迹原文';

describe('buildDistillPrompt 带过程', () => {
  it('过程放在轨迹原文之后，并说明它只是上下文', () => {
    const prompt = buildDistillPrompt('月度导出', '轨迹原文', '过程原文');
    expect(prompt.indexOf('过程原文')).toBeGreaterThan(prompt.indexOf('轨迹原文'));
    expect(prompt).toContain('步骤仍然只能从 pilion-trajectory 代码块里挑选');
  });

  it('不给过程时与今天一字不差', () => {
    expect(buildDistillPrompt('月度导出', '轨迹原文')).toBe(PROMPT_BEFORE_PHASE_3);
  });
});
