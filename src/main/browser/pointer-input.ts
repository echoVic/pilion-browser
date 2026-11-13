import { BrowserError } from './errors.js';
import {
  assertPointsInBox,
  formatPointerNumber,
  isPointerSurfaceTag,
  normalizePointerAction,
  pointerPoints,
  quadBox,
  type PointerAction,
  type PointerPoint,
  type SurfaceBox,
} from './pointer-action.js';
import type { ActionEffect } from './types.js';

/**
 * 适配器交给指针输入的最小能力（issue #7）。只有固定的 CDP 命令，没有脚本、没有原始协议出口；
 * 指针滑动与按下/抬起的成对语义沿用适配器自己的 AgentPointer 与 pressAndRelease。
 */
export interface PointerInputPort {
  command<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  zoomFactor(): number;
  /** 目标节点此刻的身份指纹；节点没了返回 undefined。 */
  fingerprint(signal?: AbortSignal): Promise<string | undefined>;
  /** 可见指针滑到视口 CSS 坐标 destination；沿途每一步交给 dispatch，坐标同样是视口 CSS 像素。 */
  glide(
    destination: PointerPoint,
    dispatch: (point: PointerPoint) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 一次按下与抬起，按下发出去后抬起不受取消影响（与适配器的 pressAndRelease 同一份）。 */
  mouse(
    press: Record<string, unknown>,
    release: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 点击涟漪：只是给人看的。 */
  ripple(): Promise<void>;
}

type Viewport = { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
/** 视口 CSS 坐标（派发用）与它对应的整数页面坐标（命中测试用）：两者指的是同一个点。 */
type Target = PointerPoint & { pageX: number; pageY: number };

const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const;

function notApplied(message: string): BrowserError {
  return new BrowserError('UNSUPPORTED_ELEMENT', message, false, undefined, 'not_applied');
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Browser operation revoked');
}
function at(point: PointerPoint): string {
  return `(${formatPointerNumber(point.x)}, ${formatPointerNumber(point.y)})`;
}

async function contentBox(
  port: PointerInputPort,
  nodeId: number,
  signal?: AbortSignal,
): Promise<SurfaceBox> {
  let quad: number[] | undefined;
  try {
    quad = (
      await port.command<{ model?: { content?: number[] } }>('DOM.getBoxModel', { nodeId }, signal)
    ).model?.content;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof BrowserError) throw error;
    if ((await port.fingerprint(signal)) === undefined)
      throw new BrowserError('STALE_ELEMENT', 'Surface is gone; observe again', true);
  }
  const box = quadBox(quad);
  if (!box || box.width <= 0 || box.height <= 0)
    throw notApplied('Surface has no layout (hidden or zero-sized); observe again once it shows');
  return box;
}

async function viewport(port: PointerInputPort, signal?: AbortSignal): Promise<Viewport> {
  const metrics = await port.command<{ cssLayoutViewport: Viewport }>(
    'Page.getLayoutMetrics',
    {},
    signal,
  );
  return metrics.cssLayoutViewport;
}

/**
 * 把内容区里的点落到一个整数页面坐标上：命中测试只收整数，派发也就用这同一个点，
 * 不让两者之间差出半个像素（那半个像素可能正好落在盖住画面的元素上）。点仍须留在内容区与视口里。
 */
function target(box: SurfaceBox, point: PointerPoint, view: Viewport): Target | undefined {
  const snap = (start: number, size: number, offset: number): number | undefined => {
    const low = Math.ceil(start);
    const high = Math.ceil(start + size) - 1;
    if (low > high) return undefined;
    return Math.min(high, Math.max(low, Math.round(start + offset)));
  };
  const pageX = snap(box.x + view.pageX, box.width, point.x);
  const pageY = snap(box.y + view.pageY, box.height, point.y);
  if (pageX === undefined || pageY === undefined) return undefined;
  const x = pageX - view.pageX;
  const y = pageY - view.pageY;
  if (x < 0 || y < 0 || x >= view.clientWidth || y >= view.clientHeight) return undefined;
  return { x, y, pageX, pageY };
}

/**
 * 派发任何输入之前的全部检查：点在内容区里、在可见视口里、该点最上层的节点就是指针面本身。
 * 任何一条不过都在这里抛错，页面一个事件都收不到。
 */
async function aim(
  port: PointerInputPort,
  nodeId: number,
  points: ReadonlyArray<PointerPoint>,
  signal?: AbortSignal,
): Promise<Target[]> {
  let box = await contentBox(port, nodeId, signal);
  assertPointsInBox(points, box);
  let view = await viewport(port, signal);
  // 点都已在视口里就不滚：人或 Agent 刚把大画面滚到位，不能被这里拽回去。
  if (points.some((point) => !target(box, point, view))) {
    await port.command('DOM.scrollIntoViewIfNeeded', { nodeId }, signal);
    box = await contentBox(port, nodeId, signal);
    assertPointsInBox(points, box);
    view = await viewport(port, signal);
  }
  const targets: Target[] = [];
  for (const point of points) {
    const aimed = target(box, point, view);
    if (!aimed)
      throw notApplied(
        `Point ${at(point)} is not in the visible page; scroll until it is on screen, then retry`,
      );
    let hit: { nodeId?: number };
    try {
      // 带上 UA shadow：<video controls> 的播放条、全屏按钮属于控件，不算画面本身。
      hit = await port.command<{ nodeId?: number }>(
        'DOM.getNodeForLocation',
        { x: aimed.pageX, y: aimed.pageY, includeUserAgentShadowDOM: true },
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof BrowserError) throw error;
      throw notApplied(`Nothing on the page can be hit at ${at(point)}; observe again`);
    }
    if (hit.nodeId !== nodeId)
      throw notApplied(
        `Another element covers the surface at ${at(point)}; pointer input only goes to the surface itself`,
      );
    targets.push(aimed);
  }
  return targets;
}

/**
 * 在 canvas/video 上按坐标派发一次指针操作。坐标相对内容区左上角（CSS 像素）；
 * 页面缩放下视口 CSS 坐标原样派发，指针动画按 DIP（CSS × 缩放）画。结果只说已派发，从不说生效。
 */
export async function dispatchPointerAction(
  port: PointerInputPort,
  nodeId: number,
  tagName: string,
  requested: PointerAction,
  signal?: AbortSignal,
  expectedFingerprint?: string,
): Promise<ActionEffect> {
  if (!isPointerSurfaceTag(tagName))
    throw notApplied(
      'browser.pointer only works on <canvas> and <video> surfaces; use click or hover with this element ref',
    );
  const action = normalizePointerAction(requested);
  const before = expectedFingerprint ?? (await port.fingerprint(signal));
  if (!before) throw new BrowserError('STALE_ELEMENT', 'Surface is gone; observe again', true);
  const points = pointerPoints(action);
  let targets = await aim(port, nodeId, points, signal);
  const zoom = port.zoomFactor();
  await port.glide(
    targets[0]!,
    async (point) => {
      await port.command(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' },
        signal,
      );
    },
    signal,
  );
  // 移动本身就是这次操作：滑到点上即完成，之后页面怎么反应都不改写结果。
  if (action.type === 'move') return { ok: true, effect: 'dispatched' };
  // 指针移过去时页面可能换掉画面或在上面盖一层：按下之前按同一套规则再查一遍。
  if ((await port.fingerprint(signal)) !== before)
    throw new BrowserError(
      'STALE_ELEMENT',
      'Surface changed during pointer movement; observe again',
      true,
    );
  const settled = await aim(port, nodeId, points, signal);
  if (
    settled.some(
      (point, index) =>
        Math.abs(point.x - targets[index]!.x) > 1 || Math.abs(point.y - targets[index]!.y) > 1,
    )
  )
    throw new BrowserError(
      'STALE_ELEMENT',
      'Surface moved during pointer movement; observe again',
      true,
    );
  targets = settled;
  const first = targets[0]!;
  if (action.type === 'click') {
    const position = { x: first.x, y: first.y, button: action.button };
    // 双击/三击：每一下都是一对按下抬起，clickCount 逐次加一，页面才会认成 dblclick。
    for (let clickCount = 1; clickCount <= action.count; clickCount += 1)
      await port.mouse(
        {
          type: 'mousePressed',
          ...position,
          buttons: BUTTON_MASK[action.button],
          clickCount,
        },
        { type: 'mouseReleased', ...position, buttons: 0, clickCount },
        signal,
      );
    await port.ripple();
    return { ok: true, effect: 'dispatched' };
  }
  if (action.type === 'wheel') {
    // 页面收到的增量是派发值除以缩放：乘回去，让页面看到的就是请求的 CSS 像素。
    await port.command(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: first.x,
        y: first.y,
        deltaX: action.deltaX * zoom,
        deltaY: action.deltaY * zoom,
      },
      signal,
    );
    return { ok: true, effect: 'dispatched' };
  }
  const end = targets[1]!;
  let last: PointerPoint = first;
  const release = (point: PointerPoint) => ({
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  throwIfAborted(signal);
  try {
    await port.command(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1 },
      signal,
    );
    await port.glide(
      end,
      async (point) => {
        last = point;
        await port.command(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1 },
          signal,
        );
      },
      signal,
    );
  } catch (error) {
    // 取消或失败都不能把左键留在按下状态：在指针停下的地方抬起，尽力而为，原来的错误优先。
    await port.command('Input.dispatchMouseEvent', release(last)).catch(() => undefined);
    throw error;
  }
  await port.command('Input.dispatchMouseEvent', release(end));
  throwIfAborted(signal);
  return { ok: true, effect: 'dispatched' };
}
