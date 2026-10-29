import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { ToolRequest } from '../../shared/contracts.js';

export interface ExternalEndpoint {
  socketPath: string;
  token: string;
}

/**
 * 客户端找 socket + token 的顺序（不再自动读取 userData 共享 token——那是旧模型）：
 *  1. 环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN（设置页按客户端复制的配置直接注入）；
 *  2. token 也可由 PILION_EXTERNAL_TOKEN_FILE 指向用户自己保存的 0600 文件。
 * 两个都缺就报错，要求用户先在设置页「新增客户端」拿 token。
 */
export async function resolveEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalEndpoint> {
  const socketPath = env.PILION_EXTERNAL_SOCKET;
  let token = env.PILION_EXTERNAL_TOKEN;
  if (!token && env.PILION_EXTERNAL_TOKEN_FILE) {
    token = (await readFile(env.PILION_EXTERNAL_TOKEN_FILE, 'utf8')).trim();
  }
  if (!socketPath || !token) {
    throw new Error(
      '缺少 Pilion 外部凭证：请在 Pilion 设置页「外部控制」新增客户端，' +
        '并通过环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN 注入。',
    );
  }
  return { socketPath, token };
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
      socket.write(`${JSON.stringify({ token: endpoint.token })}\n`);
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
