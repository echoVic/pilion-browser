import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { ToolRequest } from '../../shared/contracts.js';

export interface ExternalEndpoint {
  socketPath: string;
  token: string;
  space?: string;
}

export interface ExternalErrorDiagnostics {
  code?: string;
  retryable?: boolean;
  outcome?: 'unknown' | 'not_applied';
}

/** Only bounded diagnostics cross the external boundary; never serialize arbitrary Error details. */
export function externalErrorDiagnostics(value: unknown): ExternalErrorDiagnostics {
  if (!value || typeof value !== 'object') return {};
  const fields = value as Record<string, unknown>;
  return {
    ...(typeof fields.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(fields.code)
      ? { code: fields.code }
      : {}),
    ...(typeof fields.retryable === 'boolean' ? { retryable: fields.retryable } : {}),
    ...(fields.outcome === 'unknown' || fields.outcome === 'not_applied'
      ? { outcome: fields.outcome }
      : {}),
  };
}

export class ExternalCallError extends Error implements ExternalErrorDiagnostics {
  readonly name = 'ExternalCallError';
  declare readonly code?: string;
  declare readonly retryable?: boolean;
  declare readonly outcome?: 'unknown' | 'not_applied';

  constructor(message: string, diagnostics?: unknown) {
    super(message);
    Object.assign(this, externalErrorDiagnostics(diagnostics));
  }
}

/**
 * 客户端找 socket + token 的顺序（不再自动读取 userData 共享 token——那是旧模型）：
 *  1. 环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN（设置页按客户端复制的配置直接注入）；
 *  2. token 也可由 PILION_EXTERNAL_TOKEN_FILE 指向用户自己保存的 0600 文件。
 * 两个都缺就报错，提示用户点「安装到 Agent」或在设置页「新增客户端」拿 token。
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
      '缺少 Pilion 外部凭证：在 Pilion「设置 › 对外控制」点「安装到 Agent」；' +
        '或在那里新增客户端，并通过环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN 注入。',
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
    // Once queued to the socket, loss of a response cannot establish the tool's outcome.
    let dispatched = false;
    const transportError = (message: string, code: string, original?: Error) =>
      new ExternalCallError(message, {
        ...externalErrorDiagnostics(original),
        code,
        ...(dispatched ? { outcome: 'unknown' } : {}),
      });
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(90_000, () =>
      finish(transportError('Pilion external call timed out', 'PILION_EXTERNAL_TIMEOUT')),
    );
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify(endpoint.space ? { token: endpoint.token, space: endpoint.space } : { token: endpoint.token })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        finish(
          transportError(
            'Pilion external response exceeded the frame limit',
            'PILION_EXTERNAL_RESPONSE_LIMIT',
          ),
        );
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0 && !settled) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        let msg: { id?: string; result?: unknown; error?: string } & ExternalErrorDiagnostics;
        try {
          msg = JSON.parse(line);
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('bad frame');
        } catch {
          finish(
            transportError(
              'Pilion external returned a malformed frame',
              'PILION_EXTERNAL_MALFORMED_RESPONSE',
            ),
          );
          return;
        }
        if (typeof msg.error === 'string' && !handshook) {
          finish(new ExternalCallError(msg.error, msg));
          return;
        }
        if (!handshook) {
          handshook = true;
          dispatched = true;
          socket.write(`${JSON.stringify({ id, request: fullRequest })}\n`);
          continue;
        }
        if (msg.id !== id) continue;
        if (typeof msg.error === 'string') finish(new ExternalCallError(msg.error, msg));
        else finish(undefined, msg.result);
      }
    });
    socket.once('error', (error) =>
      finish(
        transportError(
          error.message,
          externalErrorDiagnostics(error).code ?? 'PILION_EXTERNAL_CONNECTION_ERROR',
          error,
        ),
      ),
    );
    const closed = () =>
      finish(
        transportError(
          'Pilion external connection closed without a response',
          'PILION_EXTERNAL_CONNECTION_CLOSED',
        ),
      );
    socket.once('end', closed);
    socket.once('close', closed);
  });
}

/** 发控制帧，不依赖 Space admission；创建、列出和关闭空间都使用基础连接。 */
export function callControl(endpoint: ExternalEndpoint, control: object): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handshook = false;
    let dispatched = false;
    const transportError = (message: string, code: string) =>
      new ExternalCallError(message, { code, ...(dispatched ? { outcome: 'unknown' } : {}) });
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(30_000, () =>
      finish(transportError('控制帧超时', 'PILION_EXTERNAL_TIMEOUT')),
    );
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: endpoint.token })}\n`));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        finish(transportError('控制帧响应超过大小上限', 'PILION_EXTERNAL_RESPONSE_LIMIT'));
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0 && !settled) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        let msg: { id?: string; result?: unknown; error?: string } & ExternalErrorDiagnostics;
        try {
          msg = JSON.parse(line);
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('bad frame');
        } catch {
          finish(transportError('控制帧响应格式不正确', 'PILION_EXTERNAL_MALFORMED_RESPONSE'));
          return;
        }
        if (typeof msg.error === 'string' && !handshook) {
          finish(new ExternalCallError(msg.error, msg));
          return;
        }
        if (!handshook) {
          handshook = true;
          dispatched = true;
          socket.write(`${JSON.stringify({ id, control })}\n`);
          continue;
        }
        if (msg.id !== id) continue;
        if (typeof msg.error === 'string') finish(new ExternalCallError(msg.error, msg));
        else finish(undefined, msg.result);
      }
    });
    socket.once('error', (error) =>
      finish(transportError(error.message, 'PILION_EXTERNAL_CONNECTION_ERROR')),
    );
    const closed = () =>
      finish(transportError('连接关闭，未收到控制帧响应', 'PILION_EXTERNAL_CONNECTION_CLOSED'));
    socket.once('end', closed);
    socket.once('close', closed);
  });
}

/** 只握手不发请求：`pilion status` 用它检查凭证与服务端版本。 */
export function handshake(endpoint: ExternalEndpoint): Promise<{ version?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, ack?: { version?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(ack ?? {});
    };
    socket.setTimeout(10_000, () => finish(new Error('Pilion 握手超时')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: endpoint.token })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buffer.slice(0, nl)) as {
          error?: string;
          version?: string;
        } & ExternalErrorDiagnostics;
        if (typeof msg.error === 'string') finish(new ExternalCallError(msg.error, msg));
        else finish(undefined, msg.version ? { version: msg.version } : {});
      } catch {
        finish(new Error('Pilion 返回了无法解析的握手帧'));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => finish(new Error('Pilion 在握手前关闭了连接')));
  });
}
