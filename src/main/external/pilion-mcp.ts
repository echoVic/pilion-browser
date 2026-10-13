#!/usr/bin/env node
/**
 * 外部 stdio MCP 入口：由外部 Agent（Claude Desktop / Cursor 等）以子进程启动。
 * 它本身不碰浏览器，只把 MCP 工具调用经认证的本地 Unix socket 转发给正在运行的 Pilion。
 * socket 与 token 来自环境变量或 userData 下的 0600 配置文件（见 resolveEndpoint）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserMcpServer } from '../agents/browser-mcp-server.js';
import { callTool, resolveEndpoint } from './client.js';
import { EXTERNAL_TOOLS } from './types.js';

const endpoint = await resolveEndpoint();
const server = createBrowserMcpServer((name, args) => callTool(endpoint, { name, args }), {
  tools: EXTERNAL_TOOLS,
});
await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
);
