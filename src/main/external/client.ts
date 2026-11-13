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
      '缺少 Pilion 外部凭证：在 Pilion「设置 › 通用 › 对外控制」点「安装到 Agent」；' +
        '或在那里新增客户端，并通过环境变量 PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN 注入。',
    );
  }
  return { socketPath, token };
}

/** 单条响应帧的大小上限，与服务端一致。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_LIMIT_MESSAGE = 'Pilion external response exceeded the frame limit';
const SCREENSHOT_LIMIT_HINT =
  '; for a screenshot retry with --scale 0.5 / --format jpeg / --clip x,y,w,h (large screenshots are auto-downgraded first; oversized observations may still be unavailable)';

type ResponseFrame = { id?: string; result?: unknown; error?: string } & ExternalErrorDiagnostics;

/**
 * 一条短连接上的一来一回：先发 hello 等 ack；frame 为空时把 ack 当结果返回（只握手），
 * 否则收到 ack 后发 frame，等同 id 的响应。三个导出共用这一份帧解析、大小上限、超时与关闭处理。
 */
function exchange(
  endpoint: ExternalEndpoint,
  frame: ({ id: string } & Record<string, unknown>) | undefined,
  options: { timeoutMs: number; limitMessage?: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handshook = false;
    // Once queued to the socket, loss of a response cannot establish the frame's outcome.
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
    socket.setTimeout(options.timeoutMs, () =>
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
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(
          transportError(
            options.limitMessage ?? RESPONSE_LIMIT_MESSAGE,
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
        let msg: ResponseFrame;
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
          if (!frame) {
            finish(undefined, msg);
            return;
          }
          dispatched = true;
          socket.write(`${JSON.stringify(frame)}\n`);
          continue;
        }
        if (msg.id !== frame?.id) continue;
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

/** 连上 socket、先握手再跑一个工具请求，返回工具结果。短连接 CLI 与长连接 MCP 都用它发请求。 */
export function callTool(
  endpoint: ExternalEndpoint,
  request: Pick<ToolRequest, 'name' | 'args'>,
): Promise<unknown> {
  const id = randomUUID();
  const fullRequest: ToolRequest = { requestId: id, name: request.name, args: request.args ?? {} };
  return exchange(
    endpoint,
    { id, request: fullRequest },
    { timeoutMs: 90_000, limitMessage: `${RESPONSE_LIMIT_MESSAGE}${SCREENSHOT_LIMIT_HINT}` },
  );
}

/** 发控制帧，不依赖 Space admission；创建、列出和关闭空间都使用基础连接。 */
export function callControl(endpoint: ExternalEndpoint, control: object): Promise<unknown> {
  const id = randomUUID();
  return exchange(
    { socketPath: endpoint.socketPath, token: endpoint.token },
    { id, control },
    { timeoutMs: 30_000 },
  );
}

/** 只握手不发请求：`pilion status` 用它检查凭证与服务端版本。 */
export async function handshake(endpoint: ExternalEndpoint): Promise<{ version?: string }> {
  const ack = (await exchange(
    { socketPath: endpoint.socketPath, token: endpoint.token },
    undefined,
    {
      timeoutMs: 10_000,
    },
  )) as { version?: unknown };
  return typeof ack.version === 'string' && ack.version ? { version: ack.version } : {};
}
