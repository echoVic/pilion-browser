import { lstat, mkdir, readFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { PRESS_KEYS, isPressKey } from '../../../shared/press-keys.js';
import {
  describePointerAction,
  normalizePointerAction,
  type SurfaceBox,
} from '../../browser/pointer-action.js';
import { renderGuide } from './guide.js';
import type { CliArgs } from './args.js';
import { CliError, printError, printResult, type CliIo } from './output.js';
import { POINTER_USAGE, pointerAction } from './pointer.js';

export type CallTool = (request: {
  name: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;
export type CallControl = (control: object) => Promise<unknown>;

export type StatusLine = { item: string; ok: boolean; detail: string };
export type StatusReport = StatusLine[];

export interface CommandContext {
  args: CliArgs;
  io: CliIo;
  /** 懒取：skill / version / status 不需要（或要自己处理）凭证。 */
  call: () => Promise<CallTool>;
  /** 懒取控制帧通道；space 命令不调用浏览器工具。 */
  control?: () => Promise<CallControl>;
  version: string;
  /** `pilion status` 的检查项；入口提供真实实现，测试注入假实现。 */
  status?: () => Promise<StatusReport>;
}

type Tab = { id: string; title: string; url: string; loading: boolean };
type Handler = (ctx: CommandContext) => Promise<void>;

export const USAGE = [
  '用法: pilion <命令> [选项]',
  '  space new "<label>"        创建 Agent 空间（打印 spaceId）',
  '  space list                 列出当前客户端的 Agent 空间',
  '  space close <id>           关闭 Agent 空间',
  '  tabs                       列出本通道打开的标签',
  '  new <url>                  打开标签',
  '  activate <id>              激活标签',
  '  close <id>                 关闭标签',
  '  navigate <url> [--tab id]  导航',
  '  read [--tab id]            读标签正文',
  '  observe [--tab id]         列出可交互元素（含 elementRef）',
  '    --offset n               后续一页（每页最多 200 个）',
  '  click --ref <json> [--force] 点击（被覆盖/无布局时 --force 合成激活）',
  '  hover --ref <json>        悬停，让 hover-only 控件获得布局',
  '  pointer click|move|wheel --ref <json> --at x,y  在 canvas/video 指针面上按坐标操作',
  '    click [--button left|right|middle] [--count 1|2|3]；wheel --dx n --dy n',
  '  pointer drag --ref <json> --from x,y --to x,y  按住左键拖拽（坐标相对指针面左上角）',
  '  type --ref <json> --text s [--replace]  输入文本',
  '  screenshot -o file.png|.jpg|.jpeg  截图',
  '    --scale 0.1..1 --quality 1..100 --format png|jpeg --clip x,y,w,h',
  '  info [--tab id]            页面信息',
  '  select --ref <json> --value v  选择下拉项',
  '  check --ref <json> [--off] 勾选/取消勾选',
  '  press <key> [--ref <json>] 按键（省略 --ref 发给当前焦点元素）',
  '  scroll <up|down> [--amount px]  滚动视口（不触发审批）',
  '  upload --ref <json> --file /abs/path  把本地文件写入 <input type=file>（--file 可重复）',
  '  status                     检查连接与凭证',
  '  skill                      打印给 Agent 的用法指南',
  '  version                    打印版本',
  '全局: --json；浏览器命令: --space <id>（或 PILION_SPACE）',
  '效果操作: --ref-file file.json；type 可用 --text-file file.txt',
].join('\n');

function need<T>(value: T | undefined, usage: string): T {
  if (value === undefined || value === '') throw new CliError(`用法: ${usage}`);
  return value;
}

function parseRef(raw: string | undefined, usage: string): unknown {
  const text = need(raw, usage);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      '--ref 不是合法 JSON：请从 `pilion observe --json` 的输出里原样复制 elementRef',
    );
  }
}

async function inputFile(
  inline: string | undefined,
  file: string | undefined,
  flag: string,
): Promise<string | undefined> {
  if (inline !== undefined && file !== undefined)
    throw new CliError(`${flag} 与 ${flag}-file 不能同时使用`);
  if (file === undefined) return inline;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new CliError(`无法读取 ${flag}-file：${file}`);
  }
}

async function elementRef(ctx: CommandContext, usage: string): Promise<unknown> {
  return parseRef(await inputFile(ctx.args.ref, ctx.args.refFile, '--ref'), usage);
}

/** 截图的显式降采样参数：本地先给可读错误，别把非法值丢给服务端换回一个裸 schema 错。 */
function screenshotArgs(args: CliArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.scale !== undefined) {
    const scale = Number(args.scale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 1)
      throw new CliError('--scale 必须是 0.1 到 1 之间的数字');
    out.scale = scale;
  }
  if (args.quality !== undefined) {
    const quality = Number(args.quality);
    if (!Number.isInteger(quality) || quality < 1 || quality > 100)
      throw new CliError('--quality 必须是 1 到 100 的整数（仅 jpeg 有效）');
    out.quality = quality;
  }
  if (args.format !== undefined) {
    if (args.format !== 'png' && args.format !== 'jpeg')
      throw new CliError('--format 只能是 png 或 jpeg');
    out.format = args.format;
  }
  if (args.clip !== undefined) {
    const parts = args.clip.split(',');
    const nums = parts.map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => p.trim() === '') ||
      nums.some((n) => !Number.isFinite(n) || n < 0) ||
      nums[2]! <= 0 ||
      nums[3]! <= 0
    )
      throw new CliError('--clip 必须是 x,y,width,height（非负坐标、正宽高），例如 0,0,800,600');
    out.clip = { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  }
  return out;
}

const REF_FLAGS = ['--ref', '--ref-file'];
const SPACE_FLAG = '--space';
const COMMAND_FLAGS: Record<string, string[]> = {
  skill: [],
  version: [],
  status: [],
  space: [SPACE_FLAG],
  tabs: [SPACE_FLAG],
  new: [SPACE_FLAG],
  close: [SPACE_FLAG],
  activate: [SPACE_FLAG],
  navigate: ['--tab', SPACE_FLAG],
  read: ['--tab', SPACE_FLAG],
  snapshot: ['--tab', SPACE_FLAG],
  info: ['--tab', SPACE_FLAG],
  observe: ['--tab', '--offset', SPACE_FLAG],
  click: ['--tab', ...REF_FLAGS, '--force', SPACE_FLAG],
  hover: ['--tab', ...REF_FLAGS, SPACE_FLAG],
  pointer: [
    '--tab',
    ...REF_FLAGS,
    '--at',
    '--button',
    '--count',
    '--from',
    '--to',
    '--dx',
    '--dy',
    SPACE_FLAG,
  ],
  type: ['--tab', ...REF_FLAGS, '--text', '--text-file', '--replace', SPACE_FLAG],
  select: ['--tab', ...REF_FLAGS, '--value', SPACE_FLAG],
  check: ['--tab', ...REF_FLAGS, '--off', SPACE_FLAG],
  press: ['--tab', ...REF_FLAGS, SPACE_FLAG],
  scroll: ['--tab', '--amount', SPACE_FLAG],
  upload: ['--tab', ...REF_FLAGS, '--file', SPACE_FLAG],
  screenshot: [
    '--tab',
    '-o',
    '--out',
    '--force',
    '--scale',
    '--quality',
    '--format',
    '--clip',
    SPACE_FLAG,
  ],
};

function validateArgs(command: string, args: CliArgs): void {
  if (args.error) throw new CliError(args.error);
  if (args.tab !== undefined && args.tab.trim() === '')
    throw new CliError('--tab 不能为空；使用本任务的实际标签 ID');
  // 只认表里自己的键：`pilion toString` / `constructor` 不能命中 Object.prototype 上的同名函数。
  const allowed = Object.hasOwn(COMMAND_FLAGS, command) ? COMMAND_FLAGS[command] : undefined;
  if (!allowed) throw new CliError(USAGE);
  for (const flag of args.flags ?? [])
    if (flag !== '--json' && !allowed.includes(flag))
      throw new CliError(`${command} 不支持 ${flag}；运行 pilion skill 查看用法`);
  const positionalCount =
    command === 'space'
      ? 2
      : ['new', 'navigate', 'close', 'activate', 'press', 'scroll', 'pointer'].includes(command)
        ? 1
        : 0;
  if (args.rest.length > positionalCount)
    throw new CliError(`多余参数：${args.rest.slice(positionalCount).join(' ')}`);
}

async function tabId(ctx: CommandContext, call: CallTool): Promise<string> {
  if (ctx.args.tab) return ctx.args.tab;
  const tabs = (await call({ name: 'browser.tabs.list', args: {} })) as Tab[];
  if (!tabs.length) throw new CliError('没有可用标签，先用 `pilion new <url>` 打开一个');
  return tabs[0]!.id;
}

/** 透传服务端 upload 后验回执；没有任何后验证据时绝不当成成功（issue #4a）。 */
function normalizeUploadResult(raw: unknown, requested: number): Record<string, unknown> {
  const result =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (result.verified === 'applied') return { ok: true, files: requested, ...result };
  const detail =
    typeof result.warning === 'string' && result.warning
      ? result.warning
      : `请求 ${requested} 个文件，但服务端没有回报页面确认信息。`;
  return {
    ...result,
    ok: false,
    files: requested,
    verified: result.verified ?? 'unconfirmed',
    effect: 'none',
    warning: `【upload 未确认】${detail} ok 不代表页面已接收，必须用 read/observe 复核卡片数；若为 0，改投另一个 file input。`,
  };
}

function uploadText(result: Record<string, unknown>, requested: number): string {
  if (result.verified === 'applied')
    return `已上传并确认页面接收 ${result.appliedFiles ?? requested} 个文件`;
  return String(result.warning ?? `【upload 未确认】请求 ${requested} 个文件`);
}

/** 透传服务端 press 的 effect（activated/none/dispatched）；老服务端没有 effect 时按 dispatched 兜底（issue #3）。 */
function normalizePressResult(raw: unknown): Record<string, unknown> {
  const result =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const effect = result.effect;
  return {
    ok: result.ok !== false,
    effect:
      effect === 'activated' || effect === 'none' || effect === 'dispatched'
        ? effect
        : 'dispatched',
    ...(typeof result.detectedBy === 'string' ? { detectedBy: result.detectedBy } : {}),
  };
}
/** 指针操作只能确认已派发：画面里发生了什么得靠截图复核（issue #7）。 */
function pointerText(action: Record<string, unknown>): string {
  return `已派发：${describePointerAction(normalizePointerAction(action))}（页面是否响应请截图复核）`;
}

/** observe 文本里的指针面列：box 写成 x,y,w,h，可以原样交给 screenshot --clip。 */
function surfaceColumn(element: { surface?: boolean; box?: SurfaceBox }): string {
  if (element.surface !== true) return '';
  const box = element.box;
  return box ? `指针面 ${box.x},${box.y},${box.width},${box.height}\t` : '指针面（无布局）\t';
}

function pressText(result: Record<string, unknown>, key: string): string {
  if (result.effect === 'activated') return `已按 ${key}（页面已响应）`;
  if (result.effect === 'none') return `已按 ${key}（页面无变化，请用 read/observe 复核）`;
  return `已派发 ${key}（无法确认页面是否响应）`;
}

const handlers: Record<string, Handler> = {
  async space(ctx) {
    const sub = ctx.args.rest.shift() ?? '';
    await (await import('./space.js')).handleSpace(sub, ctx);
  },
  async skill(ctx) {
    ctx.io.stdout(renderGuide(ctx.version));
  },
  async version(ctx) {
    printResult(ctx.io, ctx.args.json, { version: ctx.version }, ctx.version);
  },
  async status(ctx) {
    if (!ctx.status) throw new CliError('status 不可用');
    const report = await ctx.status();
    const failed = report.filter((line) => !line.ok).map((line) => line.item);
    const message = `检查未通过：${failed.join(', ')}`;
    // --json：一行 {"ok","checks"} 就是全部输出；失败只靠退出码表达，不再追加 {"error"}。
    if (ctx.args.json) {
      ctx.io.stdout(JSON.stringify({ ok: !failed.length, checks: report }));
      if (failed.length) throw new CliError(message, true);
      return;
    }
    for (const line of report)
      ctx.io.stdout(`${line.item}\t${line.ok ? 'ok' : 'FAIL'}\t${line.detail}`);
    if (failed.length) throw new CliError(message);
  },
  async info(ctx) {
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.page_info',
      args: { tabId: await tabId(ctx, call) },
    })) as { title?: string; url?: string; loading?: boolean };
    printResult(
      ctx.io,
      ctx.args.json,
      result,
      `${result.title ?? ''}\n${result.url ?? ''}${result.loading ? '\n（加载中）' : ''}`,
    );
  },
  async select(ctx) {
    const usage = "pilion select --ref '<elementRef json>' --value '<option value>' [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const value = need(ctx.args.value, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.select',
      args: { tabId: await tabId(ctx, call), elementRef: ref, value },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已选择');
  },
  async check(ctx) {
    const usage = "pilion check --ref '<elementRef json>' [--off] [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.check',
      args: { tabId: await tabId(ctx, call), elementRef: ref, checked: !ctx.args.off },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, ctx.args.off ? '已取消勾选' : '已勾选');
  },
  async press(ctx) {
    const usage = "pilion press <key> [--ref '<elementRef json>'] [--tab <id>]";
    const key = need(ctx.args.rest[0], usage);
    if (!isPressKey(key)) throw new CliError(`不支持的按键；可用：${PRESS_KEYS.join(', ')}`);
    // 省略 --ref / --ref-file 时按键发给 document.activeElement（issue #3）。
    const hasRef = ctx.args.ref !== undefined || ctx.args.refFile !== undefined;
    const ref = hasRef ? await elementRef(ctx, usage) : undefined;
    const call = await ctx.call();
    const raw = await call({
      name: 'browser.press',
      args: {
        tabId: await tabId(ctx, call),
        ...(ref === undefined ? {} : { elementRef: ref }),
        key,
      },
    });
    const result = normalizePressResult(raw);
    printResult(ctx.io, ctx.args.json, result, pressText(result, key));
  },
  async hover(ctx) {
    const usage = "pilion hover --ref '<elementRef json>' [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.hover',
      args: { tabId: await tabId(ctx, call), elementRef: ref },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已悬停');
  },
  async pointer(ctx) {
    // 子命令与坐标先在本地校验：用法错不连接、不发请求。
    const action = pointerAction(ctx.args.rest[0], ctx.args);
    const ref = await elementRef(ctx, POINTER_USAGE);
    const call = await ctx.call();
    const raw = await call({
      name: 'browser.pointer',
      args: { tabId: await tabId(ctx, call), elementRef: ref, action },
    });
    const result =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    printResult(
      ctx.io,
      ctx.args.json,
      { ok: result.ok !== false, effect: 'dispatched' },
      pointerText(action),
    );
  },
  async scroll(ctx) {
    const usage = 'pilion scroll <up|down> [--amount <px>] [--tab <id>]';
    const direction = need(ctx.args.rest[0], usage);
    if (direction !== 'up' && direction !== 'down') throw new CliError('方向只能是 up 或 down');
    const amount = ctx.args.amount === undefined ? undefined : Number(ctx.args.amount);
    if (amount !== undefined && (!Number.isInteger(amount) || amount < 1 || amount > 10_000))
      throw new CliError('--amount 必须是 1..10000 的整数（CSS 像素）');
    const call = await ctx.call();
    await call({
      name: 'browser.scroll',
      args: {
        tabId: await tabId(ctx, call),
        direction,
        ...(amount === undefined ? {} : { amount }),
      },
    });
    printResult(
      ctx.io,
      ctx.args.json,
      { ok: true },
      `已${direction === 'down' ? '向下' : '向上'}滚动${amount === undefined ? '' : ` ${amount}px`}`,
    );
  },
  async upload(ctx) {
    const usage =
      "pilion upload --ref '<elementRef json>' --file <绝对路径> [--file ...] [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const files = ctx.args.files ?? [];
    if (!files.length) throw new CliError(usage);
    const call = await ctx.call();
    const raw = await call({
      name: 'browser.upload_file',
      args: { tabId: await tabId(ctx, call), elementRef: ref, files },
    });
    const result = normalizeUploadResult(raw, files.length);
    printResult(ctx.io, ctx.args.json, result, uploadText(result, files.length));
  },
  async tabs(ctx) {
    const call = await ctx.call();
    const tabs = (await call({ name: 'browser.tabs.list', args: {} })) as Tab[];
    const text = tabs.length
      ? tabs
          .map((t) => `${t.id}\t${t.loading ? '…' : ''}\t${t.title || '(无标题)'}\t${t.url}`)
          .join('\n')
      : '（没有标签）';
    printResult(ctx.io, ctx.args.json, tabs, text);
  },
  async new(ctx) {
    const url = need(ctx.args.rest[0], 'pilion new <url>');
    const call = await ctx.call();
    const result = (await call({ name: 'browser.tabs.open', args: { url } })) as { tabId: string };
    printResult(ctx.io, ctx.args.json, result, result.tabId);
  },
  async close(ctx) {
    const id = need(ctx.args.rest[0], 'pilion close <tabId>');
    const call = await ctx.call();
    await call({ name: 'browser.tabs.close', args: { tabId: id } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已关闭');
  },
  async activate(ctx) {
    const id = need(ctx.args.rest[0], 'pilion activate <tabId>');
    const call = await ctx.call();
    await call({ name: 'browser.tabs.activate', args: { tabId: id } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已激活');
  },
  async navigate(ctx) {
    const url = need(ctx.args.rest[0], 'pilion navigate <url> [--tab <id>]');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.navigate',
      args: { tabId: await tabId(ctx, call), url },
    })) as { url: string };
    printResult(ctx.io, ctx.args.json, result, result.url);
  },
  async read(ctx) {
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.snapshot',
      args: { tabId: await tabId(ctx, call) },
    })) as { url: string; title: string; text?: string };
    printResult(
      ctx.io,
      ctx.args.json,
      result,
      `${result.title}\n${result.url}\n\n${result.text ?? ''}`,
    );
  },
  async observe(ctx) {
    const offset = ctx.args.offset === undefined ? undefined : Number(ctx.args.offset);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000))
      throw new CliError('--offset 必须是 0 到 100000 的整数');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.observe',
      args: { tabId: await tabId(ctx, call), ...(offset === undefined ? {} : { offset }) },
    })) as {
      elements: Array<{
        ref: unknown;
        role: string;
        name: string;
        surface?: boolean;
        box?: SurfaceBox;
      }>;
    };
    const text = result.elements
      .map(
        (el) =>
          `${el.role}\t${el.name || '(未命名)'}\t${surfaceColumn(el)}${JSON.stringify(el.ref)}`,
      )
      .join('\n');
    printResult(ctx.io, ctx.args.json, result.elements, text);
  },
  async click(ctx) {
    const usage = "pilion click --ref '<elementRef json>' [--force] [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.click',
      args: {
        tabId: await tabId(ctx, call),
        elementRef: ref,
        ...(ctx.args.force ? { force: true } : {}),
      },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已点击');
  },
  async type(ctx) {
    const usage = "pilion type --ref '<elementRef json>' --text '...' [--replace] [--tab <id>]";
    const ref = await elementRef(ctx, usage);
    const text = await inputFile(ctx.args.text, ctx.args.textFile, '--text');
    if (text === undefined) throw new CliError(`用法: ${usage}`);
    const call = await ctx.call();
    await call({
      name: 'browser.type',
      args: {
        tabId: await tabId(ctx, call),
        elementRef: ref,
        text,
        ...(ctx.args.replace ? { replace: true } : {}),
      },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已输入');
  },
  async screenshot(ctx) {
    const usage =
      'pilion screenshot -o <file.png|.jpg|.jpeg> [--force] [--tab <id>] ' +
      '[--scale 0.1..1] [--quality 1..100] [--format png|jpeg] [--clip x,y,w,h]';
    const outPath = need(ctx.args.out, usage);
    const ext = extname(outPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext))
      throw new CliError('截图输出必须以 .png、.jpg 或 .jpeg 结尾');
    const shotArgs = screenshotArgs(ctx.args);
    // -o 是 jpg/jpeg 且未指定格式时默认请求 jpeg，后缀才对得上。
    if (shotArgs.format === undefined && (ext === '.jpg' || ext === '.jpeg'))
      shotArgs.format = 'jpeg';
    // 拒绝 symlink（即便 --force）；默认拒绝已存在的文件，--force 才覆盖。先查再截，避免白截。
    const existing = await lstat(outPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new CliError('拒绝写入符号链接路径');
    if (existing && !ctx.args.force) throw new CliError('文件已存在（--force 覆盖）');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.screenshot',
      args: { tabId: await tabId(ctx, call), ...shotArgs },
    })) as {
      data: string;
      mimeType?: string;
      format?: string;
      downgraded?: boolean;
      quality?: number;
      scale?: number;
      width?: number;
      height?: number;
      cssWidth?: number;
      cssHeight?: number;
      partial?: boolean;
    };
    const mimeType = result.mimeType ?? 'image/png';
    const actualExt = mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const compatible = actualExt === '.jpg' ? ext === '.jpg' || ext === '.jpeg' : ext === '.png';
    let finalPath = outPath;
    if (!compatible) {
      if (actualExt === '.png')
        // 结果是 PNG，不把 PNG 内容写成 .jpg；提示改用 .png 或显式 --format jpeg。
        throw new CliError('截图实际为 image/png，输出文件应以 .png 结尾（或加 --format jpeg）');
      // 结果是 JPEG（含自动降级）：按实际返回格式纠正后缀，仍不报错。
      finalPath = `${outPath.slice(0, outPath.length - ext.length)}${actualExt}`;
    }
    // 纠正后的目标路径同样要过 symlink / 已存在保护，不能被绕过。
    const target = finalPath === outPath ? existing : await lstat(finalPath).catch(() => undefined);
    if (target?.isSymbolicLink()) throw new CliError('拒绝写入符号链接路径');
    if (target && !ctx.args.force) throw new CliError('文件已存在（--force 覆盖）');
    await mkdir(dirname(finalPath), { recursive: true });
    await fsWriteFile(finalPath, Buffer.from(result.data, 'base64'), {
      flag: target && ctx.args.force ? 'w' : 'wx',
    });
    printResult(
      ctx.io,
      ctx.args.json,
      {
        ok: true,
        file: finalPath,
        format: result.format ?? (mimeType === 'image/jpeg' ? 'jpeg' : 'png'),
        downgraded: result.downgraded ?? false,
        ...(result.quality !== undefined ? { quality: result.quality } : {}),
        ...(result.scale !== undefined ? { scale: result.scale } : {}),
        // 瞄准用：图片像素 × cssWidth / width = 页面 CSS 像素（issue #7）。
        ...(typeof result.width === 'number' && typeof result.cssWidth === 'number'
          ? {
              width: result.width,
              height: result.height,
              cssWidth: result.cssWidth,
              cssHeight: result.cssHeight,
            }
          : {}),
        // clip 有一部分在视口外：那部分是空白，先滚动再截才看得到。
        ...(result.partial === true ? { partial: true } : {}),
      },
      finalPath,
    );
  },
};
handlers.snapshot = handlers.read!;

export async function runCommand(command: string, ctx: CommandContext): Promise<void> {
  validateArgs(command, ctx.args);
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (!handler) throw new CliError(USAGE);
  await handler(ctx);
}

/** 入口用的统一出口：跑命令，出错时打印一次错误（静默的 CliError 除外），返回退出码。 */
export async function runCli(command: string, ctx: CommandContext): Promise<number> {
  try {
    await runCommand(command, ctx);
    return 0;
  } catch (error) {
    if (!(error instanceof CliError && error.silent))
      printError(ctx.io, ctx.args.json, error instanceof Error ? error : String(error));
    return 1;
  }
}
