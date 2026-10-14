import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 外部客户端注册表：每个客户端一个独立 token。
 * 磁盘上只存 token 的 scrypt 哈希（每客户端独立 salt），绝不落明文。
 * 文件本身放在 userData/external（0700）下，以 0600 写入，只有当前用户可读。
 *
 * token 形如 `pct_<clientId>_<secret>`：握手时客户端把整串发来，服务端从前缀直接定位到唯一
 * 客户端，只做一次 scrypt，不必遍历全部客户端（防未认证方逐个同步哈希造成 DoS）。
 */

export interface ExternalClient {
  clientId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
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

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const payload: RegistryFile = { version: 1, clients: this.#clients };
    // 唯一临时名：并发 save 不会互相踩同一个 tmp。
    const tmp = `${this.path}.${randomBytes(4).toString('base64url')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  /** 把一个写操作排进串行队列，确保 load-modify-save 不交错。 */
  private mutate<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#writeChain.then(() => op());
    // 队列本身不拒绝；失败也要继续往后排。
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  /** 新建客户端：生成随机 32 字节 token，只把哈希落盘，明文随结果一次性返回。 */
  create(name: string): Promise<CreateClientResult> {
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
        salt,
        hash: derived.toString('base64'),
      };
      this.#clients.push(entry);
      await this.save();
      return { client: this.public(entry), token };
    });
  }

  /** 用一个 token 反查客户端：从前缀定位到唯一客户端，只做一次 scrypt；找不到/吊销返回 undefined。 */
  async verify(token: string): Promise<ExternalClient | undefined> {
    await this.load();
    const clientId = clientIdFromToken(token);
    if (!clientId) return undefined;
    const entry = this.#clients.find((c) => c.clientId === clientId);
    if (!entry || entry.revokedAt) return undefined;
    const derived = await hashToken(token, entry.salt);
    const expected = Buffer.from(entry.hash, 'base64');
    if (expected.length !== derived.length || !timingSafeEqual(expected, derived)) return undefined;
    return this.public(entry);
  }

  /** 记录一次成功连接的最后使用时间（串行写）。 */
  touch(clientId: string): Promise<void> {
    return this.mutate(async () => {
      await this.load();
      const entry = this.#clients.find((c) => c.clientId === clientId);
      if (!entry) return;
      entry.lastUsedAt = new Date().toISOString();
      await this.save();
    });
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

  /** 吊销：保留记录、标 revokedAt，对应 token 立即失效（串行写）。 */
  revoke(clientId: string): Promise<ExternalClient | undefined> {
    return this.mutate(async () => {
      await this.load();
      const entry = this.#clients.find((c) => c.clientId === clientId);
      if (!entry) return undefined;
      if (entry.revokedAt) return this.public(entry);
      entry.revokedAt = new Date().toISOString();
      await this.save();
      return this.public(entry);
    });
  }

  /** 删除：连记录一起移除（串行写）。 */
  remove(clientId: string): Promise<boolean> {
    return this.mutate(async () => {
      await this.load();
      const before = this.#clients.length;
      this.#clients = this.#clients.filter((c) => c.clientId !== clientId);
      if (this.#clients.length === before) return false;
      await this.save();
      return true;
    });
  }

  private public(entry: StoredClient): ExternalClient {
    const { clientId, name, createdAt, lastUsedAt, revokedAt } = entry;
    return { clientId, name, createdAt, lastUsedAt, ...(revokedAt ? { revokedAt } : {}) };
  }
}
