import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExternalClientRegistry } from '../src/main/external/client-registry.js';

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
