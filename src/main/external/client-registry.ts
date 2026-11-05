import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { renameSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PermissionMode } from '../../shared/contracts.js';

/**
 * 外部客户端注册表：每个客户端一个独立 token。
 * 磁盘上只存 token 的 scrypt 哈希（每客户端独立 salt），绝不落明文。
 * 文件本身放在 userData/external（0700）下，以 0600 写入，只有当前用户可读。
 *
 * token 形如 `pct_<clientId>_<secret>`：握手时客户端把整串发来，服务端从前缀直接定位到唯一
 * 客户端，只做一次 scrypt，不必遍历全部客户端（防未认证方逐个同步哈希造成 DoS）。
 * CLI 是短连接进程：首次校验成功后把 token 摘要放进进程内缓存，后续握手跳过 scrypt（磁盘仍只存哈希）。
 */

export type ExternalClientKind = 'agent-integration';

export interface ExternalClient {
  clientId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
  /** 由「安装到 Agent」签发的客户端；UI 显示「集成」徽标，吊销/删除时同时清理本机集成文件。 */
  kind?: ExternalClientKind;
  /** 旧记录缺省为 ask；只有用户可经可信界面更改。 */
  permissionMode?: PermissionMode;
}

/** 磁盘上的完整记录（含哈希，绝不在日志/IPC 外返回给 renderer）。 */
interface StoredClient extends ExternalClient {
  salt: string;
  hash: string;
}

interface RegistryFile {
  version: 1;
  clients: StoredClient[];
}

const REGISTRY_NAME = 'clients.json';
// Online and offline registry instances share one write queue for the same file.
const registryWrites = new Map<string, Promise<unknown>>();
const SCRYPT_KEYLEN = 64;
const TOKEN_PREFIX = 'pct_';
/** clientId 固定长度（8 字节 base64url = 11 字符）；base64url 自带 `_`，故按定长切片而非找分隔符。 */
const CLIENT_ID_BYTES = 8;
const CLIENT_ID_LEN = Math.ceil((CLIENT_ID_BYTES * 4) / 3);

function sanitizeName(name: string): string {
  const clean = name.trim().slice(0, 64);
  return clean || 'unnamed';
}

function hashToken(token: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(token, salt, SCRYPT_KEYLEN, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/** 从 token 前缀解出 clientId；格式不对返回 undefined。 */
function clientIdFromToken(token: string): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = token.slice(TOKEN_PREFIX.length);
  if (rest.length <= CLIENT_ID_LEN + 1) return undefined;
  if (rest[CLIENT_ID_LEN] !== '_') return undefined;
  return rest.slice(0, CLIENT_ID_LEN);
}

/** 固定的“未命中”假 salt：clientId 不存在时也跑一次同参数 scrypt，拉平成功/失败时延。 */
const DUMMY_SALT = 'pilion-external-dummy-salt';

/** 用同参数 scrypt 跑一次（结果丢弃），避免未命中时秒回造成时序侧信道。 */
async function dummyScrypt(): Promise<void> {
  await hashToken('pilion-external-dummy-token', DUMMY_SALT);
}

/** 已验证 token 的进程内缓存时长：到期后强制重新做一次 scrypt 校验。 */
const VERIFIED_TOKEN_TTL_MS = 10 * 60 * 1000;
/** 缓存容量上限：超出按验证先后淘汰最旧条目，避免被大量 token 撑爆内存。 */
const VERIFIED_TOKEN_MAX = 64;
/** lastUsedAt 的内存合并窗口：磁盘最多每分钟重写一次，而不是每次握手都写。 */
const TOUCH_FLUSH_MS = 60 * 1000;

interface VerifiedTokenEntry {
  clientId: string;
  verifiedAt: number;
}

/** 缓存 key 用完整 token 的 SHA-256（十六进制）：进程内存里不出现明文 token。 */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateClientResult {
  client: ExternalClient;
  /** 明文 token，只在创建这一次返回；之后磁盘/IPC 都拿不到。 */
  token: string;
}

export class ExternalClientRegistry {
  #clients: StoredClient[] = [];
  #loaded = false;
  /** 写路径串行队列：create/revoke/remove/touch 全部排队执行，避免交错把吊销写丢。 */
  #writeChain: Promise<unknown> = Promise.resolve();
  /**
   * 已验证 token 摘要（SHA-256 → 客户端）的进程内缓存：CLI 每次命令都重连，
   * 首次 scrypt 成功后在此记一笔，后续握手直接命中、跳过数十毫秒的 scrypt。
   * 只存摘要不存明文；TTL 到期、吊销或删除时立即失效。
   */
  #verifiedTokens = new Map<string, VerifiedTokenEntry>();
  /** 尚未落盘的 lastUsedAt（clientId → ISO 时间），由定时器合并成一次磁盘写。 */
  #pendingTouches = new Map<string, string>();
  #touchTimer?: NodeJS.Timeout;

  constructor(private readonly dir: string) {}

  /** 文件路径（迁移/启动清理时用）。 */
  get path(): string {
    return `${this.dir}/${REGISTRY_NAME}`;
  }

  private async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      // 只有“文件不存在”算空注册表；其它错误（权限/IO/JSON 损坏）直接抛出，不静默清空。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#clients = [];
        return;
      }
      this.#loaded = false;
      throw error;
    }
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.clients)) throw new Error('外部客户端注册表格式损坏');
    this.#clients = parsed.clients;
  }

  private async save(
    clients = this.#clients,
    validate?: () => Promise<void>,
    commit?: () => void,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const payload: RegistryFile = { version: 1, clients };
    // 唯一临时名：并发 save 不会互相踩同一个 tmp。
    const tmp = `${this.path}.${randomBytes(4).toString('base64url')}.tmp`;
    let replaced = false;
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await validate?.();
      if (commit) {
        // No event-loop window between the last live check, atomic replacement and publication.
        // The prior file remains intact on failure; cancellation never needs a second disk write.
        commit();
        renameSync(tmp, this.path);
        this.#clients = clients;
      } else await rename(tmp, this.path);
      replaced = true;
    } finally {
      if (!replaced) await rm(tmp, { force: true });
    }
  }

  /** 把一个写操作排进串行队列，确保 load-modify-save 不交错。 */
  private mutate<T>(op: () => Promise<T>): Promise<T> {
    const path = resolve(this.path);
    const run = (registryWrites.get(path) ?? Promise.resolve()).then(() => {
      // Reload under the shared queue: another instance may have revoked a token.
      this.#loaded = false;
      return op();
    });
    // 队列本身不拒绝；失败也要继续往后排。
    this.#writeChain = run.catch(() => undefined);
    const settled = this.#writeChain;
    registryWrites.set(path, settled);
    void settled.then(() => {
      if (registryWrites.get(path) === settled) registryWrites.delete(path);
    });
    return run;
  }

  async drain(): Promise<void> {
    // 先把合并窗口里的 lastUsedAt 落盘，再等在途写队列。
    await this.#flushTouches();
    await this.#writeChain;
  }

  /** 新建客户端：生成随机 32 字节 token，只把哈希落盘，明文随结果一次性返回。 */
  create(name: string, kind?: ExternalClientKind): Promise<CreateClientResult> {
    return this.mutate(async () => {
      await this.load();
      const clientId = randomBytes(CLIENT_ID_BYTES).toString('base64url');
      const secret = randomBytes(32).toString('base64url');
      const token = `${TOKEN_PREFIX}${clientId}_${secret}`;
      const salt = randomBytes(16).toString('base64url');
      const now = new Date().toISOString();
      const derived = await hashToken(token, salt);
      const entry: StoredClient = {
        clientId,
        name: sanitizeName(name),
        createdAt: now,
        lastUsedAt: now,
        ...(kind ? { kind } : {}),
        salt,
        hash: derived.toString('base64'),
      };
      this.#clients.push(entry);
      await this.save();
      return { client: this.public(entry), token };
    });
  }

  /**
   * 用一个 token 反查客户端：命中进程内缓存就跳过 scrypt，否则做一次 scrypt（成功后写缓存）；
   * 找不到/吊销返回 undefined。失败路径与缓存前保持一致（仍跑 dummyScrypt 拉平时延）。
   */
  async verify(token: string): Promise<ExternalClient | undefined> {
    await this.load();
    const digest = tokenDigest(token);
    const cached = this.#verifiedTokens.get(digest);
    if (cached) {
      const entry = this.#clients.find((c) => c.clientId === cached.clientId);
      // 命中也要复核内存注册表：缓存过期、记录被删、或被吊销都不能放行。
      if (entry && !entry.revokedAt && Date.now() - cached.verifiedAt < VERIFIED_TOKEN_TTL_MS) {
        return this.public(entry);
      }
      this.#verifiedTokens.delete(digest);
      // 落回下面的常规路径：吊销/删除的记录会走 dummyScrypt 失败，过期记录则重新做一次 scrypt。
    }
    const clientId = clientIdFromToken(token);
    const entry = clientId ? this.#clients.find((c) => c.clientId === clientId) : undefined;
    if (!entry || entry.revokedAt) {
      // 未命中也跑一次同参数 scrypt，拉平时延（时序侧信道）。
      await dummyScrypt();
      return undefined;
    }
    const derived = await hashToken(token, entry.salt);
    const expected = Buffer.from(entry.hash, 'base64');
    if (expected.length !== derived.length || !timingSafeEqual(expected, derived)) return undefined;
    // scrypt 是异步的：校验期间客户端可能刚被吊销/删除，这时不能落缓存、也不放行。
    if (!this.assertActive(entry.clientId)) return undefined;
    // 只有 scrypt 校验成功才写缓存；缓存 key 是完整 token 的摘要，不保存明文。
    this.#rememberVerified(digest, entry.clientId);
    return this.public(entry);
  }

  /** 写入已验证 token 缓存；容量有界，超出按插入顺序淘汰最旧条目。 */
  #rememberVerified(digest: string, clientId: string): void {
    this.#verifiedTokens.delete(digest);
    this.#verifiedTokens.set(digest, { clientId, verifiedAt: Date.now() });
    while (this.#verifiedTokens.size > VERIFIED_TOKEN_MAX) {
      const oldest = this.#verifiedTokens.keys().next().value;
      if (oldest === undefined) break;
      this.#verifiedTokens.delete(oldest);
    }
  }

  /** 吊销/删除后立即失效该客户端的全部缓存摘要（同一实例内，不等 TTL）。 */
  #invalidateVerifiedFor(clientId: string): void {
    for (const [digest, cached] of this.#verifiedTokens) {
      if (cached.clientId === clientId) this.#verifiedTokens.delete(digest);
    }
  }

  /** verify 之后、admit 之前在内存里复查一次是否仍未吊销（不读盘、不写盘）。 */
  assertActive(clientId: string): boolean {
    const entry = this.#clients.find((c) => c.clientId === clientId);
    return Boolean(entry && !entry.revokedAt);
  }

  /**
   * 记录一次成功连接的最后使用时间：内存立即更新，磁盘最多每 TOUCH_FLUSH_MS 合并写一次
   * （每次 hello 都整表重写是外部 CLI 短连接的主要磁盘 I/O 抖动源）。stop 时 drain() 会先刷盘。
   */
  async touch(clientId: string): Promise<void> {
    await this.load();
    const entry = this.#clients.find((c) => c.clientId === clientId);
    if (!entry) return;
    const now = new Date().toISOString();
    entry.lastUsedAt = now;
    this.#pendingTouches.set(clientId, now);
    if (this.#touchTimer) return;
    this.#touchTimer = setTimeout(() => {
      this.#touchTimer = undefined;
      void this.#flushTouches();
    }, TOUCH_FLUSH_MS);
    this.#touchTimer.unref();
  }

  /** 把合并窗口内攒下的 lastUsedAt 落盘（串行写）；落盘失败只记日志，不影响握手。 */
  async #flushTouches(): Promise<void> {
    if (this.#touchTimer) {
      clearTimeout(this.#touchTimer);
      this.#touchTimer = undefined;
    }
    if (this.#pendingTouches.size === 0) return;
    const pending = new Map(this.#pendingTouches);
    this.#pendingTouches.clear();
    try {
      await this.mutate(async () => {
        await this.load();
        let changed = false;
        for (const [clientId, at] of pending) {
          const entry = this.#clients.find((c) => c.clientId === clientId);
          if (!entry) continue; // 合并窗口内被删除的客户端就不用再写了。
          entry.lastUsedAt = at;
          changed = true;
        }
        if (changed) await this.save();
      });
    } catch (error) {
      console.error('[external] lastUsedAt 落盘失败', error);
    }
  }

  /** 设置页列表：绝不返回哈希/salt。 */
  async list(): Promise<ExternalClient[]> {
    await this.load();
    return this.#clients.map((c) => this.public(c));
  }

  /** 同步返回已加载的快照（state 广播用；未加载时为空，start 时会预热）。 */
  snapshot(): ExternalClient[] {
    return this.#clients.map((c) => this.public(c));
  }

  setPermissionMode(
    clientId: string,
    mode: PermissionMode,
    validate?: () => Promise<void>,
    commit?: () => void,
  ): Promise<ExternalClient> {
    return this.mutate(async () => {
      await this.load();
      if (mode !== 'ask' && mode !== 'full') throw new Error('无效的客户端权限');
      const entry = this.#clients.find((c) => c.clientId === clientId);
      if (!entry || entry.revokedAt) throw new Error('客户端不存在或已吊销');
      const updated = { ...entry, permissionMode: mode };
      const next = this.#clients.map((c) => (c === entry ? updated : c));
      // 写入成功后才发布权限，失败不能在内存中留下 full。
      await this.save(next, validate, commit ?? (() => undefined));
      this.#clients = next;
      return this.public(updated);
    });
  }

  /** 吊销：保留记录、标 revokedAt，对应 token 立即失效（含进程内缓存，串行写）。 */
  revoke(clientId: string): Promise<ExternalClient | undefined> {
    return this.mutate(async () => {
      await this.load();
      const entry = this.#clients.find((c) => c.clientId === clientId);
      if (!entry) return undefined;
      // 先失效缓存再落盘：即使写盘失败，本实例也不会再用缓存放行这个 token。
      this.#invalidateVerifiedFor(clientId);
      if (entry.revokedAt) return this.public(entry);
      entry.revokedAt = new Date().toISOString();
      await this.save();
      return this.public(entry);
    });
  }

  /** 删除：连记录一起移除，并立即失效其进程内缓存（串行写）。 */
  remove(clientId: string): Promise<boolean> {
    return this.mutate(async () => {
      await this.load();
      const before = this.#clients.length;
      this.#clients = this.#clients.filter((c) => c.clientId !== clientId);
      if (this.#clients.length === before) return false;
      this.#invalidateVerifiedFor(clientId);
      await this.save();
      return true;
    });
  }

  private public(entry: StoredClient): ExternalClient {
    const { clientId, name, createdAt, lastUsedAt, revokedAt, kind } = entry;
    return {
      clientId,
      name,
      createdAt,
      lastUsedAt,
      ...(revokedAt ? { revokedAt } : {}),
      ...(kind ? { kind } : {}),
      permissionMode: entry.permissionMode === 'full' ? 'full' : 'ask',
    };
  }
}
