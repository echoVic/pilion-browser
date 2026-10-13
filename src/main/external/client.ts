import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolRequest } from '../../shared/contracts.js';
import { readEndpointFile } from './server.js';

export interface ExternalEndpoint {
  socketPath: string;
  token: string;
  client: string;
}

/**
 * 客户端找 socket + token 的顺序：
 *  1. 环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN（设置页复制的配置直接注入）；
 *  2. PILION_EXTERNAL_CONFIG 指向的 0600 配置文件；
 *  3. 默认 userData 下的 external-mcp.json。
 */
export async function resolveEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalEndpoint> {
  const client = env.PILION_EXTERNAL_CLIENT || 'stdio';
  const socketPath = env.PILION_EXTERNAL_SOCKET;
  const token = env.PILION_EXTERNAL_TOKEN;
  if (socketPath && token) return { socketPath, token, client };
  const configPath = env.PILION_EXTERNAL_CONFIG || defaultConfigPath();
  const endpoint = await readEndpointFile(configPath);
  return { ...endpoint, client };
}

function defaultConfigPath(): string {
  // 与 Electron userData 对齐：macOS ~/Library/Application Support/Pilion，Linux ~/.config/Pilion。
  const home = homedir();
  if (process.platform === 'darwin')
    return join(home, 'Library/Application Support/Pilion/external/external-mcp.json');
  if (process.platform === 'win32')
    return join(
      process.env.APPDATA || join(home, 'AppData/Roaming'),
      'Pilion/external/external-mcp.json',
    );
  return join(
    process.env.XDG_CONFIG_HOME || join(home, '.config'),
    'Pilion/external/external-mcp.json',
  );
}

/** 连上 socket、先握手再跑一个工具请求，返回工具结果。短连接 CLI 与长连接 MCP 都用它发请求。 */
export function callTool(
  endpoint: ExternalEndpoint,
  request: Omit<ToolRequest, 'requestId'> & { requestId?: string },
): Promise<unknown> {
  const id = randomUUID();
  const fullRequest: ToolRequest = {
    requestId: request.requestId ?? id,
    name: request.name,
    args: request.args ?? {},
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
  };
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handshook = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(90_000, () => finish(new Error('Pilion external call timed out')));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: endpoint.token, client: endpoint.client })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        finish(new Error('Pilion external response exceeded the frame limit'));
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        let msg: { id?: string; result?: unknown; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          finish(new Error('Pilion external returned a malformed frame'));
          return;
        }
        if (msg.error && !handshook) {
          finish(new Error(msg.error));
          return;
        }
        if (!handshook) {
          handshook = true;
          socket.write(`${JSON.stringify({ id, request: fullRequest })}\n`);
          continue;
        }
        if (msg.id !== id) continue;
        if (msg.error) finish(new Error(msg.error));
        else finish(undefined, msg.result);
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () =>
      finish(new Error('Pilion external connection closed without a response')),
    );
  });
}
