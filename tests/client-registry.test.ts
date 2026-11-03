import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
