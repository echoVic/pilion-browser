#!/usr/bin/env node
/**
 * 外部命令行 `pilion`：解析参数 → 交给 cli/commands → 统一错误出口。
 * 输出人类可读文本，加 `--json` 输出机器可读 JSON。与 MCP 入口走同一个认证 socket。
 * 省略 --tab 时默认选「本 principal 自己打开的第一个标签」，绝不碰用户正在看的标签。
 */
import type { ToolName } from '../../shared/contracts.js';
import { parseArgv } from './cli/args.js';
import { runCommand, type CallTool } from './cli/commands.js';
import { printError, processIo } from './cli/output.js';
import { callTool, resolveEndpoint } from './client.js';

const { command, args } = parseArgv(process.argv.slice(2));
let tool: CallTool | undefined;
try {
  await runCommand(command, {
    args,
    io: processIo,
    version: '0.0',
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
