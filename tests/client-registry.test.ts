import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalClientRegistry } from '../src/main/external/client-registry.js';

// scrypt 计数：用来断言第二次握手命中缓存后不再跑 scrypt；其余加密函数保持真实实现。
const cryptoCalls = vi.hoisted(() => ({ scrypt: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const countingScrypt = (...args: Parameters<typeof actual.scrypt>): void => {
    cryptoCalls.scrypt += 1;
    actual.scrypt(...args);
  };
  return { ...actual, scrypt: countingScrypt };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pilion-registry-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('a revoke through a separate registry instance persists: a fresh load rejects the token', async () => {
  // 「移除」在通道关闭时走的就是这条路：另起一个注册表实例只为吊销。
  const { client, token } = await new ExternalClientRegistry(dir).create('c', 'agent-integration');
  expect(await new ExternalClientRegistry(dir).verify(token)).toMatchObject({
    clientId: client.clientId,
  });
  const revoked = await new ExternalClientRegistry(dir).revoke(client.clientId);
  expect(revoked?.revokedAt).toBeDefined();
  const fresh = new ExternalClientRegistry(dir);
  expect(await fresh.verify(token)).toBeUndefined();
  expect((await fresh.list())[0]?.revokedAt).toBeDefined();
});

it('revoking an unknown id is a no-op that writes nothing', async () => {
  const registry = new ExternalClientRegistry(dir);
  expect(await registry.revoke('nope')).toBeUndefined();
  await expect(stat(registry.path)).rejects.toThrow();
  await new ExternalClientRegistry(dir).create('c');
  const before = await readFile(registry.path, 'utf8');
  expect(await new ExternalClientRegistry(dir).revoke('nope')).toBeUndefined();
  expect(await readFile(registry.path, 'utf8')).toBe(before);
});

it('defaults to ask and persists full permission across fresh loads and token verification', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  expect(client.permissionMode).toBe('ask');
  await registry.setPermissionMode(client.clientId, 'full');
  const fresh = new ExternalClientRegistry(dir);
  expect((await fresh.verify(token))?.permissionMode).toBe('full');
  await fresh.setPermissionMode(client.clientId, 'ask');
  expect((await new ExternalClientRegistry(dir).list())[0]?.permissionMode).toBe('ask');
});

it('cannot grant permission to an unknown or revoked client', async () => {
  const registry = new ExternalClientRegistry(dir);
  await expect(registry.setPermissionMode('missing', 'full')).rejects.toThrow();
  const { client } = await registry.create('CLI');
  await registry.revoke(client.clientId);
  await expect(registry.setPermissionMode(client.clientId, 'full')).rejects.toThrow();
});

it('failed persistence leaves permission unchanged in memory and on disk', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client } = await registry.create('CLI');
  await rename(registry.path, `${registry.path}.saved`);
  await mkdir(registry.path);
  await expect(registry.setPermissionMode(client.clientId, 'full')).rejects.toThrow();
  expect(registry.snapshot()[0]?.permissionMode).toBe('ask');
  await rm(registry.path, { recursive: true });
  await rename(`${registry.path}.saved`, registry.path);
  expect((await new ExternalClientRegistry(dir).list())[0]?.permissionMode).toBe('ask');
  await registry.setPermissionMode(client.clientId, 'full');
  await rename(registry.path, `${registry.path}.saved`);
  await mkdir(registry.path);
  await expect(registry.setPermissionMode(client.clientId, 'ask')).rejects.toThrow();
  expect(registry.snapshot()[0]?.permissionMode).toBe('full');
});

it('old client records without a permission field retain ask behavior', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { token } = await registry.create('CLI');
  const saved = JSON.parse(await readFile(registry.path, 'utf8'));
  delete saved.clients[0].permissionMode;
  await writeFile(registry.path, JSON.stringify(saved));
  expect((await new ExternalClientRegistry(dir).verify(token))?.permissionMode).toBe('ask');
});

it('an offline revoke queued during a permission write cannot be overwritten', async () => {
  const online = new ExternalClientRegistry(dir);
  const { client, token } = await online.create('CLI');
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const grant = online.setPermissionMode(client.clientId, 'full', async () => {
    reached();
    await gate;
  });
  await started;
  const revoke = new ExternalClientRegistry(dir).revoke(client.clientId);
  release();
  await Promise.all([grant, revoke]);
  expect(await new ExternalClientRegistry(dir).verify(token)).toBeUndefined();
  await expect(online.setPermissionMode(client.clientId, 'full')).rejects.toThrow(/吊销/);
});

it.each([1, 2])(
  'failed validation at persistence stage %s leaves no full permission',
  async (stage) => {
    const registry = new ExternalClientRegistry(dir);
    const { client } = await registry.create('CLI');
    await expect(
      registry.setPermissionMode(
        client.clientId,
        'full',
        async () => {
          if (stage === 1) throw new Error('approval cancelled');
        },
        () => {
          if (stage === 2) throw new Error('approval cancelled');
        },
      ),
    ).rejects.toThrow('approval cancelled');
    expect(registry.snapshot()[0]?.permissionMode).toBe('ask');
    expect((await new ExternalClientRegistry(dir).list())[0]?.permissionMode).toBe('ask');
  },
);

it('a concurrent reader never sees full while grant validation is pending', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const grant = registry
    .setPermissionMode(
      client.clientId,
      'full',
      async () => {
        reached();
        await gate;
      },
      () => {
        throw new Error('cancelled');
      },
    )
    .catch(() => 'cancelled');
  await started;
  const reader = new ExternalClientRegistry(dir);
  expect((await reader.verify(token))?.permissionMode).toBe('ask');
  release();
  expect(await grant).toBe('cancelled');
  expect(reader.snapshot()[0]?.permissionMode).toBe('ask');
  expect((await new ExternalClientRegistry(dir).verify(token))?.permissionMode).toBe('ask');
});

it('a verified token is served from the process cache on later handshakes', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  const baseline = cryptoCalls.scrypt;
  // 首次握手：前缀定位 + 一次 scrypt。
  expect((await registry.verify(token))?.clientId).toBe(client.clientId);
  expect(cryptoCalls.scrypt).toBe(baseline + 1);
  // 同一 token 连续 verify（CLI 每次命令都重连）：命中缓存，不再跑 scrypt。
  expect((await registry.verify(token))?.clientId).toBe(client.clientId);
  expect((await registry.verify(token))?.clientId).toBe(client.clientId);
  expect(cryptoCalls.scrypt).toBe(baseline + 1);
});

it('the token cache expires after its TTL and forces one fresh scrypt', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { token } = await registry.create('CLI');
  expect(await registry.verify(token)).toBeDefined();
  const cached = cryptoCalls.scrypt;
  expect(await registry.verify(token)).toBeDefined();
  expect(cryptoCalls.scrypt).toBe(cached);
  // 超过 TTL 后不能再相信缓存，必须重新做一次 scrypt 校验。
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await registry.verify(token)).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
  expect(cryptoCalls.scrypt).toBe(cached + 1);
});

it('a cache hit cannot outlive a revoke or a delete in the same instance', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  expect(await registry.verify(token)).toBeDefined(); // 预热缓存
  await registry.revoke(client.clientId);
  // 吊销立即失效缓存，不是等 10 分钟 TTL 过期。
  expect(await registry.verify(token)).toBeUndefined();

  const second = await registry.create('CLI-2');
  expect(await registry.verify(second.token)).toBeDefined(); // 预热第二份缓存
  await registry.remove(second.client.clientId);
  expect(await registry.verify(second.token)).toBeUndefined();
});

it('revoking while the first scrypt verification is in flight rejects it and caches nothing', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  // 首次校验的 scrypt 还在跑时吊销：既不能放行，也不能把 token 写进缓存。
  const verifying = registry.verify(token);
  const revoking = registry.revoke(client.clientId);
  const [verified] = await Promise.all([verifying, revoking]);
  expect(verified).toBeUndefined();
  expect(await registry.verify(token)).toBeUndefined();
});

it('a cached token never admits another client or a forged secret', async () => {
  const registry = new ExternalClientRegistry(dir);
  const a = await registry.create('A');
  const b = await registry.create('B');
  expect(await registry.verify(a.token)).toBeDefined(); // 缓存 A
  // 另一个客户端的 token 照常验证成功，不会被 A 的缓存误命中。
  expect((await registry.verify(b.token))?.clientId).toBe(b.client.clientId);
  // 同一个 clientId、只改一个 secret 字符：缓存 key 是完整 token 的摘要，必须重新 scrypt 后拒绝。
  const last = a.token.at(-1) === 'A' ? 'B' : 'A';
  expect(await registry.verify(`${a.token.slice(0, -1)}${last}`)).toBeUndefined();
});

it('touch updates memory immediately but coalesces the registry rewrite until drain', async () => {
  const registry = new ExternalClientRegistry(dir);
  const { client, token } = await registry.create('CLI');
  expect(await registry.verify(token)).toBeDefined();
  const before = await readFile(registry.path, 'utf8');
  vi.useFakeTimers({ toFake: ['Date'] });
  let touchedAt: string;
  try {
    vi.setSystemTime(Date.now() + 60_000);
    touchedAt = new Date().toISOString();
    await registry.touch(client.clientId);
  } finally {
    vi.useRealTimers();
  }
  // 内存里立即生效，但合并窗口内不重写整表 JSON。
  expect((await registry.list())[0]?.lastUsedAt).toBe(touchedAt);
  expect(await readFile(registry.path, 'utf8')).toBe(before);
  // drain（外部通道 stop 时调用）把合并后的 lastUsedAt 落盘，新实例能读到。
  await registry.drain();
  const saved = JSON.parse(await readFile(registry.path, 'utf8')) as {
    clients: Array<{ lastUsedAt: string }>;
  };
  expect(saved.clients[0]?.lastUsedAt).toBe(touchedAt);
  expect((await new ExternalClientRegistry(dir).list())[0]?.lastUsedAt).toBe(touchedAt);
});
