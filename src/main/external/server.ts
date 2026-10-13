import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  ExternalConnection,
  ExternalMcpConfig,
  ExternalRuntime,
} from './types.js';
import { externalPrincipal, sanitizeClient } from './types.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const IDLE_SOCKET_TIMEOUT_MS = 5 * 60_000;

/** 首帧：认证 + 自报客户端名。principal 在这一次 accept 时固化，之后帧里不再变更身份。 */
const HelloSchema = z
  .object({
    token: z.string().min(1).max(256),
    client: z.string().max(64).optional(),
  })
  .strict();
const RequestFrameSchema = z
  .object({
    id: z.string().min(1).max(128),
    request: z.unknown(),
  })
  .strict();

export interface ExternalServerOptions {
  /** 放 socket 与 token 配置文件的目录（userData/external），本服务负责把它建成 0700。 */
  dir: string;
  runtime: ExternalRuntime;
  /** 让外部 Agent 启动 stdio MCP 客户端的命令与脚本路径。 */
  command: string;
  mcpClientPath: string;
  /** 审计时附上的进程实例标签。 */
  instance?: string;
}

const SOCKET_NAME = 'external.sock';
const CONFIG_NAME = 'external-mcp.json';

/**
 * 给外部 CLI / MCP Agent 的本地 Unix socket 入口。只监听当前用户可访问的位置：
 * 目录 0700、socket 0600、token 文件 0600。连接必须先过 token 认证才会被 Host 接纳。
 * 服务本身不懂 Host / 浏览器，一切治理都交给 runtime。
 */
export class ExternalControlServer {
  #server?: Server;
  #socketPath?: string;
  readonly #token = randomBytes(32).toString('base64url');
  readonly #sockets = new Set<Socket>();
  readonly #connections = new Map<ExternalConnection, Socket>();

  constructor(private readonly options: ExternalServerOptions) {}

  get socketPath(): string {
    if (!this.#socketPath) throw new Error('External control server is not listening');
    return this.#socketPath;
  }

  get isListening(): boolean {
    return Boolean(this.#server);
  }

  activePrincipals(): string[] {
    return [...this.#connections.keys()].map((conn) => conn.principal);
  }

  /** 设置页列出当前活动的外部连接。 */
  describeConnections(): Array<{ principal: string; client: string; connectedAt: string }> {
    return [...this.#connections.keys()].map((conn) => ({
      principal: conn.principal,
      client: conn.client,
      connectedAt: conn.connectedAt,
    }));
  }

  /** 复制给外部 Agent 的 mcpServers 配置；未在监听时返回 undefined。 */
  mcpConfig(): ExternalMcpConfig | undefined {
    if (!this.#socketPath) return undefined;
    return {
      command: this.options.command,
      args: [this.options.mcpClientPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PILION_EXTERNAL_SOCKET: this.#socketPath,
        PILION_EXTERNAL_TOKEN: this.#token,
      },
      socketPath: this.#socketPath,
      token: this.#token,
    };
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const socketPath = join(this.options.dir, SOCKET_NAME);
    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;
    this.#socketPath = socketPath;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    await this.#writeConfig();
    this.#audit('external.server.started', { socketPath });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    const socketPath = this.#socketPath;
    this.#server = undefined;
    this.#socketPath = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    for (const conn of [...this.#connections.keys()]) conn.revoke();
    this.#connections.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (socketPath) await rm(socketPath, { force: true });
    await rm(join(this.options.dir, CONFIG_NAME), { force: true });
    this.#audit('external.server.stopped', {});
  }

  /** 断开某个 principal 的全部连接（设置页「断开」按钮）：同时摘掉它的 Tab ACL。 */
  disconnectPrincipal(principal: string): void {
    for (const [conn, socket] of [...this.#connections]) {
      if (conn.principal === principal) {
        conn.revoke();
        this.#connections.delete(conn);
        socket.destroy();
      }
    }
  }

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    // 防御性闸门：主进程只在开启时 start()，但万一开启后又关掉，已经接上的也在这里被拒。
    if (!this.options.runtime.isEnabled()) {
      this.#audit('external.connection.rejected_disabled', {});
      socket.end(`${JSON.stringify({ error: '外部控制通道未开启' })}\n`);
      socket.destroy();
      return;
    }
    socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handshook: ExternalConnection | undefined;
    let ended = false;

    const finish = (): void => {
      if (ended) return;
      ended = true;
      if (handshook) {
        this.#connections.delete(handshook);
        try {
          handshook.close();
        } catch {
          /* already closed */
        }
        this.#audit('external.connection.closed', { principal: handshook.principal });
      }
    };
    socket.once('close', finish);
    socket.once('error', () => {
      ended = true;
    });
    setTimeout(() => {
      if (!handshook) socket.destroy();
    }, HELLO_TIMEOUT_MS).unref();

    socket.on('data', (chunk) => {
      if (ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.end(`${JSON.stringify({ error: 'frame too large' })}\n`);
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0 && !ended) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        if (!handshook) {
          this.#handleHello(socket, line, (conn) => {
            handshook = conn;
          });
        } else {
          void this.#handleRequest(socket, handshook, line);
        }
      }
    });
  }

  #handleHello(
    socket: Socket,
    line: string,
    setConnection: (conn: ExternalConnection) => void,
  ): void {
    let parsed: { token: string; client?: string };
    try {
      parsed = HelloSchema.parse(JSON.parse(line));
    } catch {
      this.#audit('external.connection.malformed', {});
      socket.end(`${JSON.stringify({ error: 'bad handshake' })}\n`);
      socket.destroy();
      return;
    }
    if (!sameSecret(parsed.token, this.#token)) {
      this.#audit('external.connection.auth_failed', {});
      socket.end(`${JSON.stringify({ error: 'authentication failed' })}\n`);
      socket.destroy();
      return;
    }
    const client = sanitizeClient(parsed.client);
    let conn: ExternalConnection;
    try {
      conn = this.options.runtime.admit(client);
    } catch (error) {
      this.#audit('external.connection.admit_failed', {
        client,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.end(
        `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
      );
      socket.destroy();
      return;
    }
    this.#connections.set(conn, socket);
    this.#audit('external.connection.connected', {
      principal: conn.principal,
      client,
      expectedPrincipal: externalPrincipal(client),
    });
    setConnection(conn);
    // 认证成功：回一个空 ack，客户端收到后才开始发请求帧。
    socket.write('{}\n');
  }

  async #handleRequest(
    socket: Socket,
    conn: ExternalConnection,
    line: string,
  ): Promise<void> {
    let frame: { id: string; request: unknown };
    try {
      frame = RequestFrameSchema.parse(JSON.parse(line));
    } catch {
      socket.end(`${JSON.stringify({ error: 'bad request frame' })}\n`);
      return;
    }
    try {
      const result = await conn.run(frame.request as Parameters<ExternalConnection['run']>[0]);
      socket.write(`${JSON.stringify({ id: frame.id, result })}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({
          id: frame.id,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }

  async #writeConfig(): Promise<void> {
    const config = this.mcpConfig();
    if (!config) return;
    const path = join(this.options.dir, CONFIG_NAME);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // 先写临时文件再 rename，避免半截配置；0600 只放得下当前用户。
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  #audit(eventType: string, payload: Record<string, unknown>): void {
    try {
      this.options.runtime.recordEvent(eventType, {
        ...payload,
        instance: this.options.instance ?? 'main',
        at: new Date().toISOString(),
      });
    } catch {
      /* 审计失败不该拖垮连接 */
    }
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** 客户端读取默认配置文件（0600）里的 socket 与 token。 */
export async function readEndpointFile(path: string): Promise<{
  socketPath: string;
  token: string;
}> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ExternalMcpConfig;
  return { socketPath: parsed.socketPath, token: parsed.token };
}
