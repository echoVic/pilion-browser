import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalClientRegistry } from '../src/main/external/client-registry.js';
import { ExternalControlServer } from '../src/main/external/server.js';
import type { ExternalConnection, ExternalRuntime } from '../src/main/external/types.js';
import { externalPrincipalForClient } from '../src/main/external/types.js';

// 只让注册表的临时文件写失败（磁盘满、权限被改），其余文件操作保持真实。
const disk = vi.hoisted(() => ({ failRegistryWrites: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = ((path: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
    if (disk.failRegistryWrites && /clients\.json\.[^/]+\.tmp$/.test(String(path)))
      return Promise.reject(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
      );
    return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
  }) as typeof actual.writeFile;
  return { ...actual, writeFile };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pilion-durable-'));
  disk.failRegistryWrites = false;
});
afterEach(async () => {
  disk.failRegistryWrites = false;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function storedRevokedAt(clientId: string): Promise<string | undefined> {
  const raw = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8')) as {
    clients: Array<{ clientId: string; revokedAt?: string }>;
  };
  return raw.clients.find((c) => c.clientId === clientId)?.revokedAt;
}

describe('a revoke whose disk write fails', () => {
  it('stays rejected after any reload in this process and is written by the next mutation', async () => {
    const { client, token } = await new ExternalClientRegistry(dir).create('cli');
    disk.failRegistryWrites = true;
    await expect(new ExternalClientRegistry(dir).revoke(client.clientId)).rejects.toThrow(/ENOSPC/);
    expect(await storedRevokedAt(client.clientId)).toBeUndefined();
    // 任何实例重新读盘都会把这次吊销套回去：不会因为写盘失败而复活。
    const fresh = new ExternalClientRegistry(dir);
    expect(await fresh.verify(token)).toBeUndefined();
    expect(fresh.assertActive(client.clientId)).toBe(false);
    expect((await fresh.list())[0]?.revokedAt).toBeDefined();

    disk.failRegistryWrites = false;
    await new ExternalClientRegistry(dir).create('another');
    expect(await storedRevokedAt(client.clientId)).toBeDefined();
  });
});

describe('ExternalControlServer revoke and delete when the registry cannot be written', () => {
  let server: ExternalControlServer;
  let events: string[];
  let revokedPrincipals: string[];
  let stoppedClients: string[];
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    events = [];
    revokedPrincipals = [];
    stoppedClients = [];
    const runtime: ExternalRuntime = {
      isEnabled: () => true,
      recordEvent: (type) => events.push(type),
      admit: (clientId, name): ExternalConnection => ({
        principal: externalPrincipalForClient(clientId),
        clientId,
        name,
        connectedAt: new Date().toISOString(),
        attachmentId: `att-${clientId}`,
        run: async () => ({ ok: true }),
        close: () => undefined,
        revoke: () => undefined,
      }),
      revokePrincipalAcl: (principal) => revokedPrincipals.push(principal),
      spaces: {
        admit: async () => 'ok' as const,
        create: async () => ({ spaceId: 'agent-x' }),
        list: async () => [],
        close: async () => undefined,
        stopClient: async (clientId) => {
          stoppedClients.push(clientId);
        },
      },
    };
    server = new ExternalControlServer({ dir, runtime, command: 'node', mcpClientPath: '/m.js' });
    await server.start();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    disk.failRegistryWrites = false;
    await server.stop().catch(() => undefined);
  });

  /** 握手并保持连接；返回服务端的第一行应答。 */
  function hello(token: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(server.socketPath);
      sockets.add(socket);
      let buffer = '';
      socket.once('error', reject);
      socket.once('connect', () => socket.write(`${JSON.stringify({ token })}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(buffer.slice(0, newline));
      });
    });
  }

  it.each(['revokeClient', 'deleteClient'] as const)(
    '%s cuts the client first, rejects the call and keeps refusing the token',
    async (operation) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { client, token } = await server.createClient('cli');
      expect(JSON.parse(await hello(token))).toEqual({});
      expect(server.describeConnections()).toHaveLength(1);

      disk.failRegistryWrites = true;
      await expect(server[operation](client.clientId)).rejects.toThrow(/没能写进磁盘/);
      // 写盘失败也已经切断：活动连接、Tab ACL、Agent Space 都不留。
      expect(server.describeConnections()).toEqual([]);
      expect(revokedPrincipals).toContain(externalPrincipalForClient(client.clientId));
      expect(stoppedClients).toEqual([client.clientId]);
      expect(events).toContain('external.client.revoke_unpersisted');
      // 重连被拒：本进程里它已经是吊销状态。
      expect(JSON.parse(await hello(token))).toEqual({ error: 'authentication failed' });
    },
  );
});
