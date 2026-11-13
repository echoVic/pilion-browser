import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolRequestSchema } from '../../shared/contracts.js';
import {
  ExternalClientRegistry,
  type ExternalClient,
  type ExternalClientKind,
} from './client-registry.js';
import type { ExternalConnection, ExternalMcpConfig, ExternalRuntime } from './types.js';
import { EXTERNAL_TOOLS, externalPrincipalForClient } from './types.js';
import { externalErrorDiagnostics } from './client.js';
import {
  AgentSpaceError,
  ControlFrameSchema,
  SPACE_MESSAGES,
  externalSpacePrincipal,
} from './space-protocol.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const IDLE_SOCKET_TIMEOUT_MS = 5 * 60_000;
/** 同时在线连接上限；超出的新连接直接拒绝。 */
const MAX_CONNECTIONS = 8;
/** 单连接在途请求上限；超出的请求帧直接拒绝，防止慢调用堆积。 */
const MAX_INFLIGHT_PER_CONNECTION = 4;
/** 同时进行中的未认证 hello 上限；超出的连接直接拒，防未认证方用 scrypt 占满主进程。 */
const MAX_PENDING_HELLOS = 8;

/**
 * 首帧：token 必须；space 可选，集成客户端在带 space 时指定。client 字段是旧版客户端带的展示名，
 * 仍然接受，但服务端一律忽略：身份只由 token 决定。
 */
const HelloSchema = z
  .object({
    token: z.string().min(1).max(256),
    client: z.string().max(64).optional(),
    space: z.string().min(1).max(256).optional(),
  })
  .strict();
const RequestFrameSchema = z
  .object({
    id: z.string().min(1).max(128),
    request: z.unknown(),
  })
  .strict();

/** 带 `control` 且 id 可用的帧才算「写坏了的控制帧」；其余坏帧照旧按协议错误断开。 */
function invalidControlFrameId(frame: unknown): string | undefined {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !('control' in frame))
    return undefined;
  const id = (frame as { id?: unknown }).id;
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 ? id : undefined;
}

const TOOL_ALLOWLIST = new Set<string>(EXTERNAL_TOOLS);

/** 回错误后等这一行写出去再断开；对端不读也最多等这么久。 */
const REFUSE_FLUSH_MS = 1_000;

interface SocketIdentity {
  dev: number;
  ino: number;
}

/**
 * 服务的生命周期，只有这一个状态：
 *
 *   stopped ──start()──▶ starting ──监听就绪──▶ listening ──stop()──▶ stopping ──▶ stopped
 *                          │  任何一步失败：关掉监听、原样抛出 ──▶ stopped
 *                          └─ 启动途中 stop()：先进 stopping，启动看到后自己关掉监听、删掉自己的 socket
 *
 * 只有 listening 才接连接、才能新建/吊销/删除客户端；socket 文件的身份（dev/ino）记在
 * listening 里，stop() 只删仍是自己建的那个文件。
 */
type ServerPhase =
  | { kind: 'stopped' }
  | { kind: 'starting'; ready: Promise<void> }
  | { kind: 'listening'; server: Server; socketPath: string; socket: SocketIdentity }
  | { kind: 'stopping'; done: Promise<void> };
type StartingPhase = Extract<ServerPhase, { kind: 'starting' }>;
type StoppingPhase = Extract<ServerPhase, { kind: 'stopping' }>;
type ListeningPhase = Extract<ServerPhase, { kind: 'listening' }>;

const STOPPED: ServerPhase = { kind: 'stopped' };

/** 关掉监听；没在监听时 close 的回调带错误，这里一律当作已关。 */
function closeListener(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ExternalServerOptions {
  /** 放 socket 与 token 配置文件的目录（userData/external），本服务负责把它建成 0700。 */
  dir: string;
  runtime: ExternalRuntime;
  /** 让外部 Agent 启动 stdio MCP 客户端的命令与脚本路径。 */
  command: string;
  mcpClientPath: string;
  /** Pilion 版本：随握手 ack 下发，CLI 的 `status` 用它比对版本。 */
  version?: string;
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
  #phase: ServerPhase = STOPPED;
  readonly #registry: ExternalClientRegistry;
  readonly #sockets = new Set<Socket>();
  readonly #connections = new Map<ExternalConnection, Socket>();
  /** 正在做 hello（未认证）的连接数：超上限直接拒。 */
  #pendingHellos = 0;

  constructor(private readonly options: ExternalServerOptions) {
    this.#registry = new ExternalClientRegistry(options.dir);
  }

  get socketPath(): string {
    if (this.#phase.kind !== 'listening')
      throw new Error('External control server is not listening');
    return this.#phase.socketPath;
  }

  get isListening(): boolean {
    return this.#phase.kind === 'listening';
  }

  /** 新建/吊销/删除客户端只在 listening 时做，其余阶段明确失败，不悄悄改一半。 */
  #requireListening(action: string): ListeningPhase {
    if (this.#phase.kind !== 'listening') throw new Error(`外部控制通道没有在运行，无法${action}`);
    return this.#phase;
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

  /** 某客户端的 mcpServers 配置；token 只在创建时由调用方持有，不随 state 广播。 */
  #mcpConfig(socketPath: string, token: string): ExternalMcpConfig {
    return {
      command: this.options.command,
      args: [this.options.mcpClientPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PILION_EXTERNAL_SOCKET: socketPath,
        PILION_EXTERNAL_TOKEN: token,
      },
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
    kind?: ExternalClientKind,
  ): Promise<{ client: ExternalClient; token: string; config: ExternalMcpConfig }> {
    const { socketPath } = this.#requireListening('新建客户端');
    const { client, token } = await this.#registry.create(name, kind);
    this.#audit('external.client.created', { clientId: client.clientId, name: client.name });
    // 与 revoke/delete 一致：注册表变了就广播，否则设置页「客户端」列表在下次无关 state 推送前一直显示空态。
    this.options.onStateChange?.();
    return { client, token, config: this.#mcpConfig(socketPath, token) };
  }

  async setClientPermissionMode(
    clientId: string,
    mode: 'ask' | 'full',
    validate?: () => Promise<void>,
    commit?: () => void,
  ): Promise<ExternalClient> {
    const check = async () => {
      if (!this.isListening || !this.options.runtime.isEnabled()) throw new Error('外部控制已停止');
      await validate?.();
      if (!this.isListening || !this.options.runtime.isEnabled()) throw new Error('外部控制已停止');
    };
    const finalCheck = () => {
      if (!this.isListening || !this.options.runtime.isEnabled()) throw new Error('外部控制已停止');
      commit?.();
    };
    const client = await this.#registry.setPermissionMode(clientId, mode, check, finalCheck);
    this.#audit('external.client.permission', { clientId, mode, source: 'local-user' });
    this.options.onStateChange?.();
    return client;
  }

  /**
   * 吊销：先在本进程内吊销并切断（活动连接、Tab ACL、它所有 active 的 Agent Space），再落盘。
   * 写盘失败时本进程照样拒绝它（下一次注册表写操作会补写），这里把失败如实抛给设置页。
   */
  async revokeClient(clientId: string): Promise<ExternalClient | undefined> {
    this.#requireListening('吊销客户端');
    this.#registry.markRevoked(clientId);
    let entry: ExternalClient | undefined;
    try {
      await this.#cutClient(clientId);
    } finally {
      entry = await this.#persistGone(clientId, '吊销', () => this.#registry.revoke(clientId));
    }
    if (!entry) return undefined;
    this.#audit('external.client.revoked', { clientId, name: entry.name });
    this.options.onStateChange?.();
    return entry;
  }

  /** 删除：与吊销同一顺序，先在本进程内停用并切断，再把记录从磁盘上移除。 */
  async deleteClient(clientId: string): Promise<boolean> {
    this.#requireListening('删除客户端');
    this.#registry.markRevoked(clientId);
    let removed: boolean;
    try {
      await this.#cutClient(clientId);
    } finally {
      removed = await this.#persistGone(clientId, '删除', () => this.#registry.remove(clientId));
    }
    if (removed) this.#audit('external.client.deleted', { clientId });
    this.options.onStateChange?.();
    return removed;
  }

  /** 断开某客户端的全部连接；即使此刻没有活动连接，也摘掉它残留的 Tab ACL、停掉它的 Agent Space。 */
  async #cutClient(clientId: string): Promise<void> {
    for (const [conn, socket] of [...this.#connections]) {
      if (conn.clientId === clientId) {
        conn.revoke();
        this.#connections.delete(conn);
        socket.destroy();
      }
    }
    this.options.runtime.revokePrincipalAcl(externalPrincipalForClient(clientId));
    await this.options.runtime.spaces.stopClient(clientId);
  }

  /** 吊销/删除的落盘：失败时留审计、刷新设置页，并说清楚这次已经生效到哪一步。 */
  async #persistGone<T>(clientId: string, action: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      this.#audit('external.client.revoke_unpersisted', {
        clientId,
        action,
        error: readable(error),
      });
      this.options.onStateChange?.();
      throw new Error(
        `已在本次运行中停用并断开这个客户端，但${action}没能写进磁盘：${readable(error)}。` +
          `Pilion 重启前请再${action}一次，否则重启后它会恢复`,
        { cause: error },
      );
    }
  }

  start(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind === 'listening') return Promise.resolve();
    if (phase.kind === 'starting') return phase.ready;
    // 还在收尾：等 stop 完成后再从头判断一次。
    if (phase.kind === 'stopping') return phase.done.then(() => this.start());
    const starting: StartingPhase = { kind: 'starting', ready: Promise.resolve() };
    this.#phase = starting;
    starting.ready = this.#listen(starting).catch((error: unknown) => {
      if (this.#phase === starting) this.#phase = STOPPED;
      throw error;
    });
    return starting.ready;
  }

  /**
   * 先在同目录的临时名上监听，收紧并核对权限后再 rename 到正式路径：
   * libuv 关闭监听时会 unlink 它当初 listen 的那个路径，用临时名，旧实例收尾时就删不到后来者的 socket；
   * rename 也让正式路径上始终只出现权限已核对过的 socket。
   */
  async #listen(starting: StartingPhase): Promise<void> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    // 显式收紧目录权限：umask 下 mkdir 的 mode 不一定落得干净。
    await chmod(this.options.dir, 0o700);
    const socketPath = join(this.options.dir, SOCKET_NAME);
    // 正式路径上已有东西：只接受残留 socket（随后被 rename 原子替换）；别的类型（含 symlink）拒绝，防被指向别处。
    const existing = await lstat(socketPath).catch(() => undefined);
    if (existing && !existing.isSocket()) {
      throw new Error(`外部 socket 路径已被非 socket 占用：${socketPath}`);
    }
    await this.#migrateLegacyConfig();
    await this.#registry.list().catch(() => undefined);
    if (this.#phase !== starting) return;
    // 临时名不比 external.sock 长：Unix socket 路径有长度上限。
    const tempPath = join(this.options.dir, `.s-${randomBytes(4).toString('hex')}`);
    const server = createServer((socket) => this.#onConnection(socket));
    let identity: SocketIdentity;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(tempPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      await chmod(tempPath, 0o600);
      // 再 stat 校验一次 socket 权限确实是 0600。
      const info = await stat(tempPath);
      if ((info.mode & 0o777) !== 0o600) {
        throw new Error(`外部 socket 权限不是 0600：${(info.mode & 0o777).toString(8)}`);
      }
      identity = { dev: info.dev, ino: info.ino };
      await rename(tempPath, socketPath);
    } catch (error) {
      // 任何一步失败都关掉监听（libuv 顺带删掉临时 socket），不留一个没人管的监听。
      await closeListener(server);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    if (this.#phase !== starting) {
      // 启动途中被 stop() 取代：不留监听、不留 socket。
      await closeListener(server);
      await this.#removeOwnSocket(socketPath, identity);
      return;
    }
    this.#phase = { kind: 'listening', server, socketPath, socket: identity };
    this.#audit('external.server.started', { socketPath });
  }

  /** 只删仍是自己建的那个 socket 文件：路径上已经换成别的实例的 socket，就留着。 */
  async #removeOwnSocket(socketPath: string, identity: SocketIdentity): Promise<void> {
    const info = await lstat(socketPath).catch(() => undefined);
    if (!info?.isSocket() || info.dev !== identity.dev || info.ino !== identity.ino) return;
    await rm(socketPath, { force: true });
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

  stop(): Promise<void> {
    const previous = this.#phase;
    if (previous.kind === 'stopping') return previous.done;
    const stopping: StoppingPhase = { kind: 'stopping', done: Promise.resolve() };
    this.#phase = stopping;
    stopping.done = this.#shutdown(previous).finally(() => {
      if (this.#phase === stopping) this.#phase = STOPPED;
    });
    return stopping.done;
  }

  async #shutdown(previous: ServerPhase): Promise<void> {
    // 在途的启动：等它结束。它看到已被 stop 取代，会自己关掉监听、删掉自己的 socket。
    if (previous.kind === 'starting') await previous.ready.catch(() => undefined);
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    for (const conn of [...this.#connections.keys()]) conn.revoke();
    this.#connections.clear();
    if (previous.kind === 'listening') {
      await closeListener(previous.server);
      await this.#removeOwnSocket(previous.socketPath, previous.socket);
    }
    await this.#registry.drain();
    if (previous.kind === 'listening') this.#audit('external.server.stopped', {});
  }

  /** 回一条错误再断开：等这一行真的写出去再 destroy，对端不读也最多等 REFUSE_FLUSH_MS。 */
  #refuse(socket: Socket, payload: Record<string, unknown>): void {
    // 对端可能已经走了：写失败（EPIPE）不能变成未处理的 error。
    socket.on('error', () => undefined);
    const timer = setTimeout(() => socket.destroy(), REFUSE_FLUSH_MS);
    timer.unref();
    socket.end(`${JSON.stringify(payload)}\n`, () => {
      clearTimeout(timer);
      socket.destroy();
    });
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
    if (this.#phase.kind !== 'listening' || !this.options.runtime.isEnabled()) {
      this.#audit('external.connection.rejected_disabled', { connectionId });
      this.#refuse(socket, { error: '外部控制通道未开启' });
      return;
    }
    if (this.#connections.size >= MAX_CONNECTIONS) {
      this.#audit('external.connection.rejected_limit', {
        connectionId,
        count: this.#connections.size,
      });
      this.#refuse(socket, { error: '连接数已达上限' });
      return;
    }
    if (this.#pendingHellos >= MAX_PENDING_HELLOS) {
      this.#audit('external.connection.rejected_pending', {
        connectionId,
        count: this.#pendingHellos,
      });
      this.#refuse(socket, { error: '认证中的连接过多' });
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
    // 握手计时器：到点还没认证就断开。连接以任何方式收尾时由 finish() 清掉。
    const helloTimer = setTimeout(() => {
      if (!handshook) {
        this.#audit('external.connection.hello_timeout', { connectionId });
        socket.destroy();
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();
    const settlePendingHello = (): void => {
      if (pendingSettled) return;
      pendingSettled = true;
      this.#pendingHellos = Math.max(0, this.#pendingHellos - 1);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      paused = true;
      // 连接已经收尾：握手计时器不能再在 15 秒后给审计补一条假的 hello_timeout。
      clearTimeout(helloTimer);
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
          void this.#handleRequest(socket, connectionId, handshook, line, () => {
            // 坏帧：不再解析这条连接后面的帧（同一个 chunk 里剩下的也不跑）。
            paused = true;
          }).finally(() => {
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
    let parsed: { token: string; client?: string; space?: string };
    try {
      parsed = HelloSchema.parse(JSON.parse(line));
    } catch {
      // 写坏的 hello 只记 malformed：它不是一次认证失败。
      callbacks.failClosed();
      this.#audit('external.connection.malformed', { connectionId });
      this.#refuse(socket, { error: 'bad handshake' });
      return;
    }
    void (async () => {
      // 身份只由 token 决定：从前缀定位到唯一客户端，只做一次 scrypt；hello 里的 client 字段不参与。
      const entry = await this.#registry.verify(parsed.token).catch((error) => {
        console.error('[external] verify failed', error);
        return undefined;
      });
      // verify 之后、admit 之前在内存里再复查一次是否仍未吊销。
      if (!entry || !this.#registry.assertActive(entry.clientId)) {
        callbacks.authFailed();
        // 失败后断开：同一连接不能反复发 hello 重试，paused 已置位不再解析后续数据。
        this.#refuse(socket, { error: 'authentication failed' });
        return;
      }
      // 带 space 的连接：先校验 Space 可接入，失败直接拒。
      if (parsed.space !== undefined) {
        try {
          // 恢复（resumed）由 spaces 自己记审计，这里不再重复记一条。
          await this.options.runtime.spaces.admit(entry.clientId, parsed.space);
        } catch (error) {
          callbacks.failClosed();
          this.#audit('external.space.admit_failed', {
            connectionId,
            clientId: entry.clientId,
            spaceId: parsed.space,
            reason: error instanceof AgentSpaceError ? error.code : 'unknown',
          });
          this.#refuse(socket, {
            error:
              error instanceof AgentSpaceError ? error.message : SPACE_MESSAGES.SPACE_NOT_FOUND,
            code: error instanceof AgentSpaceError ? error.code : 'SPACE_NOT_FOUND',
          });
          return;
        }
        // admission 在途时关闭或吊销的连接不能再登记 attachment。
        if (socket.destroyed) return;
        if (!this.#registry.assertActive(entry.clientId)) {
          callbacks.authFailed();
          this.#refuse(socket, { error: 'authentication failed' });
          return;
        }
      }

      let conn: ExternalConnection;
      try {
        conn = this.options.runtime.admit(entry.clientId, entry.name, parsed.space);
      } catch (error) {
        callbacks.failClosed();
        this.#audit('external.connection.admit_failed', {
          connectionId,
          clientId: entry.clientId,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#refuse(socket, {
          error: error instanceof Error ? error.message : String(error),
          ...externalErrorDiagnostics(error),
        });
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
        expectedPrincipal: parsed.space
          ? externalSpacePrincipal(entry.clientId, parsed.space)
          : externalPrincipalForClient(entry.clientId),
      });
      callbacks.setConnection(conn);
      // 认证成功：回带版本的 ack，客户端收到后才开始发请求帧。
      socket.write(
        `${JSON.stringify(this.options.version ? { version: this.options.version } : {})}\n`,
      );
    })();
  }

  async #handleRequest(
    socket: Socket,
    connectionId: string,
    conn: ExternalConnection,
    line: string,
    halt: () => void,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#audit('external.request.malformed', { connectionId, principal: conn.principal });
      halt();
      this.#refuse(socket, { id: undefined, error: 'bad request frame' });
      return;
    }

    // 控制帧优先判断，不经过工具白名单、不调 conn.run。
    const controlParsed = ControlFrameSchema.safeParse(parsed);
    if (controlParsed.success) {
      await this.#handleControl(socket, connectionId, conn, controlParsed.data);
      return;
    }
    // 带 control 的帧不是工具帧：按它自己的 id 回错误。落到下面的工具帧解析会回一条不带 id 的
    // 「bad request frame」并断开，CLI 对不上 id，只能报「连接关闭，结果未知」。
    const controlId = invalidControlFrameId(parsed);
    if (controlId !== undefined) {
      const detail = controlParsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('；');
      this.#audit('external.control.invalid', { connectionId, principal: conn.principal });
      socket.write(
        `${JSON.stringify({
          id: controlId,
          error: `控制帧不合法：${detail}`,
          code: 'INVALID_CONTROL_FRAME',
        })}\n`,
      );
      return;
    }

    let frame: { id: string; request: unknown };
    try {
      frame = RequestFrameSchema.parse(parsed);
    } catch {
      this.#audit('external.request.malformed', { connectionId, principal: conn.principal });
      // 坏帧不再续聊：halt 让后续数据一律忽略，回完错误就断开。
      halt();
      this.#refuse(socket, { id: undefined, error: 'bad request frame' });
      return;
    }

    // 集成客户端（kind=agent-integration）不带 space 时，拒绝所有工具帧。
    if (!conn.spaceId) {
      const client = this.#registry.snapshot().find((c) => c.clientId === conn.clientId);
      if (client?.kind === 'agent-integration') {
        this.#audit('external.request.space_required', {
          connectionId,
          principal: conn.principal,
        });
        socket.write(
          `${JSON.stringify({
            id: frame.id,
            error: SPACE_MESSAGES.SPACE_REQUIRED,
            code: 'SPACE_REQUIRED',
          })}\n`,
        );
        return;
      }
    }

    // 服务端强制工具白名单：不信任客户端只在注册时裁剪，恶意帧直接写 socket 也调不到被裁工具。
    let request: z.infer<typeof ToolRequestSchema>;
    try {
      request = ToolRequestSchema.parse(frame.request);
    } catch (error) {
      // issue #4b：把 ZodError.issues 转成可读、可操作的错误，别再吞成一句裸字符串。
      // 保留每条 issue 的中文原文与字段路径；files 超限给出明确上限与「收到 N 个」。
      const issues = error instanceof z.ZodError ? error.issues : [];
      const rawArgs = (frame.request as { args?: Record<string, unknown> } | null)?.args;
      const received = Array.isArray(rawArgs?.files)
        ? (rawArgs.files as unknown[]).length
        : undefined;
      let tooManyFiles = false;
      const details = issues.map((issue) => {
        const path = issue.path.map(String).join('.');
        if (issue.code === 'too_big' && issue.path.at(-1) === 'files') {
          tooManyFiles = true;
          return `一次最多 ${Number(issue.maximum)} 个文件（收到 ${received ?? '过多'}），请分批上传（字段 ${path}）`;
        }
        return `${path ? `${path}: ` : ''}${issue.message}`;
      });
      const message = `request 不符合 ToolRequestSchema${details.length ? `：${details.join('；')}` : ''}`;
      const code = tooManyFiles ? 'TOO_MANY_FILES' : 'INVALID_TOOL_REQUEST';
      this.#audit('external.request.invalid', {
        connectionId,
        principal: conn.principal,
        error: message,
      });
      socket.write(`${JSON.stringify({ id: frame.id, error: message, code })}\n`);
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
          ...externalErrorDiagnostics(error),
        })}\n`,
      );
    }
  }

  async #handleControl(
    socket: Socket,
    connectionId: string,
    conn: ExternalConnection,
    frame: z.infer<typeof ControlFrameSchema>,
  ): Promise<void> {
    const { control, id } = frame;
    const base = { connectionId, principal: conn.principal, clientId: conn.clientId };
    try {
      let result: unknown;
      let spaceId: string | undefined;
      if (control.op === 'space.create') {
        const created = await this.options.runtime.spaces.create(conn.clientId, control.label);
        spaceId = created.spaceId;
        result = created;
      } else if (control.op === 'space.list') {
        const spaces = await this.options.runtime.spaces.list(conn.clientId);
        result = { spaces };
      } else if (control.op === 'space.close') {
        spaceId = control.spaceId;
        await this.options.runtime.spaces.close(conn.clientId, control.spaceId);
        result = { ok: true };
      }
      socket.write(`${JSON.stringify({ id, result })}\n`);
      this.#audit(`external.control.${control.op}`, { ...base, ...(spaceId ? { spaceId } : {}) });
    } catch (error) {
      // 失败也留痕：只记错误码，不记任务名等调用方输入。
      this.#audit('external.control.failed', {
        ...base,
        op: control.op,
        ...(control.op === 'space.close' ? { spaceId: control.spaceId } : {}),
        reason: externalErrorDiagnostics(error).code ?? 'unknown',
      });
      socket.write(
        `${JSON.stringify({
          id,
          error: error instanceof Error ? error.message : String(error),
          ...externalErrorDiagnostics(error),
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
