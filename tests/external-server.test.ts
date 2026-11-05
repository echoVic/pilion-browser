import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserError, BrowserService } from '../src/main/browser/index.js';
import { ExternalControlServer } from '../src/main/external/server.js';
import { ExternalClientRegistry } from '../src/main/external/client-registry.js';
import { callTool } from '../src/main/external/client.js';
import { printError } from '../src/main/external/cli/output.js';
import type { ExternalConnection, ExternalRuntime } from '../src/main/external/types.js';
import { externalPrincipalForClient } from '../src/main/external/types.js';
import type { Observation, PageObservedElement } from '../src/main/browser/types.js';
import {
  AgentSpaceError,
  externalSpacePrincipal,
  SPACE_MESSAGES,
} from '../src/main/external/space-protocol.js';

const ACK = /^\{[^\n]*\}\n/m;

/** 发 hello 后等待 ack，再发帧；收齐响应就断开，失败帧也保留。 */
async function sendRaw(
  socketPath: string,
  hello: object,
  frames: object[] = [],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    const lines: string[] = [];
    const expected = frames.length + 1;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('等待协议响应超时'));
    }, 2000);
    sock.once('connect', () => sock.write(`${JSON.stringify(hello)}\n`));
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          lines.push(line);
          if (lines.length === 1 && !JSON.parse(line).error) {
            for (const frame of frames) sock.write(`${JSON.stringify(frame)}\n`);
          }
          if (lines.length === expected || JSON.parse(line).error) sock.end();
        }
        nl = buf.indexOf('\n');
      }
    });
    sock.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    sock.once('close', () => {
      clearTimeout(timer);
      resolve(lines);
    });
  });
}

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
      if (!sentRequest && ACK.test(buf)) {
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

  function makeConnection(clientId: string, name: string, spaceId?: string): ExternalConnection {
    const principal = spaceId
      ? externalSpacePrincipal(clientId, spaceId)
      : externalPrincipalForClient(clientId);
    return {
      principal,
      clientId,
      name,
      spaceId,
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
      admit(clientId, name, spaceId) {
        return makeConnection(clientId, name, spaceId);
      },
      spaces: {
        admit: async () => 'ok' as const,
        create: async () => ({ spaceId: 'agent-test' }),
        list: async () => [],
        close: async () => undefined,
        stopClient: async () => undefined,
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
      version: '1.2.3',
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

  describe('Agent Space protocol', () => {
    const spaceId = 'agent-00000000-0000-4000-8000-000000000001';
    const toolFrame = {
      id: 'r1',
      request: { requestId: 'rq1', name: 'browser.tabs.list', args: {} },
    };

    it('hello with valid active space is admitted as sub-principal', async () => {
      const admit = vi.fn(captured.spaces.admit);
      captured.spaces.admit = admit;
      const lines = await sendRaw(server.socketPath, { token: clientA.token, space: spaceId }, [
        toolFrame,
      ]);
      expect(JSON.parse(lines[0]!)).toEqual({ version: '1.2.3' });
      expect(JSON.parse(lines[1]!)).toMatchObject({
        result: { principal: `external:${clientA.clientId}:${spaceId}` },
      });
      expect(admit).toHaveBeenCalledWith(clientA.clientId, spaceId);
    });

    it.each(['unknown', 'foreign'])('hello with %s space returns SPACE_NOT_FOUND', async () => {
      captured.spaces.admit = async () => {
        throw new AgentSpaceError('SPACE_NOT_FOUND');
      };
      const lines = await sendRaw(server.socketPath, { token: clientA.token, space: spaceId });
      expect(JSON.parse(lines[0]!)).toEqual({
        code: 'SPACE_NOT_FOUND',
        error: SPACE_MESSAGES.SPACE_NOT_FOUND,
      });
      expect(captured.received).toHaveLength(0);
    });

    it('hello with ended space returns SPACE_ENDED', async () => {
      captured.spaces.admit = async () => {
        throw new AgentSpaceError('SPACE_ENDED');
      };
      const lines = await sendRaw(server.socketPath, { token: clientA.token, space: spaceId });
      expect(JSON.parse(lines[0]!)).toEqual({
        code: 'SPACE_ENDED',
        error: SPACE_MESSAGES.SPACE_ENDED,
      });
    });

    it('hello with resumed space is admitted and audited without the label', async () => {
      captured.spaces.admit = async () => 'resumed';
      const lines = await sendRaw(server.socketPath, { token: clientA.token, space: spaceId });
      expect(JSON.parse(lines[0]!)).toEqual({ version: '1.2.3' });
      const event = captured.events.find((e) => e.type === 'external.space.resumed');
      expect(event?.payload).toMatchObject({ clientId: clientA.clientId, spaceId });
      expect(event?.payload).not.toHaveProperty('label');
    });

    it('integration-kind client without space: tool frame returns SPACE_REQUIRED', async () => {
      const integration = grab(await server.createClient('集成', 'agent-integration'));
      const lines = await sendRaw(server.socketPath, { token: integration.token }, [toolFrame]);
      expect(JSON.parse(lines[1]!)).toEqual({
        id: 'r1',
        code: 'SPACE_REQUIRED',
        error: SPACE_MESSAGES.SPACE_REQUIRED,
      });
      expect(captured.received).toHaveLength(0);
    });

    it('non-integration client without space passes tool frames normally', async () => {
      const lines = await sendRaw(server.socketPath, { token: clientA.token }, [toolFrame]);
      expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'r1', result: { ok: true } });
    });

    it('control frame space.create works for integration client without space and never runs a tool', async () => {
      const integration = grab(await server.createClient('集成', 'agent-integration'));
      const create = vi.fn(async () => ({ spaceId }));
      captured.spaces.create = create;
      const lines = await sendRaw(server.socketPath, { token: integration.token }, [
        { id: 'c1', control: { op: 'space.create', label: '比价' } },
      ]);
      expect(JSON.parse(lines[1]!)).toEqual({ id: 'c1', result: { spaceId } });
      expect(create).toHaveBeenCalledWith(integration.clientId, '比价');
      expect(captured.received).toHaveLength(0);
    });

    it('control frame space.list returns summaries scoped to the authenticated client', async () => {
      const list = vi.fn(async () => [{ spaceId, label: '比价', state: 'active' as const }]);
      captured.spaces.list = list;
      const lines = await sendRaw(server.socketPath, { token: clientA.token }, [
        { id: 'c2', control: { op: 'space.list' } },
      ]);
      expect(JSON.parse(lines[1]!)).toEqual({
        id: 'c2',
        result: { spaces: [{ spaceId, label: '比价', state: 'active' }] },
      });
      expect(list).toHaveBeenCalledWith(clientA.clientId);
    });

    it('control frame space.close responds ok even on a space connection', async () => {
      const close = vi.fn(async () => undefined);
      captured.spaces.close = close;
      const lines = await sendRaw(server.socketPath, { token: clientA.token, space: spaceId }, [
        { id: 'c3', control: { op: 'space.close', spaceId } },
      ]);
      expect(JSON.parse(lines[1]!)).toEqual({ id: 'c3', result: { ok: true } });
      expect(close).toHaveBeenCalledWith(clientA.clientId, spaceId);
    });

    it('control errors carry the Space error code', async () => {
      captured.spaces.create = async () => {
        throw new AgentSpaceError('SPACE_LIMIT');
      };
      const lines = await sendRaw(server.socketPath, { token: clientA.token }, [
        { id: 'limit', control: { op: 'space.create', label: '比价' } },
      ]);
      expect(JSON.parse(lines[1]!)).toEqual({
        id: 'limit',
        code: 'SPACE_LIMIT',
        error: SPACE_MESSAGES.SPACE_LIMIT,
      });
    });

    it.each([
      { op: 'space.nuke' },
      { op: 'space.list', clientId: 'foreign' },
      { op: 'space.create', label: '' },
    ])('malformed control frame is refused: %j', async (control) => {
      const lines = await sendRaw(server.socketPath, { token: clientA.token }, [
        { id: 'bad', control },
      ]);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ error: expect.any(String) });
      expect(captured.received).toHaveLength(0);
    });

    it.each(['revokeClient', 'deleteClient'] as const)(
      '%s drops all client sub-principals and stops its spaces',
      async (operation) => {
        const sockets = [];
        for (const [token, space] of [
          [clientA.token, undefined],
          [clientA.token, spaceId],
          [clientB.token, 'agent-00000000-0000-4000-8000-000000000002'],
        ] as const) {
          const sock = createConnection(server.socketPath);
          sockets.push(sock);
          await new Promise<void>((resolve, reject) => {
            sock.once('error', reject);
            sock.once('connect', () => sock.write(`${JSON.stringify({ token, space })}\n`));
            sock.once('data', () => resolve());
          });
        }
        const stopClient = vi.fn(async () => undefined);
        captured.spaces.stopClient = stopClient;
        await server[operation](clientA.clientId);
        expect(server.describeConnections().map((c) => c.clientId)).toEqual([clientB.clientId]);
        expect(stopClient).toHaveBeenCalledWith(clientA.clientId);
        for (const sock of sockets) sock.destroy();
      },
    );

    it('control frames share the four-inflight limit with tools', async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      captured.spaces.list = async () => {
        await pending;
        return [];
      };
      const sock = createConnection(server.socketPath);
      try {
        await new Promise<void>((resolve, reject) => {
          sock.once('error', reject);
          sock.once('connect', () => sock.write(`${JSON.stringify({ token: clientA.token })}\n`));
          sock.once('data', () => {
            for (let i = 0; i < 5; i += 1)
              sock.write(`${JSON.stringify({ id: `c${i}`, control: { op: 'space.list' } })}\n`);
          });
          sock.once('close', () => resolve());
        });
        expect(captured.events.some((e) => e.type === 'external.request.too_many_inflight')).toBe(
          true,
        );
      } finally {
        release();
        sock.destroy();
      }
    });
  });

  it('acks a successful hello with the app version', async () => {
    const ack = await new Promise<string>((resolve, reject) => {
      const sock = createConnection(server.socketPath);
      let buf = '';
      sock.once('connect', () => sock.write(`${JSON.stringify({ token: clientA.token })}\n`));
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          sock.end();
          resolve(buf.slice(0, nl));
        }
      });
      sock.once('error', reject);
    });
    expect(JSON.parse(ack)).toEqual({ version: '1.2.3' });
  });

  it('returns every observed ref through the real client with large mixed native values', async () => {
    const values = [
      'a'.repeat(100_000),
      '界😀'.repeat(33_334).slice(0, 100_000),
      '"\\\n\u0000'.repeat(25_000),
    ];
    const rows: PageObservedElement[] = Array.from({ length: 200 }, (_, index) => ({
      elementKey: `node-${index}`,
      frameId: 'main',
      localFingerprint: `fingerprint-${index}`,
      role: 'textbox',
      name: `Draft ${index}`,
      disabled: false,
      tagName: 'textarea',
      value: values[index % values.length],
    }));
    const service = new BrowserService({
      pageFactory: {
        create: async () => ({
          setLifecycleListener: () => undefined,
          close: () => undefined,
          navigate: async () => undefined,
          snapshot: async () => ({ url: 'https://example.com/', title: 'Form', loading: false }),
          screenshot: async () => ({ mimeType: 'image/png' as const, data: '' }),
          observeElements: async () => rows,
          elementFingerprint: async (_frameId, elementKey) =>
            rows.find((row) => row.elementKey === elementKey)?.localFingerprint,
          applyEffect: async () => undefined,
        }),
      },
      grantVerifier: { verify: async () => ({ grantId: 'unused', expiresAt: 0 }) },
      resolver: { resolve: async () => ['93.184.216.34'] },
    });
    const principal = externalPrincipalForClient(clientA.clientId);
    const { tabId } = await service.openTab({ principalId: principal, url: 'example.com' });
    let response: Observation | undefined;
    captured.admit = (clientId, name) => ({
      ...makeConnection(clientId, name),
      run: async (request) => {
        expect(request.name).toBe('browser.observe');
        response = await service.observe({
          principalId: externalPrincipalForClient(clientId),
          tabId: request.args.tabId as string,
        });
        return response;
      },
    });

    const result = (await callTool(
      { socketPath: server.socketPath, token: clientA.token },
      { name: 'browser.observe', args: { tabId } },
    )) as Observation;

    expect(result.elements).toHaveLength(200);
    expect(result.elements.map((row) => row.ref)).toEqual(response!.elements.map((row) => row.ref));
    expect(new Set(result.elements.map((row) => row.ref.id)).size).toBe(200);
    expect(
      result.elements.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value), 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(256 * 1024);
    // Leave room for transport id/envelope, rather than raising its 1 MiB limit.
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1024 * 1024 - 1024);
    for (const [index, row] of result.elements.entries()) {
      expect(row.name).toBe(`Draft ${index}`);
      expect(row.valueTruncated).toBe(true);
      expect(values[index % values.length].startsWith(row.value!)).toBe(true);
    }
  });

  it('preserves BrowserError fields through socket, typed client Error and CLI JSON', async () => {
    captured.admit = (clientId, name) => ({
      ...makeConnection(clientId, name),
      run: async () => {
        throw Object.assign(
          new BrowserError('STALE_ELEMENT', 'observe again', true, { token: 'must-not-leak' }),
          { outcome: 'unknown' },
        );
      },
    });
    const { raw } = await sendOne(
      server.socketPath,
      { token: clientA.token },
      { id: 'e1', request: { requestId: 'r1', name: 'browser.click', args: {} } },
    );
    const frames = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toEqual({
      id: 'e1',
      error: 'observe again',
      code: 'STALE_ELEMENT',
      retryable: true,
      outcome: 'unknown',
    });
    const error = await callTool(
      { socketPath: server.socketPath, token: clientA.token },
      { name: 'browser.click', args: {} },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const stdout: string[] = [];
    printError(
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      true,
      error as Error,
    );
    expect(stdout).toEqual([
      '{"error":"observe again","code":"STALE_ELEMENT","retryable":true,"outcome":"unknown"}',
    ]);
  });

  it('preserves BrowserError diagnostics on admission failures before dispatch', async () => {
    captured.admit = () => {
      throw new BrowserError('PERMISSION_DENIED', 'admission denied');
    };
    const { raw } = await sendOne(
      server.socketPath,
      { token: clientA.token },
      { id: 'e2', request: { requestId: 'r2', name: 'browser.click', args: {} } },
    );
    expect(JSON.parse(raw.trim())).toEqual({
      error: 'admission denied',
      code: 'PERMISSION_DENIED',
      retryable: false,
    });
    expect(captured.received).toEqual([]);
  });

  it('keeps plain runtime errors message-only and discards invalid diagnostics', async () => {
    captured.admit = (clientId, name) => ({
      ...makeConnection(clientId, name),
      run: async () => {
        throw Object.assign(new Error('runtime failed'), {
          code: 'X'.repeat(65),
          retryable: 'true',
          outcome: 'safe',
          details: { secret: 'hidden' },
        });
      },
    });
    const { raw } = await sendOne(
      server.socketPath,
      { token: clientA.token },
      { id: 'e3', request: { requestId: 'r3', name: 'browser.click', args: {} } },
    );
    expect(JSON.parse(raw.trim().split('\n').at(-1)!)).toEqual({
      id: 'e3',
      error: 'runtime failed',
    });
  });

  it('reports unknown when a client is revoked while its dispatched request is running', async () => {
    captured.admit = (clientId, name) => ({
      ...makeConnection(clientId, name),
      run: async (request) => {
        captured.received.push(request);
        await server.revokeClient(clientId);
        throw new Error('connection revoked');
      },
    });
    const error = await callTool(
      { socketPath: server.socketPath, token: clientA.token },
      { name: 'browser.click', args: {} },
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: 'Pilion external connection closed without a response',
      code: 'PILION_EXTERNAL_CONNECTION_CLOSED',
      outcome: 'unknown',
    });
    expect(error).not.toHaveProperty('retryable');
    expect(captured.received).toHaveLength(1);
    expect(server.describeConnections()).toEqual([]);
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

  it('records an optional client kind and returns it in listings', async () => {
    const created = await server.createClient('本机 Agent（CLI）', 'agent-integration');
    expect(created.client.kind).toBe('agent-integration');
    const listed = await server.listClients();
    expect(listed.find((c) => c.clientId === created.client.clientId)?.kind).toBe(
      'agent-integration',
    );
    expect(listed.find((c) => c.clientId === clientA.clientId)).not.toHaveProperty('kind');
    const raw = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8')) as {
      clients: Array<{ clientId: string; kind?: string }>;
    };
    expect(raw.clients.find((c) => c.clientId === created.client.clientId)?.kind).toBe(
      'agent-integration',
    );
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
          if (ACK.test(buf)) {
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
        if (ACK.test(buf)) {
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
        if (ACK.test(buf)) resolve();
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
        if (ACK.test(buf)) resolve();
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

  it('stop cancels and drains a pending grant before offline token revocation', async () => {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const grant = server
      .setClientPermissionMode(clientA.clientId, 'full', async () => {
        reached();
        await gate;
      })
      .catch(() => 'cancelled');
    await started;
    const stopping = server.stop();
    const revoke = new ExternalClientRegistry(dir).revoke(clientA.clientId);
    release();
    expect(await grant).toBe('cancelled');
    await Promise.all([stopping, revoke]);
    const fresh = new ExternalClientRegistry(dir);
    expect(await fresh.verify(clientA.token)).toBeUndefined();
    expect((await fresh.list()).find((c) => c.clientId === clientA.clientId)?.permissionMode).toBe(
      'ask',
    );
  });

  it('a socket that closes before handshake finishes does not break later admits', async () => {
    // 连上来立刻断开（verify 在途），名额要被正确回收；之后正常连接仍能 admit。
    await new Promise<void>((resolve) => {
      const sock = createConnection(server.socketPath);
      sock.once('connect', () => {
        sock.write(`${JSON.stringify({ token: clientA.token })}\n`);
        sock.destroy();
      });
      sock.once('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));
    await sendOne(
      server.socketPath,
      { token: clientB.token },
      { id: 'ok', request: { requestId: 'ok', name: 'browser.tabs.list', args: {} } },
    );
    expect(captured.events.some((e) => e.type === 'external.connection.connected')).toBe(true);
  });

  it('an unknown / malformed token still runs a dummy scrypt and rejects', async () => {
    const { raw } = await sendOne(
      server.socketPath,
      { token: 'pct_deadbeef_deadbeef' },
      { id: 'x', request: {} },
    );
    expect(raw).toContain('authentication failed');
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
