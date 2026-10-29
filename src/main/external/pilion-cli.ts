#!/usr/bin/env node
/**
 * 外部命令行：`pilion tabs / new <url> / read / observe / click / type / navigate / screenshot`。
 * 输出人类可读文本，加 `--json` 输出机器可读 JSON。与 MCP 入口走同一个认证 socket。
 * 省略 tab 时默认选「本 principal 自己打开的第一个标签」，绝不碰用户正在看的标签。
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { callTool, resolveEndpoint, type ExternalEndpoint } from './client.js';

type Tab = { id: string; title: string; url: string; loading: boolean };
type Args = {
  json: boolean;
  tab?: string;
  ref?: string;
  text?: string;
  out?: string;
  force: boolean;
  rest: string[];
};

function parseArgv(argv: string[]): { command: string; args: Args } {
  const rest: string[] = [];
  let json = false;
  let tab: string | undefined;
  let ref: string | undefined;
  let text: string | undefined;
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--tab') tab = argv[++i];
    else if (arg === '--ref') ref = argv[++i];
    else if (arg === '--text') text = argv[++i];
    else if (arg === '-o' || arg === '--out') out = argv[++i];
    else if (arg === '--force') force = true;
    else if (arg === '--replace') rest.push(arg);
    else rest.push(arg);
  }
  const command = rest.shift() ?? '';
  return { command, args: { json, tab, ref, text, out, force, rest } };
}

function fail(message: string, json: boolean): never {
  if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  else process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function firstTabId(endpoint: ExternalEndpoint): Promise<string> {
  const tabs = (await callTool(endpoint, { name: 'browser.tabs.list', args: {} })) as Tab[];
  if (!tabs.length) throw new Error('没有可用标签，先用 `pilion new <url>` 打开一个');
  return tabs[0]!.id;
}

async function main(): Promise<void> {
  const { command, args } = parseArgv(process.argv.slice(2));
  const endpoint = await resolveEndpoint();
  try {
    switch (command) {
      case 'tabs': {
        const tabs = (await callTool(endpoint, { name: 'browser.tabs.list', args: {} })) as Tab[];
        if (args.json) console.log(JSON.stringify(tabs, null, 2));
        else if (!tabs.length) console.log('（没有标签）');
        else
          for (const tab of tabs)
            console.log(
              `${tab.id}\t${tab.loading ? '…' : ''}\t${tab.title || '(无标题)'}\t${tab.url}`,
            );
        return;
      }
      case 'new': {
        const url = args.rest[0];
        if (!url) fail('用法: pilion new <url>', args.json);
        const result = (await callTool(endpoint, {
          name: 'browser.tabs.open',
          args: { url },
        })) as { tabId: string };
        if (args.json) console.log(JSON.stringify(result));
        else console.log(result.tabId);
        return;
      }
      case 'close': {
        const tabId = args.rest[0];
        if (!tabId) fail('用法: pilion close <tabId>', args.json);
        await callTool(endpoint, { name: 'browser.tabs.close', args: { tabId } });
        if (!args.json) console.log('已关闭');
        return;
      }
      case 'activate': {
        const tabId = args.rest[0];
        if (!tabId) fail('用法: pilion activate <tabId>', args.json);
        await callTool(endpoint, { name: 'browser.tabs.activate', args: { tabId } });
        if (!args.json) console.log('已激活');
        return;
      }
      case 'navigate': {
        const url = args.rest[0];
        if (!url) fail('用法: pilion navigate <url> [--tab <id>]', args.json);
        const tabId = args.tab ?? (await firstTabId(endpoint));
        const result = (await callTool(endpoint, {
          name: 'browser.navigate',
          args: { tabId, url },
        })) as { url: string };
        if (args.json) console.log(JSON.stringify(result));
        else console.log(result.url);
        return;
      }
      case 'read':
      case 'snapshot': {
        const tabId = args.tab ?? (await firstTabId(endpoint));
        const result = (await callTool(endpoint, {
          name: 'browser.snapshot',
          args: { tabId },
        })) as { url: string; title: string; loading: boolean; text: string };
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.title}\n${result.url}\n\n${result.text ?? ''}`);
        return;
      }
      case 'observe': {
        const tabId = args.tab ?? (await firstTabId(endpoint));
        const result = (await callTool(endpoint, {
          name: 'browser.observe',
          args: { tabId },
        })) as { elements: Array<{ ref: unknown; role: string; name: string; tagName: string }> };
        if (args.json) console.log(JSON.stringify(result.elements, null, 2));
        else
          for (const el of result.elements)
            console.log(`${el.role}\t${el.name || '(未命名)'}\t${JSON.stringify(el.ref)}`);
        return;
      }
      case 'click': {
        const tabId = args.tab ?? (await firstTabId(endpoint));
        if (!args.ref) fail("用法: pilion click --ref '<elementRef json>' [--tab <id>]", args.json);
        await callTool(endpoint, {
          name: 'browser.click',
          args: { tabId, elementRef: JSON.parse(args.ref) },
        });
        if (!args.json) console.log('已点击');
        return;
      }
      case 'type': {
        const tabId = args.tab ?? (await firstTabId(endpoint));
        if (!args.ref || args.text === undefined)
          fail("用法: pilion type --ref '<elementRef json>' --text '...' [--tab <id>]", args.json);
        await callTool(endpoint, {
          name: 'browser.type',
          args: { tabId, elementRef: JSON.parse(args.ref), text: args.text },
        });
        if (!args.json) console.log('已输入');
        return;
      }
      case 'screenshot': {
        const tabId = args.tab ?? (await firstTabId(endpoint));
        const result = (await callTool(endpoint, {
          name: 'browser.screenshot',
          args: { tabId },
        })) as { mimeType: 'image/png'; data: string };
        if (!args.out) fail('用法: pilion screenshot -o <file.png>', args.json);
        const outPath = args.out;
        if (!outPath.toLowerCase().endsWith('.png')) fail('截图输出必须以 .png 结尾', args.json);
        // 拒绝 symlink（即便 --force）；默认拒绝已存在的文件，--force 才覆盖。
        const existing = await lstat(outPath).catch(() => undefined);
        if (existing?.isSymbolicLink()) fail('拒绝写入符号链接路径', args.json);
        if (existing && !args.force) fail('文件已存在（--force 覆盖）', args.json);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, Buffer.from(result.data, 'base64'), {
          flag: existing && args.force ? 'w' : 'wx',
        });
        if (args.json) console.log(JSON.stringify({ ok: true, file: outPath }));
        else console.log(outPath);
        return;
      }
      default:
        fail(
          [
            '用法: pilion <命令> [选项]',
            '  tabs                       列出本通道打开的标签',
            '  new <url>                   打开标签',
            '  activate <id>              激活标签',
            '  close <id>                 关闭标签',
            '  navigate <url> [--tab id]  导航',
            '  read                       读当前标签正文',
            '  observe [--tab id]         列出可交互元素（含 elementRef）',
            '  click --ref <json>         点击观察到的元素',
            '  type --ref <json> --text s 输入文本',
            '  screenshot -o file.png     截图',
            '全局: --json',
          ].join('\n'),
          args.json,
        );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), args.json);
  }
}

await main();
