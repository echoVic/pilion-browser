import type { CliArgs } from './args.js';
import { CliError } from './output.js';

/** `pilion pointer` 的用法：坐标相对 canvas/video 内容区左上角，单位 CSS 像素（issue #7）。 */
export const POINTER_USAGE =
  'pilion pointer <click|move|drag|wheel> --ref <elementRef json> [--tab <id>]\n' +
  '  click --at x,y [--button left|right|middle] [--count 1|2|3]\n' +
  '  move  --at x,y\n' +
  '  drag  --from x,y --to x,y（按住左键）\n' +
  '  wheel --at x,y [--dx n] [--dy n]（至少一个非零，-10000..10000）\n' +
  '坐标是相对指针面（observe 里 surface:true 的行）内容区左上角的 CSS 像素';

type Flag = 'at' | 'button' | 'count' | 'from' | 'to' | 'dx' | 'dy';
const SUBCOMMAND_FLAGS: Record<string, readonly Flag[]> = {
  click: ['at', 'button', 'count'],
  move: ['at'],
  drag: ['from', 'to'],
  wheel: ['at', 'dx', 'dy'],
};

function usage(detail: string): CliError {
  return new CliError(`${detail}\n用法: ${POINTER_USAGE}`);
}

function point(raw: string | undefined, flag: string): { x: number; y: number } {
  if (raw === undefined) throw usage(`缺少 --${flag} x,y`);
  const parts = raw.split(',');
  const [x, y] = parts.map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  if (
    parts.length !== 2 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x! < 0 ||
    y! < 0 ||
    x! > 100_000 ||
    y! > 100_000
  )
    throw usage(`--${flag} 必须是 x,y（0 到 100000 的 CSS 像素，相对指针面左上角），例如 120,80`);
  return { x: x!, y: y! };
}

function delta(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > 10_000)
    throw usage(`--${flag} 必须是 -10000 到 10000 的数字（CSS 像素）`);
  return value;
}

/** 本地把子命令与选项拼成 browser.pointer 的 action；不合法就在连接之前给出用法。 */
export function pointerAction(
  subcommand: string | undefined,
  args: CliArgs,
): Record<string, unknown> {
  const allowed =
    subcommand && Object.hasOwn(SUBCOMMAND_FLAGS, subcommand)
      ? SUBCOMMAND_FLAGS[subcommand]!
      : undefined;
  if (!allowed) throw usage('pointer 需要子命令 click、move、drag 或 wheel');
  for (const flag of ['at', 'button', 'count', 'from', 'to', 'dx', 'dy'] as const)
    if (args[flag] !== undefined && !allowed.includes(flag))
      throw usage(`pointer ${subcommand} 不支持 --${flag}`);
  if (subcommand === 'drag')
    return { type: 'drag', from: point(args.from, 'from'), to: point(args.to, 'to') };
  const at = point(args.at, 'at');
  if (subcommand === 'move') return { type: 'move', ...at };
  if (subcommand === 'wheel') {
    const deltaX = delta(args.dx, 'dx');
    const deltaY = delta(args.dy, 'dy');
    if (!deltaX && !deltaY) throw usage('wheel 至少需要一个非零的 --dx 或 --dy');
    return {
      type: 'wheel',
      ...at,
      ...(deltaX === undefined ? {} : { deltaX }),
      ...(deltaY === undefined ? {} : { deltaY }),
    };
  }
  const button = args.button;
  if (button !== undefined && button !== 'left' && button !== 'right' && button !== 'middle')
    throw usage('--button 只能是 left、right 或 middle');
  const count = args.count === undefined ? undefined : Number(args.count);
  if (count !== undefined && count !== 1 && count !== 2 && count !== 3)
    throw usage('--count 只能是 1、2 或 3');
  return {
    type: 'click',
    ...at,
    ...(button === undefined ? {} : { button }),
    ...(count === undefined ? {} : { count }),
  };
}
