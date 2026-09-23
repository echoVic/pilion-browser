import { describe, expect, it, vi } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import type { ToolName } from '../src/shared/contracts';
import { MAX_URL_LENGTH, playSteps, samePage, type Step } from '../src/main/recording/index';

const LOGIN = 'https://report.example.com/login';
const DASH = 'https://report.example.com/dashboard';

function ref(id: string): ElementRef {
  return {
    id,
    tabId: 'tab',
    frameId: 'main',
    documentEpoch: 1,
    frameEpoch: 0,
    localFingerprint: 'f'.repeat(64),
  };
}
function obs(rows: { id: string; role: string; name: string; tagName: string }[]): Observation {
  return {
    observationId: 'o',
    tabId: 'tab',
    documentEpoch: 1,
    elements: rows.map((row) => ({
      ref: ref(row.id),
      role: row.role,
      name: row.name,
      disabled: false,
      tagName: row.tagName,
    })),
  };
}

/** 一个会"跟着操作走"的假浏览器：navigate 换页，点击「登录」跳到 dashboard。 */
function fakeBrowser() {
  let url = 'about:blank';
  let loading = false;
  const calls: { name: ToolName; args: Record<string, unknown> }[] = [];
  const pages: Record<string, Observation> = {
    [LOGIN]: obs([
      { id: 'email', role: 'textbox', name: '邮箱', tagName: 'input' },
      { id: 'login', role: 'button', name: '登录', tagName: 'button' },
    ]),
    [DASH]: obs([
      { id: 'month', role: 'combobox', name: '月份', tagName: 'select' },
      { id: 'export', role: 'button', name: '导出 CSV', tagName: 'button' },
    ]),
  };
  const execute = vi.fn(async (name: ToolName, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'browser.snapshot')
      return { url, title: url === LOGIN ? '登录' : '仪表盘', loading };
    if (name === 'browser.navigate') {
      url = String(args.url);
      loading = false;
      return { url };
    }
    if (name === 'browser.observe') return pages[url] ?? obs([]);
    if (name === 'browser.click') {
      if ((args.elementRef as ElementRef).id === 'login') {
        url = DASH;
        loading = true;
        setTimeout(() => (loading = false), 5);
      }
      return { ok: true };
    }
    return { ok: true };
  });
  return { execute, calls, current: () => url };
}

const steps: Step[] = [
  { kind: 'navigate', url: LOGIN },
  {
    kind: 'type',
    onUrl: LOGIN,
    target: { role: 'textbox', name: '邮箱', tagName: 'input' },
    text: 'me@x.com',
    replace: true,
  },
  { kind: 'note', text: '公司邮箱' },
  { kind: 'click', onUrl: LOGIN, target: { role: 'button', name: '登录', tagName: 'button' } },
  {
    kind: 'select',
    onUrl: DASH,
    target: { role: 'combobox', name: '月份', tagName: 'select' },
    value: '2026-09',
  },
  { kind: 'click', onUrl: DASH, target: { role: 'button', name: '导出 CSV', tagName: 'button' } },
];
// 用真的定时器而不是立即 resolve：假浏览器靠 setTimeout 把 loading 翻回 false，纯微任务循环会饿死它。
const fast = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1))),
  settleMs: 200,
};

describe('samePage', () => {
  it('比 origin 与 path，忽略 query、hash 与末尾斜杠', () => {
    expect(samePage('https://a.com/x?y=1#z', 'https://a.com/x/')).toBe(true);
    expect(samePage('https://a.com/x', 'https://a.com/y')).toBe(false);
    expect(samePage('https://a.com/', 'https://b.com/')).toBe(false);
    expect(samePage('not a url', 'https://a.com/')).toBe(false);
  });
});

describe('playSteps', () => {
  it('全程成功：每个动作前先 observe，把匹配到的 ref 原样交回', async () => {
    const browser = fakeBrowser();
    const progress: number[] = [];
    const outcome = await playSteps(steps, {
      execute: browser.execute,
      ...fast,
      onProgress: (step) => progress.push(step),
    });
    expect(outcome).toEqual({ ok: true, steps: 6, finalUrl: DASH });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    const names = browser.calls.map((call) => call.name);
    expect(names.filter((name) => name === 'browser.observe')).toHaveLength(4);
    const typeCall = browser.calls.find((call) => call.name === 'browser.type')!;
    expect(typeCall.args).toEqual({ elementRef: ref('email'), text: 'me@x.com', replace: true });
    const selectCall = browser.calls.find((call) => call.name === 'browser.select')!;
    expect(selectCall.args).toMatchObject({ elementRef: ref('month'), value: '2026-09' });
  });

  it('页面不对时停下并报 WRONG_PAGE，附上剩余步骤', async () => {
    const browser = fakeBrowser();
    const outcome = await playSteps(steps.slice(1), { execute: browser.execute, ...fast });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'WRONG_PAGE',
      failedAt: 1,
      step: '输入 "邮箱" = "me@x.com"',
      url: 'about:blank',
      remaining: [
        '备注：公司邮箱',
        '点击 "登录"（button）',
        '选择 "月份" = "2026-09"',
        '点击 "导出 CSV"（button）',
      ],
    });
  });

  it('找不到目标时报 NO_MATCH 并停在那一步', async () => {
    const browser = fakeBrowser();
    const renamed: Step[] = [
      steps[0],
      { ...steps[3], target: { role: 'button', name: '进入', tagName: 'button' } } as Step,
    ];
    const outcome = await playSteps(renamed, { execute: browser.execute, ...fast });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'NO_MATCH',
      failedAt: 2,
      step: '点击 "进入"（button）',
      url: LOGIN,
      title: '登录',
    });
  });

  it('需要人的步骤返回 HUMAN 与位置，不再继续', async () => {
    const browser = fakeBrowser();
    const withHuman: Step[] = [
      steps[0],
      { kind: 'human', onUrl: LOGIN, reason: '填写密码' },
      steps[3],
    ];
    const outcome = await playSteps(withHuman, { execute: browser.execute, ...fast });
    expect(outcome).toEqual({
      ok: false,
      reason: 'HUMAN',
      at: 2,
      step: '需要我：填写密码',
      humanReason: '填写密码',
      url: LOGIN,
      title: '登录',
    });
    expect(browser.calls.some((call) => call.name === 'browser.click')).toBe(false);
  });

  it('占位符步骤视为需要人：不执行，返回 HUMAN 并说明填什么', async () => {
    const browser = fakeBrowser();
    const withPlaceholder: Step[] = [
      steps[0],
      { ...(steps[1] as Extract<Step, { kind: 'type' }>), text: '{{公司邮箱}}' },
      steps[3],
    ];
    const outcome = await playSteps(withPlaceholder, { execute: browser.execute, ...fast });
    expect(outcome).toEqual({
      ok: false,
      reason: 'HUMAN',
      at: 2,
      step: '输入 "邮箱" = "{{公司邮箱}}"',
      humanReason: '填写 "邮箱"：公司邮箱',
      url: LOGIN,
      title: '登录',
    });
    expect(browser.calls.some((call) => call.name === 'browser.type')).toBe(false);
  });

  it('地址长度到了上限的导航不去打开：可能是录制时截短的，与截断过的导航一样交给人', async () => {
    // 提炼出的技能可以从不带截断标记的页面条目里取来这样一条导航。
    const browser = fakeBrowser();
    const clamped = `${DASH}?q=${'x'.repeat(MAX_URL_LENGTH - DASH.length - 3)}`;
    expect(clamped).toHaveLength(MAX_URL_LENGTH);
    const outcome = await playSteps([steps[0], { kind: 'navigate', url: clamped }, steps[3]], {
      execute: browser.execute,
      ...fast,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'HUMAN',
      at: 2,
      step: `打开 ${clamped}`,
      humanReason: '手动打开录制时的那个地址：地址太长，回放无法原样还原',
      url: LOGIN,
      title: '登录',
    });
    expect(browser.calls.filter((call) => call.name === 'browser.navigate')).toHaveLength(1);
    // 短一个字就照常打开。
    const shorter = clamped.slice(0, -1);
    const played = await playSteps([{ kind: 'navigate', url: shorter }], {
      execute: browser.execute,
      ...fast,
    });
    expect(played).toEqual({ ok: true, steps: 1, finalUrl: shorter });
  });

  it('fromStep 从中间续播，不重跑前面', async () => {
    const browser = fakeBrowser();
    await browser.execute('browser.navigate', { url: DASH });
    browser.calls.length = 0;
    const outcome = await playSteps(steps, { execute: browser.execute, ...fast, fromStep: 5 });
    expect(outcome).toEqual({ ok: true, steps: 6, finalUrl: DASH });
    expect(browser.calls.some((call) => call.name === 'browser.navigate')).toBe(false);
    expect(browser.calls.filter((call) => call.name === 'browser.click')).toHaveLength(1);
  });

  it('取消信号让回放停下并报 CANCELLED', async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    const execute: typeof browser.execute = vi.fn(async (name, args) => {
      if (name === 'browser.type') controller.abort();
      return browser.execute(name, args);
    });
    const outcome = await playSteps(steps, { execute, ...fast, signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, reason: 'CANCELLED', failedAt: 3 });
  });

  it('执行动作抛错时报 EFFECT_FAILED 并带上错误信息', async () => {
    const browser = fakeBrowser();
    const execute: typeof browser.execute = vi.fn(async (name, args) => {
      if (name === 'browser.type') throw new Error('STALE_ELEMENT: Element identity changed');
      return browser.execute(name, args);
    });
    const outcome = await playSteps(steps, { execute, ...fast });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'EFFECT_FAILED',
      failedAt: 2,
      message: expect.stringContaining('STALE_ELEMENT'),
    });
  });

  it('点击后等页面加载完再做下一步', async () => {
    const browser = fakeBrowser();
    const outcome = await playSteps(steps, {
      execute: browser.execute,
      settleMs: 200,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(outcome.ok).toBe(true);
    const order = browser.calls.map((call) => call.name);
    const clickIndex = order.indexOf('browser.click');
    expect(order.slice(clickIndex + 1, clickIndex + 3)).toEqual([
      'browser.snapshot',
      'browser.snapshot',
    ]);
  });

  it('总预算耗尽报 TIMEOUT', async () => {
    const browser = fakeBrowser();
    let now = 0;
    const outcome = await playSteps(steps, {
      execute: browser.execute,
      ...fast,
      budgetMs: 100,
      now: () => (now += 60),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'TIMEOUT' });
  });

  it('observe 抛错时返回 EFFECT_FAILED 而不是 reject', async () => {
    const browser = fakeBrowser();
    const execute: typeof browser.execute = vi.fn(async (name, args) => {
      if (name === 'browser.observe') throw new Error('observe down');
      return browser.execute(name, args);
    });
    await expect(playSteps(steps, { execute, ...fast })).resolves.toMatchObject({
      ok: false,
      reason: 'EFFECT_FAILED',
      failedAt: 2,
      message: expect.stringContaining('observe down'),
    });
  });

  it('给了 probe 就不再用 execute 问页面状态', async () => {
    const browser = fakeBrowser();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      const url = browser.current();
      return { url, title: url === LOGIN ? '登录' : '仪表盘', loading: false };
    };
    const outcome = await playSteps(steps, { execute: browser.execute, ...fast, probe });
    expect(outcome).toEqual({ ok: true, steps: 6, finalUrl: DASH });
    expect(probes).toBeGreaterThan(0);
    expect(browser.calls.some((call) => call.name === 'browser.snapshot')).toBe(false);
  });

  it('settle 期间按停止立刻让出，不等满 settleMs', async () => {
    const browser = fakeBrowser();
    await browser.execute('browser.navigate', { url: LOGIN });
    const controller = new AbortController();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      // 第一次是点击前的页面断言；第二次是 settle 的第一轮，这时人按下了停止。
      if (probes === 2) controller.abort();
      return { url: LOGIN, title: '登录', loading: true };
    };
    const started = Date.now();
    const outcome = await playSteps([steps[3], steps[3]], {
      execute: browser.execute,
      probe,
      signal: controller.signal,
      settleMs: 5_000,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1))),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'CANCELLED', failedAt: 2 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('settle 受总预算约束，不会为等待加载而超支', async () => {
    const browser = fakeBrowser();
    let now = 0;
    const outcome = await playSteps(steps, {
      execute: browser.execute,
      ...fast,
      settleMs: 10_000,
      budgetMs: 100,
      now: () => (now += 60),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'TIMEOUT' });
    // 没有预算约束时 settle 会为了凑满 10 秒轮询上百次 snapshot。
    expect(browser.calls.filter((call) => call.name === 'browser.snapshot').length).toBeLessThan(5);
  });
});
