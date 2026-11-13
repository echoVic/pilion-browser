import { BrowserError } from './errors.js';

/**
 * 指针面（issue #7）：页面自己往里画内容、DOM 里读不出控件的 <canvas> 与 <video>。
 * 只有它们能按坐标操作；iframe / svg / embed / object / 任意 div 都不算。
 * 不进 OBSERVE_SELECTOR：那条选择器还决定录制事件的序号，改了会让已存录制的 nth 漂移。
 */
export const POINTER_SURFACE_SELECTOR = 'canvas,video';

export function isPointerSurfaceTag(tagName: string): boolean {
  const tag = tagName.toLowerCase();
  return tag === 'canvas' || tag === 'video';
}

/** 坐标上限与契约层一致；滚轮增量超出时截断而不是拒绝。 */
export const MAX_POINTER_COORDINATE = 100_000;
export const MAX_WHEEL_DELTA = 10_000;

export type PointerButton = 'left' | 'right' | 'middle';
export interface PointerPoint {
  x: number;
  y: number;
}
/** 坐标是相对指针面内容区左上角的 CSS 像素，归一化后都已取到 0.1。 */
export type PointerAction =
  | { type: 'click'; x: number; y: number; button: PointerButton; count: 1 | 2 | 3 }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; from: PointerPoint; to: PointerPoint }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number };

/** 指针面的内容区：CSS 像素。observe 给的是页面坐标（可直接当 screenshot --clip），执行时用视口坐标。 */
export interface SurfaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function invalid(message: string): BrowserError {
  return new BrowserError('INVALID_ARGUMENT', message, false, undefined, 'not_applied');
}

/** 取到 0.1：审批卡上显示的数字与真正派发的数字是同一个，没有藏起来的尾数。 */
function tenth(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function coordinate(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_POINTER_COORDINATE
  )
    throw invalid(`${name} must be a number between 0 and ${MAX_POINTER_COORDINATE}`);
  return tenth(value);
}

function point(value: unknown, name: string): PointerPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${name} must be {x, y}`);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (key !== 'x' && key !== 'y') throw invalid(`${name} has an unknown field ${key}`);
  return { x: coordinate(raw.x, `${name}.x`), y: coordinate(raw.y, `${name}.y`) };
}

function delta(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`${name} must be a finite number`);
  return tenth(Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value)));
}

const FIELDS: Record<PointerAction['type'], readonly string[]> = {
  click: ['type', 'x', 'y', 'button', 'count'],
  move: ['type', 'x', 'y'],
  drag: ['type', 'from', 'to'],
  wheel: ['type', 'x', 'y', 'deltaX', 'deltaY'],
};

/**
 * 契约层的 zod 之外再校验一遍，并补上默认值（左键、单击、增量 0）。主进程造 effect、
 * 适配器执行前都走这里：执行的永远是校验过、取过整的那一份。
 */
export function normalizePointerAction(raw: unknown): PointerAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid('action must be an object with a type');
  const action = raw as Record<string, unknown>;
  const type = action.type;
  if (type !== 'click' && type !== 'move' && type !== 'drag' && type !== 'wheel')
    throw invalid('action.type must be click, move, drag or wheel');
  for (const key of Object.keys(action))
    if (!FIELDS[type].includes(key)) throw invalid(`action has an unknown field ${key}`);
  if (type === 'drag')
    return { type, from: point(action.from, 'action.from'), to: point(action.to, 'action.to') };
  const x = coordinate(action.x, 'action.x');
  const y = coordinate(action.y, 'action.y');
  if (type === 'move') return { type, x, y };
  if (type === 'wheel') {
    const deltaX = delta(action.deltaX, 'action.deltaX');
    const deltaY = delta(action.deltaY, 'action.deltaY');
    if (deltaX === 0 && deltaY === 0) throw invalid('wheel needs a non-zero deltaX or deltaY');
    return { type, x, y, deltaX, deltaY };
  }
  const button = action.button ?? 'left';
  if (button !== 'left' && button !== 'right' && button !== 'middle')
    throw invalid('action.button must be left, right or middle');
  const count = action.count ?? 1;
  if (count !== 1 && count !== 2 && count !== 3) throw invalid('action.count must be 1, 2 or 3');
  return { type, x, y, button, count };
}

/** 这次操作会落在指针面上的每一个点：拖拽查起点和终点。 */
export function pointerPoints(action: PointerAction): PointerPoint[] {
  return action.type === 'drag' ? [action.from, action.to] : [{ x: action.x, y: action.y }];
}

/** CDP 的四点 quad → 轴对齐的盒子；坐标不是有限数时返回 undefined。 */
export function quadBox(quad: ReadonlyArray<number> | undefined): SurfaceBox | undefined {
  if (!quad || quad.length < 8 || quad.slice(0, 8).some((value) => !Number.isFinite(value)))
    return undefined;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 点必须落在内容区里：右、下边界不含（宽 300 的画面可用 x 是 0 到 299.9）。 */
export function assertPointsInBox(points: ReadonlyArray<PointerPoint>, box: SurfaceBox): void {
  for (const p of points)
    if (p.x >= box.width || p.y >= box.height)
      throw invalid(
        `Point (${formatPointerNumber(p.x)}, ${formatPointerNumber(p.y)}) is outside the surface content box ` +
          `(width ${formatPointerNumber(box.width)}, height ${formatPointerNumber(box.height)}); ` +
          'use 0 <= x < width and 0 <= y < height, relative to its top-left corner',
      );
}

/** 审批与回执里的数字：最多一位小数，不出现 -0。 */
export function formatPointerNumber(value: number): string {
  return String(tenth(value));
}

function at(p: PointerPoint): string {
  return `(${formatPointerNumber(p.x)}, ${formatPointerNumber(p.y)})`;
}

const BUTTON_TEXT: Record<PointerButton, string> = { left: '左键', right: '右键', middle: '中键' };
const COUNT_TEXT = { 1: '单击', 2: '双击', 3: '三击' } as const;

/** 审批卡「操作」一行：全部由主进程按校验过的数字拼出，不夹带任何 Agent 或页面给的文字。 */
export function describePointerAction(action: PointerAction): string {
  if (action.type === 'click')
    return `在 ${at(action)} 处${BUTTON_TEXT[action.button]}${COUNT_TEXT[action.count]}`;
  if (action.type === 'move') return `指针移到 ${at(action)}`;
  if (action.type === 'drag') return `从 ${at(action.from)} 拖到 ${at(action.to)}`;
  const parts = [
    ...(action.deltaX === 0 ? [] : [`横向 ${formatPointerNumber(action.deltaX)}`]),
    ...(action.deltaY === 0 ? [] : [`纵向 ${formatPointerNumber(action.deltaY)}`]),
  ];
  return `在 ${at(action)} 处滚轮 ${parts.join(' ')}`;
}

/** 审批卡上单独一行提醒：坐标背后是什么，Pilion 读不出来，只能靠人看画面判断。 */
export const POINTER_APPROVAL_NOTICE = '按坐标操作：Pilion 无法识别该位置上的内容';
