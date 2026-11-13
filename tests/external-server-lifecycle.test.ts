import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createConnection, type Server } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalControlServer } from '../src/main/external/server.js';
import type { ExternalRuntime } from '../src/main/external/types.js';
import { externalPrincipalForClient } from '../src/main/external/types.js';

// 只在 socket 文件上注入 chmod / stat 故障；记下每个被创建的监听，检查它最后是不是关掉了。
const faults = vi.hoisted(() => ({
  chmod: false,
  mode: undefined as number | undefined,
  servers: [] as Server[],
}));
const isSocketFile = (path: unknown) => {
  const name = basename(String(path));
  return name === 'external.sock' || name.startsWith('.s-');
};
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const chmod = ((
    path: Parameters<typeof actual.chmod>[0],
    mode: Parameters<typeof actual.chmod>[1],
  ) =>
    faults.chmod && isSocketFile(path)
      ? Promise.reject(Object.assign(new Error('EPERM: chmod'), { code: 'EPERM' }))
      : actual.chmod(path, mode)) as typeof actual.chmod;
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    const info = await actual.stat(...args);
    if (faults.mode === undefined || !isSocketFile(args[0])) return info;
    return Object.assign(Object.create(Object.getPrototypeOf(info) as object), info, {
      mode: (Number(info.mode) & ~0o777) | faults.mode,
    });
  }) as typeof actual.stat;
  return { ...actual, chmod, stat };
});
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    faults.servers.push(server);
    return server;
  }) as typeof actual.createServer;
  return { ...actual, createServer };
});

let dir: string;
const servers: ExternalControlServer[] = [];

function runtime(): ExternalRuntime {
  return {
    isEnabled: () => true,
    recordEvent: () => undefined,
    admit: (clientId, name) => ({
      principal: externalPrincipalForClient(clientId),
      clientId,
      name,
      connectedAt: new Date().toISOString(),
      attachmentId: `att-${clientId}`,
      run: async () => ({ ok: true }),
      close: () => undefined,
      revoke: () => undefined,
    }),
    revokePrincipalAcl: () => undefined,
    spaces: {
      admit: async () => 'ok' as const,
      create: async () => ({ spaceId: 'agent-x' }),
      list: async () => [],
      close: async () => undefined,
      stopClient: async () => undefined,
    },
  };
}

function makeServer(): ExternalControlServer {
  const server = new ExternalControlServer({
    dir,
    runtime: runtime(),
    command: 'node',
    mcpClientPath: '/m.js',
  });
  servers.push(server);
  return server;
}

/** socket 目录里剩下的 socket 文件（正式名或临时名）。 */
async function socketFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => isSocketFile(name)).sort();
}

function connects(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pls-'));
  faults.chmod = false;
  faults.mode = undefined;
  faults.servers.length = 0;
});
afterEach(async () => {
  faults.chmod = false;
  faults.mode = undefined;
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('ExternalControlServer lifecycle', () => {
  it('a start that fails after listening closes the listener, and a later start works', async () => {
    const server = makeServer();
    faults.chmod = true;
    await expect(server.start()).rejects.toThrow(/EPERM/);
    expect(server.isListening).toBe(false);
    expect(faults.servers.every((listener) => !listener.listening)).toBe(true);
    expect(await socketFiles()).toEqual([]);

    faults.chmod = false;
    await server.start();
    expect(server.isListening).toBe(true);
    expect(await connects(server.socketPath)).toBe(true);
  });

  it('a socket whose mode is not 0600 is never left listening', async () => {
    const server = makeServer();
    faults.mode = 0o666;
    await expect(server.start()).rejects.toThrow(/0600/);
    expect(server.isListening).toBe(false);
    expect(faults.servers.every((listener) => !listener.listening)).toBe(true);
    expect(await socketFiles()).toEqual([]);
  });

  it("an older instance's stop does not remove a newer instance's socket", async () => {
    const older = makeServer();
    await older.start();
    const newer = makeServer();
    await newer.start();
    await older.stop();
    await expect(lstat(newer.socketPath)).resolves.toBeDefined();
    expect(await connects(newer.socketPath)).toBe(true);
    await newer.stop();
    expect(await socketFiles()).toEqual([]);
  });

  it('a stop issued mid-start leaves nothing listening and no socket behind', async () => {
    const server = makeServer();
    const starting = server.start();
    await server.stop();
    await starting;
    expect(server.isListening).toBe(false);
    expect(faults.servers.every((listener) => !listener.listening)).toBe(true);
    expect(await socketFiles()).toEqual([]);
    // 停完还能重新启动。
    await server.start();
    expect(await connects(server.socketPath)).toBe(true);
  });

  it.each(['createClient', 'revokeClient', 'deleteClient'] as const)(
    '%s fails clearly when the server is not listening',
    async (operation) => {
      const server = makeServer();
      await expect(server[operation]('x')).rejects.toThrow(/外部控制通道没有在运行/);
      await server.start();
      await server.stop();
      await expect(server[operation]('x')).rejects.toThrow(/外部控制通道没有在运行/);
      // 没有在磁盘上留下半个客户端。
      expect(await readdir(dir)).not.toContain('clients.json');
    },
  );
});
