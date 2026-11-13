import { describe, expect, it } from 'vitest';
import {
  LoggedEventSchema,
  TrajectorySchema,
  UNSUPPORTED_REASONS,
} from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const stamp = '2026-09-21T12:00:00.000Z';

describe('LoggedEventSchema', () => {
  it('点击带着采集时解析好的目标', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 3,
      at: stamp,
      kind: 'click',
      url: 'https://example.com/',
      index: 7,
      el,
      pageAt: 1_700_000_000_000,
      target: { role: 'button', name: '导出 CSV', tagName: 'button' },
      ambiguous: false,
    });
    expect(parsed.kind).toBe('click');
  });

  // 磁盘上已有的日志不能因为这一版换了写法就读不进来。
  it('老日志的勾选框描述带 checked、点击没有连击次数，照样读得进来；新日志的点击带 detail', () => {
    const click = {
      seq: 3,
      at: stamp,
      kind: 'click',
      url: 'https://example.com/',
      index: 7,
      el: {
        tagName: 'input',
        role: 'checkbox',
        name: '同意',
        inputType: 'checkbox',
        checked: true,
      },
      pageAt: 1_700_000_000_000,
      target: { role: 'checkbox', name: '同意', tagName: 'input', inputType: 'checkbox' },
      ambiguous: false,
    };
    expect(LoggedEventSchema.parse(click)).toMatchObject({ el: { checked: true } });
    expect(LoggedEventSchema.parse({ ...click, detail: 2 })).toMatchObject({ detail: 2 });
    expect(() => LoggedEventSchema.parse({ ...click, detail: 0 })).toThrow();
  });

  it('secret 事件带值就整条不合法', () => {
    expect(() =>
      LoggedEventSchema.parse({
        seq: 1,
        at: stamp,
        kind: 'secret',
        url: 'https://example.com/',
        index: 2,
        el,
        pageAt: 1,
        target: { role: 'button', name: '导出 CSV', tagName: 'button' },
        ambiguous: false,
        otp: false,
        value: '123456',
      }),
    ).toThrow();
  });

  it('edit 只有长度，没有内容字段', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 1,
      at: stamp,
      kind: 'edit',
      url: 'https://example.com/',
      index: -1,
      el: { tagName: 'div', role: 'generic', name: '' },
      pageAt: 1,
      target: { role: 'generic', name: '', tagName: 'div' },
      ambiguous: false,
      length: 42,
    });
    expect(parsed).not.toHaveProperty('text');
    expect(() => LoggedEventSchema.parse({ ...parsed, text: '偷渡的内容' })).toThrow();
  });

  it('navigate 必须说明是怎么来的', () => {
    expect(
      LoggedEventSchema.parse({
        seq: 2,
        at: stamp,
        kind: 'navigate',
        url: 'https://example.com/list',
        cause: 'back',
      }).kind,
    ).toBe('navigate');
    expect(() =>
      LoggedEventSchema.parse({ seq: 2, at: stamp, kind: 'navigate', url: 'https://e.com/' }),
    ).toThrow();
  });

  it('scroll 只带坐标', () => {
    const parsed = LoggedEventSchema.parse({
      seq: 9,
      at: stamp,
      kind: 'scroll',
      url: 'https://example.com/',
      x: 0,
      y: 1200,
    });
    expect(parsed).not.toHaveProperty('el');
  });
});

describe('TrajectorySchema 的版本', () => {
  const entries = [] as const;

  it('接受 version 2 与 source', () => {
    const parsed = TrajectorySchema.parse({
      meta: {
        app: 'pilion',
        version: 2,
        name: '月度导出',
        recordedAt: stamp,
        source: { events: 12, hash: 'a'.repeat(64) },
      },
      entries,
    });
    expect(parsed.meta.source?.events).toBe(12);
  });

  it('仍然接受没有 source 的 version 1', () => {
    const parsed = TrajectorySchema.parse({
      meta: { app: 'pilion', version: 1, name: '月度导出', recordedAt: stamp },
      entries,
    });
    expect(parsed.meta.version).toBe(1);
  });

  it('source 的哈希必须是 64 位十六进制', () => {
    expect(() =>
      TrajectorySchema.parse({
        meta: {
          app: 'pilion',
          version: 2,
          name: '月度导出',
          recordedAt: stamp,
          source: { events: 1, hash: 'not-a-hash' },
        },
        entries,
      }),
    ).toThrow();
  });
});

it('富文本是一种新的回放不了的原因', () => {
  expect(UNSUPPORTED_REASONS).toContain('rich-text');
});
