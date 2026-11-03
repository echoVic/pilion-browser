#!/usr/bin/env node
/**
 * 外部命令行 `pilion`：解析参数 → 交给 cli/commands → 统一错误出口。
 * 输出人类可读文本，加 `--json` 输出机器可读 JSON。与 MCP 入口走同一个认证 socket。
 * 省略 --tab 时默认选「本 principal 自己打开的第一个标签」，绝不碰用户正在看的标签。
 */
import { access, constants } from 'node:fs/promises';
import type { ToolName } from '../../shared/contracts.js';
import { parseArgv } from './cli/args.js';
import { runCommand, type CallTool, type StatusReport } from './cli/commands.js';
import { printError, processIo } from './cli/output.js';
import { cliVersion } from './cli/version.js';
import { callTool, handshake, resolveEndpoint } from './client.js';

const version = cliVersion();
const { command, args } = parseArgv(process.argv.slice(2));
let tool: CallTool | undefined;

async function status(): Promise<StatusReport> {
  const report: StatusReport = [{ item: 'cli', ok: true, detail: `pilion ${version}` }];
  const socket = process.env.PILION_EXTERNAL_SOCKET;
  const socketOk =
    Boolean(socket) &&
    (await access(socket!, constants.W_OK).then(
      () => true,
      () => false,
    ));
  report.push({
    item: 'socket',
    ok: socketOk,
    detail: socketOk ? socket! : 'Pilion 没有在运行，或「对外控制」已关闭：请打开 Pilion',
  });
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
    report.push({ item: 'credential', ok: true, detail: '已找到' });
  } catch {
    report.push({
      item: 'credential',
      ok: false,
      detail: '没有凭证：在 Pilion「设置 › 对外控制」点「安装到 Agent」',
    });
  }
  if (socketOk && endpoint) {
    try {
      const ack = await handshake(endpoint);
      report.push({ item: 'handshake', ok: true, detail: '已认证' });
      const same = !ack.version || ack.version === version;
      report.push({
        item: 'version',
        ok: same,
        detail: same
          ? `Pilion ${ack.version ?? '(旧版未上报)'}`
          : `Pilion ${ack.version} 与 CLI ${version} 不一致：请重启 Pilion`,
      });
    } catch (error) {
      report.push({
        item: 'handshake',
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)}：凭证可能已被吊销，请重新「安装到 Agent」`,
      });
    }
  }
  return report;
}

try {
  await runCommand(command, {
    args,
    io: processIo,
    version,
    status,
    call: async () => {
      if (!tool) {
        const endpoint = await resolveEndpoint();
        tool = (request) => callTool(endpoint, { ...request, name: request.name as ToolName });
      }
      return tool;
    },
  });
} catch (error) {
  printError(processIo, args.json, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
