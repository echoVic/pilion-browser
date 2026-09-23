import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import { RecordingCapture } from '../src/main/recording/capture';
import { LoggedEventSchema, MAX_URL_LENGTH, type RawEvent } from '../src/main/recording/types';

// 以下夹具搬自 tests/recording-recorder.test.ts，只给下面这组目标解析用例用。
const TARGET_URL = 'https://report.example.com/login';
const button = { tagName: 'button', role: 'button', name: '登录' };
function targetClick(index: number, el = button): RawEvent {
  return { kind: 'click', url: TARGET_URL, index, el, at: 1_000 };
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

// 本组用例从 tests/recording-recorder.test.ts 搬来：断言含义不变，
// 只把「读 recorder.finish().entries[i].step.target」改成「读 capture.finish()[i].target」。
describe('RecordingCapture 目标解析（搬自 recording-recorder.test.ts）', () => {
  it('对上预取的 observe 时用它那一行取词，并带上指纹与 nth', () => {
    const capture = new RecordingCapture();
    const obs = observed([
      { role: 'button', name: '查看', tagName: 'button' },
      { role: 'button', name: '查看', tagName: 'button', fingerprint: 'abcd1234' + '0'.repeat(56) },
    ]);
    capture.raw(targetClick(1, { tagName: 'button', role: 'button', name: '看' }), obs);
    const [event] = capture.finish();
    expect(event).toMatchObject({
      kind: 'click',
      target: { role: 'button', name: '查看', tagName: 'button', nth: 2, fingerprint: 'abcd1234' },
      ambiguous: true,
    });
  });

  it('observe 行的 tagName 对不上时退回脚本描述', () => {
    const capture = new RecordingCapture();
    const obs = observed([{ role: 'link', name: '首页', tagName: 'a' }]);
    capture.raw(targetClick(0, button), obs);
    expect(capture.finish()[0]).toMatchObject({
      target: { role: 'button', name: '登录', tagName: 'button' },
    });
  });

  it('observe 行的角色与名字都对不上时退回脚本描述，不拿别人的词取名', () => {
    const capture = new RecordingCapture();
    // 同一序号、同一标签，但那一行是上一份文档的：角色与名字都不是脚本描述的那个元素。
    const obs = observed([{ role: 'link', name: '首页', tagName: 'button' }]);
    capture.raw(targetClick(0, button), obs);
    const [event] = capture.finish();
    expect(event).toMatchObject({
      target: { role: 'button', name: '登录', tagName: 'button' },
    });
    expect(event).not.toHaveProperty('target.fingerprint');
  });

  it('一方的名字包含另一方时仍算同一个元素，用 observe 那一行的词', () => {
    const capture = new RecordingCapture();
    const obs = observed([
      {
        role: 'button',
        name: '导出 CSV',
        tagName: 'button',
        fingerprint: 'abcd1234' + '0'.repeat(56),
      },
    ]);
    capture.raw(targetClick(0, { tagName: 'button', role: 'button', name: '导出' }), obs);
    expect(capture.finish()[0]).toMatchObject({
      target: { role: 'button', name: '导出 CSV', tagName: 'button', fingerprint: 'abcd1234' },
    });
  });

  it('脚本描述里的 duplicates/position 变成 nth', () => {
    const capture = new RecordingCapture();
    capture.raw({
      kind: 'click',
      url: TARGET_URL,
      index: 3,
      el: {
        tagName: 'button',
        role: 'button',
        name: '查看',
        duplicates: 4,
        position: 3,
      },
      at: 1_000,
    } as RawEvent);
    const [event] = capture.finish();
    expect(event).toMatchObject({ target: { name: '查看', nth: 3 } });
    expect(event).not.toHaveProperty('target.duplicates');
  });
});

// 以下为本任务新增的用例。
const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const URL = 'https://example.com/';
const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 12, 0, (tick += 1)));
};
const click = (index = 1): RawEvent => ({ kind: 'click', url: URL, index, el, at: 1_000 });

describe('RecordingCapture', () => {
  it('seq 连续、at 用注入的时钟，不用页面时钟', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: URL, title: '页', text: '' });
    capture.raw(click());
    const events = capture.finish();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1].at).toBe('2026-09-21T12:00:03.000Z');
    expect(events[1]).toMatchObject({ pageAt: 1_000 });
  });

  it('元素事件一定带解析好的目标', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.raw(click());
    expect(capture.finish()[0]).toMatchObject({
      target: { role: 'button', name: '导出 CSV', tagName: 'button' },
      ambiguous: false,
    });
  });

  // 原因是否真的落地、该不该贴到这一条 page 头上，现在完全是会话层的判断（见
  // recording-session.test.ts「原因绑定预期落地地址」那组用例）；这一层只管
  // 「调用方给了 cause 就先补一条 navigate」，不再自己留一份挂起状态去猜。
  it('page 传了 cause 就先写一条 navigate 再写 page', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: 'https://example.com/list', title: '列表', text: '' }, 'back');
    const kinds = capture.finish().map((event) => event.kind);
    expect(kinds).toEqual(['navigate', 'page']);
    expect(capture.finish()[0]).toMatchObject({ cause: 'back', url: 'https://example.com/list' });
  });

  it('page 没传 cause 就只写 page，不会凭空带出 navigate', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: 'https://example.com/typed', title: '页', text: '' });
    const events = capture.finish();
    expect(events.map((event) => event.kind)).toEqual(['page']);
  });

  it('到达两万条上限后停止记录，capped 置位，已记的照样拿得到', () => {
    const capture = new RecordingCapture({ now: clock() });
    for (let n = 0; n < 20_050; n += 1) capture.raw(click());
    expect(capture.capped).toBe(true);
    expect(capture.finish()).toHaveLength(20_000);
  });

  it('counts 实时反映投影出来的步数', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: URL, title: '页', text: '' });
    capture.raw(click());
    expect(capture.counts.steps).toBe(1);
  });

  it('滚动与 unsupported 进日志但不带目标', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.raw({ kind: 'scroll', url: URL, at: 1, x: 0, y: 800 });
    capture.raw({ kind: 'unsupported', url: URL, reason: 'iframe', at: 2 });
    const events = capture.finish();
    expect(events[0]).not.toHaveProperty('target');
    expect(events[1]).toMatchObject({ reason: 'iframe' });
  });
});

// 以下为录制待办 Task 2 新增：超长地址不再让整页事件丢失，也不再让整份录制存不下来。
const LONG_BASE = 'https://example.com/report?q=';
const LONG_URL = LONG_BASE + 'x'.repeat(9000 - LONG_BASE.length); // 正好 9000 个字符

describe('RecordingCapture 截断超长地址', () => {
  it('9000 字符的页面地址记进日志后截到上限，日志里每一条都能通过 LoggedEventSchema.parse', () => {
    expect(LONG_URL).toHaveLength(9000);
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: LONG_URL, title: '页', text: '' });
    capture.raw({ kind: 'click', url: LONG_URL, index: 1, el, at: 1_000 });
    const events = capture.finish();
    expect(events).toHaveLength(2);
    for (const event of events) expect(LoggedEventSchema.safeParse(event).success).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'page' });
    expect((events[0] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
    expect((events[1] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
  });

  it('9000 字符的地址栏导航带 truncated: true', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.navigate(LONG_URL);
    const [event] = capture.finish();
    expect(event).toMatchObject({ kind: 'navigate', cause: 'address', truncated: true });
    expect((event as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
    expect(LoggedEventSchema.safeParse(event).success).toBe(true);
  });

  it('地址不超长时导航不带 truncated 字段', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.navigate(URL);
    const [event] = capture.finish();
    expect(event).not.toHaveProperty('truncated');
  });

  // Task 1 引入的第二个导航出口：page(entry, cause) 在前进后退刷新落地时补写的那条 navigate，
  // 同样要截断并标 truncated——不然按一次后退，只要落地地址够长，一样会把整份录制写挂。
  it('page 传 cause 时，超长的落地地址一样让补写的 navigate 带 truncated', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.page({ url: LONG_URL, title: '页', text: '' }, 'back');
    const events = capture.finish();
    expect(events.map((event) => event.kind)).toEqual(['navigate', 'page']);
    expect(events[0]).toMatchObject({ kind: 'navigate', cause: 'back', truncated: true });
    expect((events[0] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
    expect((events[1] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
  });

  it('备注的 onUrl 超长也会截断', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.note('这里要小心', LONG_URL);
    const [event] = capture.finish();
    expect((event as { onUrl?: string }).onUrl).toHaveLength(MAX_URL_LENGTH);
    expect(LoggedEventSchema.safeParse(event).success).toBe(true);
  });

  it('raw 事件的地址即使脚本已经截过，capture 仍防御性地再截一次', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.raw({ kind: 'scroll', url: LONG_URL, at: 1, x: 0, y: 10 });
    capture.raw({ kind: 'unsupported', url: LONG_URL, reason: 'iframe', at: 2 });
    const events = capture.finish();
    expect((events[0] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
    expect((events[1] as { url: string }).url).toHaveLength(MAX_URL_LENGTH);
  });
});
