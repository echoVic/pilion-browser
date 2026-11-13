import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/main/browser/errors.js';
import {
  assertPointsInBox,
  describePointerAction,
  formatPointerNumber,
  isPointerSurfaceTag,
  normalizePointerAction,
  pointerPoints,
  POINTER_APPROVAL_NOTICE,
  POINTER_SURFACE_SELECTOR,
  quadBox,
} from '../src/main/browser/pointer-action.js';
import { OBSERVE_SELECTOR } from '../src/main/browser/types.js';

function caught(fn: () => unknown): BrowserError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserError);
    return error as BrowserError;
  }
  throw new Error('expected a BrowserError');
}

describe('pointer surfaces', () => {
  it('are exactly canvas and video, kept out of OBSERVE_SELECTOR', () => {
    expect(POINTER_SURFACE_SELECTOR).toBe('canvas,video');
    for (const tag of ['canvas', 'CANVAS', 'video', 'Video'])
      expect(isPointerSurfaceTag(tag)).toBe(true);
    for (const tag of ['iframe', 'svg', 'embed', 'object', 'div', 'img', 'button', ''])
      expect(isPointerSurfaceTag(tag)).toBe(false);
    // 录制事件的 nth 依赖这条选择器：指针面另走一条，这条一个字都不改。
    expect(OBSERVE_SELECTOR).toBe(
      'a,button,input,textarea,select,[role],[contenteditable],[onclick],[tabindex],[data-click],[data-clickable],[style*="cursor"]',
    );
  });
});

describe('normalizePointerAction', () => {
  it('fills defaults, rounds to a tenth and keeps a fixed key order', () => {
    expect(normalizePointerAction({ y: 80, x: 120.04, type: 'click' })).toEqual({
      type: 'click',
      x: 120,
      y: 80,
      button: 'left',
      count: 1,
    });
    expect(
      Object.keys(normalizePointerAction({ count: 2, button: 'right', y: 1, x: 1, type: 'click' })),
    ).toEqual(['type', 'x', 'y', 'button', 'count']);
    expect(normalizePointerAction({ type: 'move', x: 0.06, y: 99_999.99 })).toEqual({
      type: 'move',
      x: 0.1,
      y: 100_000,
    });
    expect(
      normalizePointerAction({ type: 'drag', to: { y: 150, x: 200 }, from: { x: 10.25, y: 10 } }),
    ).toEqual({ type: 'drag', from: { x: 10.3, y: 10 }, to: { x: 200, y: 150 } });
    expect(normalizePointerAction({ type: 'wheel', x: 1, y: 2, deltaY: -240 })).toEqual({
      type: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: -240,
    });
  });

  it('clamps wheel deltas to ±10000 and never yields -0', () => {
    expect(
      normalizePointerAction({ type: 'wheel', x: 1, y: 1, deltaY: 99_999, deltaX: -50_000 }),
    ).toMatchObject({ deltaX: -10_000, deltaY: 10_000 });
    const tiny = normalizePointerAction({ type: 'wheel', x: 1, y: 1, deltaX: -0.01, deltaY: 5 });
    expect(Object.is((tiny as { deltaX: number }).deltaX, 0)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [[]],
    ['click'],
    [{ type: 'tap', x: 1, y: 1 }],
    [{ type: 'click', x: -1, y: 1 }],
    [{ type: 'click', x: 100_001, y: 1 }],
    [{ type: 'click', x: Number.NaN, y: 1 }],
    [{ type: 'click', x: '1', y: 1 }],
    [{ type: 'click', x: 1 }],
    [{ type: 'click', x: 1, y: 1, button: 'back' }],
    [{ type: 'click', x: 1, y: 1, count: 4 }],
    [{ type: 'click', x: 1, y: 1, selector: 'canvas' }],
    [{ type: 'move', x: 1, y: 1, count: 1 }],
    [{ type: 'drag', from: { x: 1, y: 1 } }],
    [{ type: 'drag', from: { x: 1, y: 1 }, to: [5, 5] }],
    [{ type: 'drag', from: { x: 1, y: 1, z: 1 }, to: { x: 5, y: 5 } }],
    [{ type: 'drag', x: 1, y: 1, from: { x: 1, y: 1 }, to: { x: 5, y: 5 } }],
    [{ type: 'wheel', x: 1, y: 1 }],
    [{ type: 'wheel', x: 1, y: 1, deltaY: 0.01 }],
    [{ type: 'wheel', x: 1, y: 1, deltaY: Number.POSITIVE_INFINITY }],
  ])('rejects %j as INVALID_ARGUMENT, not applied', (raw) => {
    const error = caught(() => normalizePointerAction(raw));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.outcome).toBe('not_applied');
  });
});

describe('pointer geometry', () => {
  it('lists the points each action lands on', () => {
    expect(pointerPoints(normalizePointerAction({ type: 'click', x: 3, y: 4 }))).toEqual([
      { x: 3, y: 4 },
    ]);
    expect(
      pointerPoints(
        normalizePointerAction({ type: 'drag', from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }),
      ),
    ).toEqual([
      { x: 1, y: 2 },
      { x: 30, y: 40 },
    ]);
  });

  it('turns a CDP quad into an axis-aligned box', () => {
    expect(quadBox([10, 20, 310, 20, 310, 220, 10, 220])).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    // 旋转过的画面取外接矩形。
    expect(quadBox([50, 0, 100, 50, 50, 100, 0, 50])).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(quadBox(undefined)).toBeUndefined();
    expect(quadBox([1, 2, 3])).toBeUndefined();
    expect(quadBox([0, 0, Number.NaN, 0, 1, 1, 0, 1])).toBeUndefined();
  });

  it('accepts points inside the content box and names its size when refusing', () => {
    const box = { x: 8, y: 8, width: 300, height: 200 };
    expect(() =>
      assertPointsInBox(
        [
          { x: 0, y: 0 },
          { x: 299.9, y: 199.9 },
        ],
        box,
      ),
    ).not.toThrow();
    for (const point of [
      { x: 300, y: 10 },
      { x: 10, y: 200 },
      { x: 5000, y: 5000 },
    ]) {
      const error = caught(() => assertPointsInBox([{ x: 1, y: 1 }, point], box));
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.outcome).toBe('not_applied');
      expect(error.message).toContain('width 300, height 200');
    }
  });
});

describe('pointer approval text', () => {
  it('formats numbers with at most one decimal', () => {
    expect(formatPointerNumber(120)).toBe('120');
    expect(formatPointerNumber(120.04)).toBe('120');
    expect(formatPointerNumber(120.05)).toBe('120.1');
    expect(formatPointerNumber(-0.01)).toBe('0');
  });

  it.each([
    [{ type: 'click', x: 120, y: 340 }, '在 (120, 340) 处左键单击'],
    [{ type: 'click', x: 120, y: 340, count: 2 }, '在 (120, 340) 处左键双击'],
    [{ type: 'click', x: 120, y: 340, count: 3 }, '在 (120, 340) 处左键三击'],
    [{ type: 'click', x: 120.5, y: 340, button: 'right' }, '在 (120.5, 340) 处右键单击'],
    [{ type: 'click', x: 1, y: 2, button: 'middle' }, '在 (1, 2) 处中键单击'],
    [{ type: 'move', x: 120, y: 340 }, '指针移到 (120, 340)'],
    [
      { type: 'drag', from: { x: 10, y: 10 }, to: { x: 200, y: 150 } },
      '从 (10, 10) 拖到 (200, 150)',
    ],
    [{ type: 'wheel', x: 120, y: 340, deltaY: 240 }, '在 (120, 340) 处滚轮 纵向 240'],
    [{ type: 'wheel', x: 1, y: 1, deltaX: -30.26 }, '在 (1, 1) 处滚轮 横向 -30.3'],
    [{ type: 'wheel', x: 1, y: 1, deltaX: 5, deltaY: -5 }, '在 (1, 1) 处滚轮 横向 5 纵向 -5'],
  ])('describes %j as %s', (raw, text) => {
    expect(describePointerAction(normalizePointerAction(raw))).toBe(text);
  });

  it('has a fixed notice line', () => {
    expect(POINTER_APPROVAL_NOTICE).toBe('按坐标操作：Pilion 无法识别该位置上的内容');
  });
});
