import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 外部客户端注册表：每个客户端一个独立 token。
 * 磁盘上只存 token 的 scrypt 哈希（每客户端独立 salt），绝不落明文。
 * 文件本身放在 userData/external（0700）下，以 0600 写入，只有当前用户可读。
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

function sanitizeName(name: string): string {
  const clean = name.trim().slice(0, 64);
  return clean || 'unnamed';
}

function hashToken(token: string, salt: string): string {
  return scryptSync(token, salt, SCRYPT_KEYLEN).toString('base64');
}

export interface CreateClientResult {
  client: ExternalClient;
  /** 明文 token，只在创建这一次返回；之后磁盘/IPC 都拿不到。 */
  token: string;
}

export class ExternalClientRegistry {
  #clients: StoredClient[] = [];
  #loaded = false;

  constructor(private readonly dir: string) {}

  /** 文件路径（迁移/启动清理时用）。 */
  get path(): string {
    return `${this.dir}/${REGISTRY_NAME}`;
  }

  private async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && Array.isArray(parsed.clients)) this.#clients = parsed.clients;
    } catch {
      this.#clients = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const payload: RegistryFile = { version: 1, clients: this.#clients };
    // 唯一临时名：并发 save（touch / create / revoke）不会互相踩同一个 tmp。
    const tmp = `${this.path}.${randomBytes(4).toString('base64url')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  /** 新建客户端：生成随机 32 字节 token，只把哈希落盘，明文随结果一次性返回。 */
  async create(name: string): Promise<CreateClientResult> {
    await this.load();
    const token = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('base64url');
    const now = new Date().toISOString();
    const entry: StoredClient = {
      clientId: randomBytes(8).toString('base64url'),
      name: sanitizeName(name),
      createdAt: now,
      lastUsedAt: now,
      salt,
      hash: hashToken(token, salt),
    };
    this.#clients.push(entry);
    await this.save();
    return { client: this.public(entry), token };
  }

  /** 用一个 token 反查客户端；找不到 / 已吊销返回 undefined。 */
  async verify(token: string): Promise<ExternalClient | undefined> {
    await this.load();
    for (const entry of this.#clients) {
      if (entry.revokedAt) continue;
      const expected = Buffer.from(entry.hash, 'base64');
      const actual = Buffer.from(hashToken(token, entry.salt), 'base64');
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        return this.public(entry);
      }
    }
    return undefined;
  }

  /** 记录一次成功连接的最后使用时间。 */
  async touch(clientId: string): Promise<void> {
    await this.load();
    const entry = this.#clients.find((c) => c.clientId === clientId);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    await this.save();
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

  /** 吊销：保留记录、标 revokedAt，对应 token 立即失效。 */
  async revoke(clientId: string): Promise<ExternalClient | undefined> {
    await this.load();
    const entry = this.#clients.find((c) => c.clientId === clientId);
    if (!entry) return undefined;
    if (entry.revokedAt) return this.public(entry);
    entry.revokedAt = new Date().toISOString();
    await this.save();
    return this.public(entry);
  }

  /** 删除：连记录一起移除。 */
  async remove(clientId: string): Promise<boolean> {
    await this.load();
    const before = this.#clients.length;
    this.#clients = this.#clients.filter((c) => c.clientId !== clientId);
    if (this.#clients.length === before) return false;
    await this.save();
    return true;
  }

  private public(entry: StoredClient): ExternalClient {
    const { clientId, name, createdAt, lastUsedAt, revokedAt } = entry;
    return { clientId, name, createdAt, lastUsedAt, ...(revokedAt ? { revokedAt } : {}) };
  }
}
