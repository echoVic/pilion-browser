import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserError, BrowserService } from '../src/main/browser/index.js';
import { ExternalControlServer } from '../src/main/external/server.js';
import type { ExternalConnection, ExternalRuntime } from '../src/main/external/types.js';
import { externalPrincipalForClient } from '../src/main/external/types.js';

interface CapturingRuntime extends ExternalRuntime {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  received: unknown[];
  revokedPrincipals: string[];
}

/** 一条连接发 hello，等服务端 `{}` ack 后再发请求帧，读到带 id 的响应或错误就返回。 */
function sendOne(socketPath: string, hello: object, request: object): Promise<{ raw: string }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    let sentRequest = false;
    let done = false;
    const finish = (error: Error | null, raw = buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (error && !raw) reject(error);
      else resolve({ raw });
    };
    const timer = setTimeout(() => finish(new Error('timeout')), 5000);
    sock.once('connect', () => {
      try {
        sock.write(`${JSON.stringify(hello)}\n`);
      } catch {
        /* 服务端可能在认证前就断开 */
      }
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      // 服务端认证成功会先回 `{}\n`，收到后再发请求帧。
      if (!sentRequest && buf.includes('{}\n')) {
        sentRequest = true;
        try {
          if (!sock.destroyed) sock.write(`${JSON.stringify(request)}\n`);
        } catch {
          /* closed */
        }
      }
      if (!done && (buf.includes('"id"') || buf.includes('"error"'))) {
        // 拿到响应后再断开，并等服务端收尾（close 事件），避免连接在测试间堆积触达上限。
        sock.end();
      }
    });
    // 吞掉已断 socket 的异步 write EPIPE。
    sock.on('error', () => finish(null));
    sock.once('close', () => finish(null));
  });
}

describe('ExternalControlServer (per-client tokens)', () => {
  let dir: string;
  let captured: CapturingRuntime;
  let server: ExternalControlServer;
  /** 每个客户端创建后只在内存里持有明文 token 一次。 */
  let clientA: { clientId: string; name: string; token: string };
  let clientB: { clientId: string; name: string; token: string };

  function grab(result: { client: { clientId: string; name: string }; token: string }) {
    return { clientId: result.client.clientId, name: result.client.name, token: result.token };
  }

  function makeConnection(clientId: string, name: string): ExternalConnection {
    const principal = externalPrincipalForClient(clientId);
    return {
      principal,
      clientId,
      name,
      connectedAt: new Date().toISOString(),
      attachmentId: `att-${clientId}`,
      run: async (request) => {
        captured.received.push(request);
        return { ok: true, principal, request };
      },
      close: () => undefined,
      revoke: () => undefined,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilion-external-'));
    captured = {
      events: [],
      received: [],
      revokedPrincipals: [],
      isEnabled: () => true,
      recordEvent(type, payload) {
        captured.events.push({ type, payload });
      },
      admit(clientId, name) {
        return makeConnection(clientId, name);
      },
      revokePrincipalAcl(principal) {
        captured.revokedPrincipals.push(principal);
      },
    };
    server = new ExternalControlServer({
      dir,
      runtime: captured,
      command: 'pilion-test-node',
      mcpClientPath: '/tmp/pilion-mcp.js',
    });
    await server.start();
    clientA = grab(await server.createClient('claude-desktop'));
    clientB = grab(await server.createClient('cursor'));
  });

  afterEach(async () => {
    await server.stop().catch(() => undefined);
    // 等 fire-and-forget 的 touch() 写盘收尾，避免残留 .tmp 让 rmdir 报 ENOTEMPTY。
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(dir, { recursive: true, force: true });
  });

  it('stores only token hashes: registry file has no plaintext', async () => {
    const raw = await readFile(join(dir, 'clients.json'), 'utf8');
    expect(raw).not.toContain(clientA.token);
    expect(raw).not.toContain(clientB.token);
    // 每条记录都有 hash + salt，且不含 token 字段。
    const parsed = JSON.parse(raw) as {
      clients: Array<{ hash: string; salt: string; token?: string }>;
    };
    expect(parsed.clients).toHaveLength(2);
    for (const c of parsed.clients) {
      expect(c.hash.length).toBeGreaterThan(20);
      expect(c.salt.length).toBeGreaterThan(8);
      expect(c.token).toBeUndefined();
    }
    // 文件权限 0600、目录 0700。
    expect((await stat(join(dir, 'clients.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
  });

  it('creates a token once: a second lookup never returns the plaintext', async () => {
    for (const c of await server.listClients()) {
      expect(c).not.toHaveProperty('token');
      expect(c).not.toHaveProperty('hash');
    }
  });

  it('migrates away the legacy single-token config file', async () => {
    // 模拟旧版残留文件，重启后应被删除并写迁移审计。
    await rm(server.socketPath, { force: true });
    await server.stop();
    const legacy = join(dir, 'external-mcp.json');
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(legacy, '{"token":"old"}', { mode: 0o600 });
    await chmod(legacy, 0o600);
    server = new ExternalControlServer({
      dir,
      runtime: captured,
      command: 'n',
      mcpClientPath: '/p',
    });
    await server.start();
    await expect(stat(legacy)).rejects.toThrow();
    expect(captured.events.some((e) => e.type === 'external.legacy_config.removed')).toBe(true);
  });

  it('identifies connections by token: two clients get different principals', async () => {
    const connect = (token: string) =>
      new Promise<void>((resolve, reject) => {
        const sock = createConnection(server.socketPath);
        let buf = '';
        sock.once('error', reject);
        sock.on('data', (chunk) => {
          buf += chunk.toString();
          if (buf.includes('{}\n')) {
            sock.end();
            resolve();
          }
        });
        sock.once('connect', () => sock.write(`${JSON.stringify({ token })}\n`));
      });
    await connect(clientA.token);
    await connect(clientB.token);
    await new Promise((r) => setTimeout(r, 20));
    const principals = captured.events
      .filter((e) => e.type === 'external.connection.connected')
      .map((e) => e.payload.principal);
    expect(principals).toContain(`external:${clientA.clientId}`);
    expect(principals).toContain(`external:${clientB.clientId}`);
    expect(new Set(principals).size).toBe(2);
  });

  it('a forged client field does not change the token-bound identity', async () => {
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(server.socketPath);
      let buf = '';
      sock.once('error', reject);
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('{}\n')) {
          sock.end();
          resolve();
        }
      });
      sock.once('connect', () =>
        sock.write(`${JSON.stringify({ token: clientA.token, client: 'totally-other-name' })}\n`),
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    const connected = captured.events.find((e) => e.type === 'external.connection.connected');
    expect(connected?.payload.principal).toBe(`external:${clientA.clientId}`);
    expect(connected?.payload.name).toBe('claude-desktop');
    expect(connected?.payload.clientId).toBe(clientA.clientId);
  });

  it('rejects a wrong/unknown token and audits auth_failed', async () => {
    const { raw } = await sendOne(
      server.socketPath,
      { token: 'wrong-token' },
      { id: '1', request: {} },
    );
    expect(raw).toContain('authentication failed');
    expect(captured.events.some((e) => e.type === 'external.connection.auth_failed')).toBe(true);
  });

  it('refuses connections when the switch is off', async () => {
    captured.isEnabled = () => false;
    try {
      await new Promise<void>((resolve) => {
        const sock = createConnection(server.socketPath);
        sock.once('connect', () => {
          try {
            sock.write(`${JSON.stringify({ token: clientA.token })}\n`);
          } catch {
            /* 服务端已断开 */
          }
        });
        sock.once('error', () => resolve());
        sock.once('close', () => resolve());
        setTimeout(resolve, 300);
      });
      expect(captured.events.some((e) => e.type === 'external.connection.rejected_disabled')).toBe(
        true,
      );
    } finally {
      captured.isEnabled = () => true;
    }
  });

  it('revokes a client: drops live connections and rejects reconnects', async () => {
    // 用 clientA 建一条保持打开的活动连接。
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(server.socketPath);
      let buf = '';
      sock.once('error', reject);
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('{}\n')) resolve();
      });
      sock.once('connect', () => sock.write(`${JSON.stringify({ token: clientA.token })}\n`));
    });
    expect(server.describeConnections().length).toBeGreaterThan(0);
    await server.revokeClient(clientA.clientId);
    expect(server.describeConnections().length).toBe(0);
    expect(captured.events.some((e) => e.type === 'external.client.revoked')).toBe(true);
    // 被吊销 token 再连被拒。
    const { raw } = await sendOne(
      server.socketPath,
      { token: clientA.token },
      { id: '2', request: {} },
    );
    expect(raw).toContain('authentication failed');
    // clientB 不受影响：再开一条保持打开的连接。
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(server.socketPath);
      let buf = '';
      sock.once('error', reject);
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('{}\n')) resolve();
      });
      sock.once('connect', () => sock.write(`${JSON.stringify({ token: clientB.token })}\n`));
    });
    expect(server.describeConnections().length).toBe(1);
  });

  it('enforces the tool allowlist server-side and audits tool_denied', async () => {
    for (const [name, args] of [
      ['browser.request_human', {}],
      ['browser.skills.play', { skillId: 's1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { raw } = await sendOne(
        server.socketPath,
        { token: clientA.token },
        { id: 'd', request: { requestId: 'd', name, args } },
      );
      expect(raw).toContain('工具未对外开放');
    }
    expect(
      captured.events
        .filter((e) => e.type === 'external.request.tool_denied')
        .map((e) => e.payload.tool),
    ).toEqual(['browser.request_human', 'browser.skills.play']);
    expect(captured.received).toHaveLength(0);
  });

  it('rejects a request frame that fails ToolRequestSchema and audits it', async () => {
    const { raw } = await sendOne(
      server.socketPath,
      { token: clientA.token },
      { id: 'bad', request: { name: 'browser.tabs.list' /* 缺 requestId/args */ } },
    );
    expect(raw).toContain('ToolRequestSchema');
    expect(captured.events.some((e) => e.type === 'external.request.invalid')).toBe(true);
  });

  it('issues prefixed tokens pct_<clientId>_<secret>', async () => {
    expect(clientA.token.startsWith(`pct_${clientA.clientId}_`)).toBe(true);
    expect(clientB.token.startsWith(`pct_${clientB.clientId}_`)).toBe(true);
  });

  it('auth failure destroys the socket and audits at most once per connection', async () => {
    const eventsBefore = captured.events.length;
    await sendOne(server.socketPath, { token: 'pct_other_nope' }, { id: 'x', request: {} });
    const authEvents = captured.events
      .slice(eventsBefore)
      .filter((e) => e.type === 'external.connection.auth_failed');
    expect(authEvents).toHaveLength(1);
  });

  it('admits at most once per socket: two hellos in one chunk produce one connection', async () => {
    const before = server.describeConnections().length;
    await new Promise<void>((resolve) => {
      const sock = createConnection(server.socketPath);
      sock.once('connect', () => {
        sock.write(
          `${JSON.stringify({ token: clientA.token })}\n${JSON.stringify({ token: clientA.token })}\n`,
        );
      });
      setTimeout(resolve, 200);
    });
    expect(server.describeConnections().length - before).toBe(1);
  });

  it('revoking a client always strips its ACL even with no live connection', async () => {
    await server.revokeClient(clientB.clientId);
    expect(captured.revokedPrincipals).toContain(externalPrincipalForClient(clientB.clientId));
  });

  it('registry serializes writes: a revoke survives an interleaved save', async () => {
    // 并发发起 revoke 与一次 create（都会 load-modify-save），串行队列保证吊销不被覆盖丢失。
    const [, afterRevoke] = await Promise.all([
      server.createClient('interleaved'),
      server.revokeClient(clientA.clientId),
    ]);
    expect(afterRevoke?.revokedAt).toBeDefined();
    // 重启注册表后仍为吊销状态（不会复活）。
    const reopened = await server.listClients();
    expect(reopened.find((c) => c.clientId === clientA.clientId)?.revokedAt).toBeDefined();
    expect(reopened.some((c) => c.name === 'interleaved')).toBe(true);
  });
});

describe('External principal Tab ACL', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('an external principal may only operate tabs it opened, not the user tabs', async () => {
    let id = 0;
    const service = new BrowserService({
      pageFactory: {
        create: vi.fn(async () => ({
          setLifecycleListener: () => undefined,
          close: () => undefined,
          navigate: async () => undefined,
          snapshot: async () => ({ url: 'https://example.com/', title: 't', loading: false }),
          screenshot: async () => ({ mimeType: 'image/png' as const, data: '' }),
          observeElements: async () => [],
          elementFingerprint: async () => '',
          applyEffect: async () => undefined,
        })),
      },
      grantVerifier: { verify: vi.fn(async () => ({ grantId: 'g', expiresAt: 1 })) },
      resolver: { resolve: vi.fn(async () => ['93.184.216.34']) },
      now: () => 1_000,
      idFactory: () => `tab-${++id}`,
    });
    dir = await mkdtemp(join(tmpdir(), 'pilion-ext-acl-'));

    const external = externalPrincipalForClient('cli-123');
    const mine = await service.openTab({ principalId: external, url: 'example.com' });
    // 镜像 main.ts openAgentTab：外部标签同时把 local-user 设为 owner，断开后留给用户。
    service.setTabAcl(external, mine.tabId, {
      entries: [
        { principalId: external, role: 'owner' },
        { principalId: 'local-user', role: 'owner' },
      ],
    });
    const userTab = await service.openTab({ principalId: 'local-user', url: 'example.org' });

    // 自己开的标签：可观察。
    await expect(
      service.observe({ principalId: external, tabId: mine.tabId }),
    ).resolves.toBeDefined();
    // 用户的标签：外部 principal 没有 ACL，必须拒绝。
    await expect(
      service.observe({ principalId: external, tabId: userTab.tabId }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BrowserError);
      expect((error as BrowserError).code).toBe('PERMISSION_DENIED');
      return true;
    });
    // 断开时只摘掉外部自己的 ACL entry，用户标签不受影响、外部标签仍留给用户。
    const removed = service.revokePrincipal(external);
    expect(removed).toBe(1);
    await expect(
      service.observe({ principalId: external, tabId: mine.tabId }),
    ).rejects.toBeInstanceOf(BrowserError);
    // 用户对自己的标签依然有 observe 权限。
    await expect(
      service.observe({ principalId: 'local-user', tabId: userTab.tabId }),
    ).resolves.toBeDefined();
  });
});
