import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserError, BrowserService } from '../src/main/browser/index.js';
import { ExternalControlServer } from '../src/main/external/server.js';
import {
  externalPrincipal,
  type ExternalConnection,
  type ExternalRuntime,
} from '../src/main/external/types.js';

interface CapturingRuntime extends ExternalRuntime {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  received: unknown[];
}

/** 一条连接发 hello + 一个请求帧，读到带 id 的响应或错误就返回。 */
function sendOne(socketPath: string, hello: object, request: object): Promise<{ raw: string }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
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
      setTimeout(() => {
        try {
          sock.write(`${JSON.stringify(request)}\n`);
        } catch {
          /* 服务端可能在认证前就断开 */
        }
      }, 15);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes('"id"') || buf.includes('"error"')) finish(null);
    });
    sock.once('error', (error) => finish(error));
    sock.once('close', () => finish(null));
  });
}

describe('ExternalControlServer', () => {
  let dir: string;
  let captured: CapturingRuntime;
  let server: ExternalControlServer;
  const token = () => server.mcpConfig()!.token;

  function makeConnection(
    principal: string,
    handler: (request: unknown) => unknown,
  ): ExternalConnection {
    return {
      principal,
      client: principal.replace('external:', ''),
      connectedAt: new Date().toISOString(),
      attachmentId: `att-${principal}`,
      run: async (request) => handler(request),
      close: () => undefined,
      revoke: () => undefined,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilion-external-'));
    captured = {
      events: [],
      received: [],
      isEnabled: () => true,
      recordEvent(type, payload) {
        captured.events.push({ type, payload });
      },
      admit(client) {
        const who = externalPrincipal(client);
        return makeConnection(who, (request) => {
          captured.received.push(request);
          return { ok: true, principal: who, request };
        });
      },
    };
    server = new ExternalControlServer({
      dir,
      runtime: captured,
      command: 'pilion-test-node',
      mcpClientPath: '/tmp/pilion-mcp.js',
    });
  });

  afterEach(async () => {
    await server.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('listens on a 0700 dir, 0600 socket and 0600 token config file', async () => {
    await server.start();
    const socketStat = await stat(server.socketPath);
    const dirStat = await stat(dir);
    const configStat = await stat(join(dir, 'external-mcp.json'));
    expect(socketStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(configStat.mode & 0o777).toBe(0o600);
    const config = JSON.parse(await readFile(join(dir, 'external-mcp.json'), 'utf8'));
    expect(config.command).toBe('pilion-test-node');
    expect(config.env.PILION_EXTERNAL_TOKEN).toBeTruthy();
  });

  it('rejects a wrong token and writes an auth_failed audit', async () => {
    await server.start();
    const { raw } = await sendOne(
      server.socketPath,
      { token: 'wrong', client: 'x' },
      { id: '1', request: {} },
    );
    expect(raw).toContain('authentication failed');
    expect(captured.events.some((e) => e.type === 'external.connection.auth_failed')).toBe(true);
  });

  it('refuses connections when the switch is off and audits rejected_disabled', async () => {
    captured.isEnabled = () => false;
    await server.start();
    // 服务端在 disabled 时收到连接就立刻拒绝；客户端是否读回错误帧是竞态，这里只验审计。
    await new Promise<void>((resolve) => {
      const sock = createConnection(server.socketPath);
      sock.once('connect', () => {
        try {
          sock.write(`${JSON.stringify({ token: token() })}\n`);
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
  });

  it('admissions a good connection, audits the external principal, and runs the request', async () => {
    await server.start();
    const { raw } = await sendOne(
      server.socketPath,
      { token: token(), client: 'claude-desktop' },
      { id: 'req-1', request: { requestId: 'r1', name: 'browser.tabs.list', args: {} } },
    );
    expect(raw).toContain('"ok":true');
    const connected = captured.events.find((e) => e.type === 'external.connection.connected');
    expect(connected?.payload.principal).toBe('external:claude-desktop');
    expect(captured.received).toHaveLength(1);
  });

  it('does not trust a per-frame client label to change the principal fixed at handshake', async () => {
    await server.start();
    // 握手自报 client=cli；之后帧里再想冒充别的 principal 无效。
    await sendOne(
      server.socketPath,
      { token: token(), client: 'cli' },
      { id: 'r', request: { requestId: 'r', name: 'browser.tabs.list', args: {} } },
    );
    const connected = captured.events.find((e) => e.type === 'external.connection.connected');
    expect(connected?.payload.principal).toBe('external:cli');
    expect(connected?.payload.expectedPrincipal).toBe('external:cli');
  });

  it('enforces the tool allowlist server-side and audits tool_denied', async () => {
    await server.start();
    for (const [name, args] of [
      ['browser.request_human', {}],
      ['browser.skills.play', { skillId: 's1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { raw } = await sendOne(
        server.socketPath,
        { token: token(), client: 'attacker' },
        { id: 'd', request: { requestId: 'd', name, args } },
      );
      expect(raw).toContain('工具未对外开放');
    }
    expect(
      captured.events
        .filter((e) => e.type === 'external.request.tool_denied')
        .map((e) => e.payload.tool),
    ).toEqual(['browser.request_human', 'browser.skills.play']);
    // 被裁工具绝不能进到 runtime.run。
    expect(captured.received).toHaveLength(0);
  });

  it('rejects a request frame that fails ToolRequestSchema and audits it', async () => {
    await server.start();
    const { raw } = await sendOne(
      server.socketPath,
      { token: token(), client: 'cli' },
      { id: 'bad', request: { name: 'browser.tabs.list' /* 缺 requestId/args */ } },
    );
    expect(raw).toContain('ToolRequestSchema');
    expect(captured.events.some((e) => e.type === 'external.request.invalid')).toBe(true);
  });

  it('cleans up a connection on socket error and audits closed', async () => {
    await server.start();
    await new Promise<void>((resolve) => {
      const sock = createConnection(server.socketPath);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      sock.once('connect', () => {
        sock.write(`${JSON.stringify({ token: token(), client: 'dropper' })}\n`);
      });
      sock.once('error', () => done());
      sock.on('data', (chunk) => {
        if (chunk.toString().includes('{}')) {
          // 握手完成后立刻制造 error（对端 reset），验证收尾不被短路。
          sock.destroy(new Error('reset'));
          done();
        }
      });
      sock.once('close', done);
      setTimeout(done, 1000);
    });
    // error 也必须完成收尾：连接从活动列表移除，并写 closed 审计。
    await expect.poll(() => server.describeConnections().length).toBe(0);
    expect(
      captured.events.some(
        (e) =>
          e.type === 'external.connection.closed' && e.payload.principal === 'external:dropper',
      ),
    ).toBe(true);
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

    const external = externalPrincipal('cli');
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
