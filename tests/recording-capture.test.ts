import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation } from '../src/main/browser/index';
import { RecordingCapture } from '../src/main/recording/capture';
import type { RawEvent } from '../src/main/recording/types';

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
    expect(events[1].at).toBe('2026-09-21T12:00:02.000Z');
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

  it('后退的原因挂起来，由下一个 page 消费成一条 navigate', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.pendingCause('back');
    capture.page({ url: 'https://example.com/list', title: '列表', text: '' });
    const kinds = capture.finish().map((event) => event.kind);
    expect(kinds).toEqual(['navigate', 'page']);
    expect(capture.finish()[0]).toMatchObject({ cause: 'back', url: 'https://example.com/list' });
  });

  it('导航没成功时挂起的原因不会张冠李戴', () => {
    const capture = new RecordingCapture({ now: clock() });
    capture.pendingCause('forward');
    capture.navigate('https://example.com/typed'); // 人改用地址栏
    capture.page({ url: 'https://example.com/typed', title: '页', text: '' });
    const events = capture.finish();
    expect(events.map((event) => event.kind)).toEqual(['navigate', 'page']);
    expect(events[0]).toMatchObject({ cause: 'address' });
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
