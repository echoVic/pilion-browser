import { lstat, mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PressKeySchema } from '../../../shared/contracts.js';
import { renderGuide } from './guide.js';
import type { CliArgs } from './args.js';
import { CliError, printResult, type CliIo } from './output.js';

export type CallTool = (request: {
  name: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export type StatusLine = { item: string; ok: boolean; detail: string };
export type StatusReport = StatusLine[];

export interface CommandContext {
  args: CliArgs;
  io: CliIo;
  /** 懒取：skill / version / status 不需要（或要自己处理）凭证。 */
  call: () => Promise<CallTool>;
  version: string;
  /** `pilion status` 的检查项；入口提供真实实现，测试注入假实现。 */
  status?: () => Promise<StatusReport>;
}

type Tab = { id: string; title: string; url: string; loading: boolean };
type Handler = (ctx: CommandContext) => Promise<void>;

export const USAGE = [
  '用法: pilion <命令> [选项]',
  '  tabs                       列出本通道打开的标签',
  '  new <url>                  打开标签',
  '  activate <id>              激活标签',
  '  close <id>                 关闭标签',
  '  navigate <url> [--tab id]  导航',
  '  read [--tab id]            读标签正文',
  '  observe [--tab id]         列出可交互元素（含 elementRef）',
  '  click --ref <json>         点击观察到的元素',
  '  type --ref <json> --text s [--replace]  输入文本',
  '  screenshot -o file.png     截图',
  '  info [--tab id]            页面信息',
  '  select --ref <json> --value v  选择下拉项',
  '  check --ref <json> [--off] 勾选/取消勾选',
  '  press <key> --ref <json>   按键',
  '  status                     检查连接与凭证',
  '  skill                      打印给 Agent 的用法指南',
  '  version                    打印版本',
  '全局: --json',
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

async function tabId(ctx: CommandContext, call: CallTool): Promise<string> {
  if (ctx.args.tab) return ctx.args.tab;
  const tabs = (await call({ name: 'browser.tabs.list', args: {} })) as Tab[];
  if (!tabs.length) throw new CliError('没有可用标签，先用 `pilion new <url>` 打开一个');
  return tabs[0]!.id;
}

const handlers: Record<string, Handler> = {
  async skill(ctx) {
    ctx.io.stdout(renderGuide(ctx.version));
  },
  async version(ctx) {
    printResult(ctx.io, ctx.args.json, { version: ctx.version }, ctx.version);
  },
  async status(ctx) {
    if (!ctx.status) throw new CliError('status 不可用');
    const report = await ctx.status();
    if (ctx.args.json) ctx.io.stdout(JSON.stringify(report, null, 2));
    else
      for (const line of report)
        ctx.io.stdout(`${line.item}\t${line.ok ? 'ok' : 'FAIL'}\t${line.detail}`);
    const failed = report.filter((line) => !line.ok).map((line) => line.item);
    if (failed.length) throw new CliError(`检查未通过：${failed.join(', ')}`);
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
    const elementRef = parseRef(ctx.args.ref, usage);
    const value = need(ctx.args.value, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.select',
      args: { tabId: await tabId(ctx, call), elementRef, value },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已选择');
  },
  async check(ctx) {
    const usage = "pilion check --ref '<elementRef json>' [--off] [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.check',
      args: { tabId: await tabId(ctx, call), elementRef, checked: !ctx.args.off },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, ctx.args.off ? '已取消勾选' : '已勾选');
  },
  async press(ctx) {
    const usage = "pilion press <key> --ref '<elementRef json>' [--tab <id>]";
    const key = PressKeySchema.safeParse(need(ctx.args.rest[0], usage));
    if (!key.success)
      throw new CliError(`不支持的按键；可用：${PressKeySchema.options.join(', ')}`);
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.press',
      args: { tabId: await tabId(ctx, call), elementRef, key: key.data },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, `已按 ${key.data}`);
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
    if (!ctx.args.json) ctx.io.stdout('已关闭');
  },
  async activate(ctx) {
    const id = need(ctx.args.rest[0], 'pilion activate <tabId>');
    const call = await ctx.call();
    await call({ name: 'browser.tabs.activate', args: { tabId: id } });
    if (!ctx.args.json) ctx.io.stdout('已激活');
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
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.observe',
      args: { tabId: await tabId(ctx, call) },
    })) as { elements: Array<{ ref: unknown; role: string; name: string }> };
    const text = result.elements
      .map((el) => `${el.role}\t${el.name || '(未命名)'}\t${JSON.stringify(el.ref)}`)
      .join('\n');
    printResult(ctx.io, ctx.args.json, result.elements, text);
  },
  async click(ctx) {
    const usage = "pilion click --ref '<elementRef json>' [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({ name: 'browser.click', args: { tabId: await tabId(ctx, call), elementRef } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已点击');
  },
  async type(ctx) {
    const usage = "pilion type --ref '<elementRef json>' --text '...' [--replace] [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    if (ctx.args.text === undefined) throw new CliError(`用法: ${usage}`);
    const call = await ctx.call();
    await call({
      name: 'browser.type',
      args: {
        tabId: await tabId(ctx, call),
        elementRef,
        text: ctx.args.text,
        ...(ctx.args.replace ? { replace: true } : {}),
      },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已输入');
  },
  async screenshot(ctx) {
    const outPath = need(ctx.args.out, 'pilion screenshot -o <file.png> [--force] [--tab <id>]');
    if (!outPath.toLowerCase().endsWith('.png')) throw new CliError('截图输出必须以 .png 结尾');
    // 拒绝 symlink（即便 --force）；默认拒绝已存在的文件，--force 才覆盖。先查再截，避免白截。
    const existing = await lstat(outPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new CliError('拒绝写入符号链接路径');
    if (existing && !ctx.args.force) throw new CliError('文件已存在（--force 覆盖）');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.screenshot',
      args: { tabId: await tabId(ctx, call) },
    })) as { data: string };
    await mkdir(dirname(outPath), { recursive: true });
    await fsWriteFile(outPath, Buffer.from(result.data, 'base64'), {
      flag: existing && ctx.args.force ? 'w' : 'wx',
    });
    printResult(ctx.io, ctx.args.json, { ok: true, file: outPath }, outPath);
  },
};
handlers.snapshot = handlers.read!;

export async function runCommand(command: string, ctx: CommandContext): Promise<void> {
  const handler = handlers[command];
  if (!handler) throw new CliError(USAGE);
  await handler(ctx);
}
