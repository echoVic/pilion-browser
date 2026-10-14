import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rm, stat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolRequestSchema } from '../../shared/contracts.js';
import { ExternalClientRegistry, type ExternalClient } from './client-registry.js';
import type { ExternalConnection, ExternalMcpConfig, ExternalRuntime } from './types.js';
import { EXTERNAL_TOOLS, externalPrincipalForClient } from './types.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const IDLE_SOCKET_TIMEOUT_MS = 5 * 60_000;
/** 同时在线连接上限；超出的新连接直接拒绝。 */
const MAX_CONNECTIONS = 8;
/** 单连接在途请求上限；超出的请求帧直接拒绝，防止慢调用堆积。 */
const MAX_INFLIGHT_PER_CONNECTION = 4;
/** 同时进行中的未认证 hello 上限；超出的连接直接拒，防未认证方用 scrypt 占满主进程。 */
const MAX_PENDING_HELLOS = 8;

/** 首帧：只认 token。client 字段可带但服务端忽略（身份由 token 决定，不再由自报名决定）。 */
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

const TOOL_ALLOWLIST = new Set<string>(EXTERNAL_TOOLS);

export interface ExternalServerOptions {
  /** 放 socket 与 token 配置文件的目录（userData/external），本服务负责把它建成 0700。 */
  dir: string;
  runtime: ExternalRuntime;
  /** 让外部 Agent 启动 stdio MCP 客户端的命令与脚本路径。 */
  command: string;
  mcpClientPath: string;
  /** 审计时附上的进程实例标签。 */
  instance?: string;
  /** 客户端/连接列表变化时回调，让主进程重新广播 state。 */
  onStateChange?: () => void;
}

const SOCKET_NAME = 'external.sock';
/** 旧版单 token 共享配置文件名；升级后不再作为凭证，启动时自动作废删除。 */
const LEGACY_CONFIG_NAME = 'external-mcp.json';

/**
 * 给外部 CLI / MCP Agent 的本地 Unix socket 入口。只监听当前用户可访问的位置：
 * 目录 0700、socket 0600、token 文件 0600。连接必须先过 token 认证才会被 Host 接纳。
 * 服务本身不懂 Host / 浏览器，一切治理都交给 runtime。工具白名单在这里强制执行，
 * 不信任客户端只在注册时裁剪。
 */
export class ExternalControlServer {
  #server?: Server;
  #socketPath?: string;
  readonly #registry: ExternalClientRegistry;
  readonly #sockets = new Set<Socket>();
  readonly #connections = new Map<ExternalConnection, Socket>();
  /** 正在做 hello（未认证）的连接数：超上限直接拒。 */
  #pendingHellos = 0;
  /** stop() 期间为 true：新连接直接拒，start() 看到后放弃。 */
  #stopping = false;
  /** 在途的 start() Promise，stop() 要等它结束再收尾，避免 socket 被复活。 */
  #starting?: Promise<void>;

  constructor(private readonly options: ExternalServerOptions) {
    this.#registry = new ExternalClientRegistry(options.dir);
  }

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
  describeConnections(): Array<{
    principal: string;
    clientId: string;
    name: string;
    connectedAt: string;
  }> {
    return [...this.#connections.keys()].map((conn) => ({
      principal: conn.principal,
      clientId: conn.clientId,
      name: conn.name,
      connectedAt: conn.connectedAt,
    }));
  }

  /** 某客户端的 mcpServers 配置；token 只在创建/复制时由调用方持有，不随 state 广播。 */
  buildMcpConfig(entry: ExternalClient, token: string): ExternalMcpConfig {
    return {
      command: this.options.command,
      args: [this.options.mcpClientPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PILION_EXTERNAL_SOCKET: this.#socketPath ?? '',
        PILION_EXTERNAL_TOKEN: token,
      },
      socketPath: this.#socketPath ?? '',
      clientId: entry.clientId,
      name: entry.name,
      token,
    };
  }

  // ---- 客户端注册表管理（设置页） ----

  listClients(): Promise<ExternalClient[]> {
    return this.#registry.list();
  }

  /** 同步快照（state 广播用，不含哈希）。 */
  clientsSnapshot(): ExternalClient[] {
    return this.#registry.snapshot();
  }

  /** 新建客户端：返回明文 token（仅此一次）与对应的 MCP 配置。 */
  async createClient(
    name: string,
  ): Promise<{ client: ExternalClient; token: string; config: ExternalMcpConfig }> {
    const { client, token } = await this.#registry.create(name);
    this.#audit('external.client.created', { clientId: client.clientId, name: client.name });
    return { client, token, config: this.buildMcpConfig(client, token) };
  }

  /** 吊销：断开它的活动连接、摘 ACL（无活动连接也要摘），标 revokedAt；被吊销 token 再连被拒。 */
  async revokeClient(clientId: string): Promise<ExternalClient | undefined> {
    const entry = await this.#registry.revoke(clientId);
    if (!entry) return undefined;
    const principal = externalPrincipalForClient(clientId);
    for (const [conn, socket] of [...this.#connections]) {
      if (conn.principal === principal) {
        conn.revoke();
        this.#connections.delete(conn);
        socket.destroy();
      }
    }
    // 即使此刻没有活动连接，也要摘掉它可能残留的 Tab ACL。
    this.options.runtime.revokePrincipalAcl(principal);
    this.#audit('external.client.revoked', { clientId, name: entry.name });
    this.options.onStateChange?.();
    return entry;
  }

  /** 删除：连记录一起移除，断开活动连接并摘 ACL。 */
  async deleteClient(clientId: string): Promise<boolean> {
    const removed = await this.#registry.remove(clientId);
    const principal = externalPrincipalForClient(clientId);
    for (const [conn, socket] of [...this.#connections]) {
      if (conn.principal === principal) {
        conn.revoke();
        this.#connections.delete(conn);
        socket.destroy();
      }
    }
    this.options.runtime.revokePrincipalAcl(principal);
    if (removed) this.#audit('external.client.deleted', { clientId });
    this.options.onStateChange?.();
    return removed;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#stopping = false;
    const started = this.#listen();
    this.#starting = started;
    try {
      await started;
    } finally {
      if (this.#starting === started) this.#starting = undefined;
    }
  }

  async #listen(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    // 显式收紧目录权限：umask 下 mkdir 的 mode 不一定落得干净。
    await chmod(this.options.dir, 0o700);
    const socketPath = join(this.options.dir, SOCKET_NAME);
    // 启动前清理残留 socket：是 socket 就 unlink，是别的类型（含 symlink）就拒绝，防被指向别处。
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      existing = await lstat(socketPath);
    } catch {
      existing = undefined;
    }
    if (existing) {
      if (!existing.isSocket()) {
        throw new Error(`外部 socket 路径已被非 socket 占用：${socketPath}`);
      }
      await unlink(socketPath);
    }
    const server = createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    // listen 成功后才赋值，失败不进入僵尸态。
    this.#server = server;
    this.#socketPath = socketPath;
    await chmod(socketPath, 0o600);
    // 再 stat 校验一次 socket 权限确实是 0600。
    const statResult = await stat(socketPath);
    if ((statResult.mode & 0o777) !== 0o600) {
      await rm(socketPath, { force: true });
      this.#server = undefined;
      this.#socketPath = undefined;
      throw new Error(`外部 socket 权限不是 0600：${(statResult.mode & 0o777).toString(8)}`);
    }
    await this.#migrateLegacyConfig();
    await this.#registry.list().catch(() => undefined);
    this.#audit('external.server.started', { socketPath });
  }

  /** 升级迁移：旧版单 token 共享配置文件不再是凭证；存在才删除并留痕。 */
  async #migrateLegacyConfig(): Promise<void> {
    const legacy = join(this.options.dir, LEGACY_CONFIG_NAME);
    try {
      await lstat(legacy);
    } catch {
      return; // 不存在就不用迁。
    }
    try {
      await rm(legacy, { force: true });
      this.#audit('external.legacy_config.removed', { path: legacy });
    } catch (error) {
      console.error('[external] legacy config removal failed', error);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    // 先等在途的 start 结束，避免 stop 删完 token 又被刚 listen 成功的 start 写回来。
    if (this.#starting) {
      await this.#starting.catch(() => undefined);
    }
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
    this.#audit('external.server.stopped', {});
    this.#stopping = false;
  }

  /** 断开某个 principal 的全部连接（设置页「断开」按钮）：同时摘掉它的 Tab ACL。 */
  disconnectPrincipal(principal: string): void {
    let dropped = 0;
    for (const [conn, socket] of [...this.#connections]) {
      if (conn.principal === principal) {
        conn.revoke();
        this.#connections.delete(conn);
        socket.destroy();
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.#audit('external.connection.disconnected_by_user', { principal, count: dropped });
    }
  }

  #onConnection(socket: Socket): void {
    const connectionId = randomBytes(8).toString('base64url');
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    // 防御性闸门：主进程只在开启时 start()，但万一开启后又关掉，已经接上的也在这里被拒。
    if (this.#stopping || !this.options.runtime.isEnabled()) {
      this.#audit('external.connection.rejected_disabled', { connectionId });
      socket.end(`${JSON.stringify({ error: '外部控制通道未开启' })}\n`);
      socket.destroy();
      return;
    }
    if (this.#connections.size >= MAX_CONNECTIONS) {
      this.#audit('external.connection.rejected_limit', {
        connectionId,
        count: this.#connections.size,
      });
      socket.end(`${JSON.stringify({ error: '连接数已达上限' })}\n`);
      socket.destroy();
      return;
    }
    if (this.#pendingHellos >= MAX_PENDING_HELLOS) {
      this.#audit('external.connection.rejected_pending', {
        connectionId,
        count: this.#pendingHellos,
      });
      socket.end(`${JSON.stringify({ error: '认证中的连接过多' })}\n`);
      socket.destroy();
      return;
    }
    this.#pendingHellos += 1;
    socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handshook: ExternalConnection | undefined;
    // settled：连接是否已完成清理（无论正常 close 还是 error）。
    // paused：是否忽略后续数据帧（坏帧/超大帧/认证失败后不再解析）。两者拆开，error 也必须收尾。
    let settled = false;
    let paused = false;
    // helloInFlight：本条 socket 的认证是否在途。结算前丢弃后续行，一个 chunk 多条 hello 不并发 admit。
    let helloInFlight = false;
    // authFailedAudited：认证失败审计每条连接最多记一条。
    let authFailedAudited = false;
    let inflight = 0;
    // pendingSettled：本条连接在 #pendingHellos 里的名额是否已扣过；只扣一次，恒 ≥0。
    let pendingSettled = false;
    const settlePendingHello = (): void => {
      if (pendingSettled) return;
      pendingSettled = true;
      this.#pendingHellos = Math.max(0, this.#pendingHellos - 1);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      paused = true;
      // 无论成功/失败/断开，都把本条连接占的 hello 名额扣掉（只扣一次）。
      settlePendingHello();
      if (handshook) {
        this.#connections.delete(handshook);
        try {
          handshook.close();
        } catch {
          /* already closed */
        }
        this.#audit('external.connection.closed', {
          connectionId,
          principal: handshook.principal,
          attachment: handshook.attachmentId,
        });
      }
    };
    socket.once('close', finish);
    socket.once('error', () => {
      this.#audit('external.connection.error', {
        connectionId,
        principal: handshook?.principal,
      });
      finish();
    });
    const helloTimer = setTimeout(() => {
      if (!handshook) {
        this.#audit('external.connection.hello_timeout', { connectionId });
        socket.destroy();
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on('data', (chunk) => {
      if (settled || paused) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        this.#audit('external.connection.frame_too_large', { connectionId });
        paused = true;
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0 && !settled && !paused) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        if (!handshook) {
          // 一个 socket 最多 admit 一次；认证在途期间的后续行直接丢弃，避免一个 chunk 多条 hello 并发占槽。
          if (helloInFlight) continue;
          helloInFlight = true;
          this.#handleHello(socket, connectionId, line, {
            setConnection: (conn) => {
              handshook = conn;
              // 名额在成功 admit 后扣掉；若 socket 已先关闭，finish() 会扣，这里因 per-socket 标志只扣一次。
              settlePendingHello();
              clearTimeout(helloTimer);
            },
            authFailed: () => {
              paused = true;
              if (!authFailedAudited) {
                authFailedAudited = true;
                this.#audit('external.connection.auth_failed', { connectionId });
              }
            },
            failClosed: () => {
              // admit 失败等：和认证失败一样收尾，不再处理后续帧。
              paused = true;
            },
          });
        } else {
          if (inflight >= MAX_INFLIGHT_PER_CONNECTION) {
            this.#audit('external.request.too_many_inflight', {
              connectionId,
              principal: handshook.principal,
            });
            paused = true;
            socket.destroy();
            return;
          }
          inflight += 1;
          void this.#handleRequest(socket, connectionId, handshook, line).finally(() => {
            inflight -= 1;
          });
        }
      }
    });
  }

  #handleHello(
    socket: Socket,
    connectionId: string,
    line: string,
    callbacks: {
      setConnection: (conn: ExternalConnection) => void;
      authFailed: () => void;
      failClosed: () => void;
    },
  ): void {
    let parsed: { token: string; client?: string };
    try {
      parsed = HelloSchema.parse(JSON.parse(line));
    } catch {
      callbacks.authFailed();
      this.#audit('external.connection.malformed', { connectionId });
      socket.end(`${JSON.stringify({ error: 'bad handshake' })}\n`);
      socket.destroy();
      return;
    }
    void (async () => {
      // 身份由 token 决定：从前缀定位到唯一客户端，只做一次 scrypt；client 字段仅作核对。
      const entry = await this.#registry.verify(parsed.token).catch((error) => {
        console.error('[external] verify failed', error);
        return undefined;
      });
      // verify 之后、admit 之前在内存里再复查一次是否仍未吊销。
      if (!entry || !this.#registry.assertActive(entry.clientId)) {
        callbacks.authFailed();
        socket.end(`${JSON.stringify({ error: 'authentication failed' })}\n`);
        // 失败后 destroy：同一连接不能反复发 hello 重试，paused 已置位不再解析后续数据。
        socket.destroy();
        return;
      }
      let conn: ExternalConnection;
      try {
        conn = this.options.runtime.admit(entry.clientId, entry.name);
      } catch (error) {
        callbacks.failClosed();
        this.#audit('external.connection.admit_failed', {
          connectionId,
          clientId: entry.clientId,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.end(
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        socket.destroy();
        return;
      }
      // admit 后连接可能已被对端关闭/超时：直接拆掉刚建的 attachment，不再登记、不回 ack。
      if (socket.destroyed) {
        try {
          conn.close();
        } catch {
          /* already closed */
        }
        return;
      }
      void this.#registry.touch(entry.clientId).catch(() => undefined);
      this.#connections.set(conn, socket);
      this.#audit('external.connection.connected', {
        connectionId,
        principal: conn.principal,
        attachment: conn.attachmentId,
        clientId: entry.clientId,
        name: entry.name,
        expectedPrincipal: externalPrincipalForClient(entry.clientId),
      });
      callbacks.setConnection(conn);
      // 认证成功：回一个空 ack，客户端收到后才开始发请求帧。
      socket.write('{}\n');
    })();
  }

  async #handleRequest(
    socket: Socket,
    connectionId: string,
    conn: ExternalConnection,
    line: string,
  ): Promise<void> {
    let frame: { id: string; request: unknown };
    try {
      frame = RequestFrameSchema.parse(JSON.parse(line));
    } catch {
      this.#audit('external.request.malformed', { connectionId, principal: conn.principal });
      socket.end(`${JSON.stringify({ id: undefined, error: 'bad request frame' })}\n`);
      // 坏帧不再续聊：paused 忽略后续数据并 destroy。
      socket.destroy();
      return;
    }
    // 服务端强制工具白名单：不信任客户端只在注册时裁剪，恶意帧直接写 socket 也调不到被裁工具。
    let request: z.infer<typeof ToolRequestSchema>;
    try {
      request = ToolRequestSchema.parse(frame.request);
    } catch (error) {
      this.#audit('external.request.invalid', {
        connectionId,
        principal: conn.principal,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.write(
        `${JSON.stringify({
          id: frame.id,
          error: 'request 不符合 ToolRequestSchema',
        })}\n`,
      );
      return;
    }
    if (!TOOL_ALLOWLIST.has(request.name)) {
      this.#audit('external.request.tool_denied', {
        connectionId,
        principal: conn.principal,
        tool: request.name,
      });
      socket.write(
        `${JSON.stringify({ id: frame.id, error: `工具未对外开放：${request.name}` })}\n`,
      );
      return;
    }
    try {
      const result = await conn.run(request);
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

  #audit(eventType: string, payload: Record<string, unknown>): void {
    try {
      this.options.runtime.recordEvent(eventType, {
        ...payload,
        instance: this.options.instance ?? 'main',
        at: new Date().toISOString(),
      });
    } catch (error) {
      // 审计失败不该拖垮连接，但必须留痕。
      console.error('[external] audit failed', eventType, error);
    }
  }
}
