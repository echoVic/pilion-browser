import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProcessManager,
  AgentTransport,
  AgentTrustStore,
  killProcessTree,
  type ChildProcessLike,
  type SpawnAgent,
} from '../src/main/agents/index';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT } from '../src/shared/contracts';

type RpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

class FakeStdin extends Writable {
  readonly frames: RpcMessage[] = [];
  onFrame?: (message: RpcMessage) => void;

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const message = JSON.parse(chunk.toString('utf8')) as RpcMessage;
      this.frames.push(message);
      this.onFrame?.(message);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new FakeStdin();
  killed: NodeJS.Signals[] = [];

  constructor(readonly pid: number | undefined = undefined) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fixture(
  options: {
    autoInitialize?: boolean;
    protocolVersion?: number;
    limits?: Record<string, number>;
    authRequired?: boolean;
    authHangs?: boolean;
    authMethodId?: string;
    sessionResponse?: Record<string, unknown>;
    agentCapabilities?: Record<string, unknown>;
    initializeMeta?: Record<string, unknown>;
    resumeSessionId?: string;
    /** session/resume and session/load answer with this error instead of succeeding. */
    resumeError?: { code: number; message: string };
    baseEnv?: NodeJS.ProcessEnv;
    requestPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  } = {},
) {
  const child = new FakeChild();
  const trust = new AgentTrustStore();
  const config = trust.approve({ id: 'test-agent', command: '/trusted/agent', args: ['--acp'] });
  let spawnOptions: Parameters<SpawnAgent>[2] | undefined;
  let authenticated = false;
  const spawn: SpawnAgent = (_command, _args, received) => {
    spawnOptions = received;
    if (options.autoInitialize !== false) {
      child.stdin.onFrame = (message) => {
        if (message.method === 'initialize') {
          reply(child, message.id, {
            protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
            agentCapabilities: options.agentCapabilities ?? {
              promptCapabilities: { image: true },
            },
            agentInfo: { name: 'fixture-agent', title: 'Fixture Agent', version: '1.0.0' },
            ...(options.initializeMeta ? { _meta: options.initializeMeta } : {}),
            ...(options.authRequired
              ? { authMethods: [{ id: 'browser-login', name: 'Browser login' }] }
              : {}),
          });
        }
        if (message.method === 'session/new') {
          if (options.authRequired && !authenticated) {
            reject(child, message.id, -32000, 'Authentication required');
          } else {
            reply(child, message.id, { sessionId: 'fixture-session', ...options.sessionResponse });
          }
        }
        if (message.method === 'session/resume' || message.method === 'session/load') {
          if (options.resumeError)
            reject(child, message.id, options.resumeError.code, options.resumeError.message);
          else reply(child, message.id, {});
        }
        if (message.method === 'authenticate' && !options.authHangs) {
          authenticated = true;
          reply(child, message.id, {});
        }
      };
    }
    return child;
  };
  const transport = new AgentTransport(trust, config, {
    spawn,
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    killTree: (process, signal) => {
      process.kill(signal);
    },
    limits: {
      handshakeTimeoutMs: 100,
      requestTimeoutMs: 100,
      drainTimeoutMs: 5,
      terminateTimeoutMs: 5,
      ...options.limits,
    },
    session: {
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'pilion-browser',
          command: '/trusted/mcp',
          args: ['--stdio'],
          env: [],
        },
      ],
      authMethodId: options.authMethodId,
      resumeSessionId: options.resumeSessionId,
      requestPermission: options.requestPermission,
    },
  });
  return { child, transport, getSpawnOptions: () => spawnOptions };
}

function reply(child: FakeChild, id: RpcMessage['id'], result: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function reject(child: FakeChild, id: RpcMessage['id'], code: number, message: string): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function sessionUpdate(child: FakeChild, update: Record<string, unknown>): void {
  child.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'fixture-session', update },
    })}\n`,
  );
}

async function close(child: FakeChild, transport: AgentTransport): Promise<void> {
  const stopping = transport.stop();
  child.emit('exit', 0, null);
  await stopping;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AgentTransportError', code });
}

describe('AgentTransport official ACP client', () => {
  it('uses negotiated grouped model options, applies returned state, and preserves state on rejection', async () => {
    const option = {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'fast',
      options: [
        {
          group: 'provider',
          name: 'Provider',
          options: [
            { value: 'fast', name: 'Fast' },
            { value: 'deep', name: 'Deep' },
          ],
        },
      ],
    };
    const { child, transport } = fixture({ sessionResponse: { configOptions: [option] } });
    await transport.start();
    expect(transport.models).toEqual([
      { value: 'fast', name: 'Fast' },
      { value: 'deep', name: 'Deep' },
    ]);
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/set_config_option')
        reply(child, message.id, {
          configOptions: [{ ...option, currentValue: message.params?.value }],
        });
    };
    await transport.setModel('deep');
    expect(transport.currentModel).toBe('deep');
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/set_config_option')
        reject(child, message.id, -32602, 'Rejected model');
    };
    await expect(transport.setModel('fast')).rejects.toThrow('Rejected model');
    expect(transport.currentModel).toBe('deep');
    await expect(transport.setModel('invented')).rejects.toThrow('不支持');
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'config_option_update', configOptions: [{ ...option, currentValue: 'fast' }] } } })}\n`,
    );
    await vi.waitFor(() => expect(transport.currentModel).toBe('fast'));
    await close(child, transport);
  });
  it('supports legacy model discovery and sends the legacy setter only for advertised models', async () => {
    const { child, transport } = fixture({
      sessionResponse: {
        models: {
          currentModelId: 'legacy-a',
          availableModels: [
            { modelId: 'legacy-a', name: 'A' },
            { modelId: 'legacy-b', name: 'B' },
          ],
        },
      },
    });
    await transport.start();
    expect(transport.currentModel).toBe('legacy-a');
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/set_model') reply(child, message.id, {});
    };
    await transport.setModel('legacy-b');
    expect(child.stdin.frames.at(-1)).toMatchObject({
      method: 'session/set_model',
      params: { modelId: 'legacy-b' },
    });
    expect(transport.currentModel).toBe('legacy-b');
    await close(child, transport);
  });
  it('selects exact full-access modes ahead of generic agent modes and restores confirmation mode', async () => {
    const { child, transport } = fixture({
      sessionResponse: {
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'agent', name: 'Agent' },
            { id: 'default', name: 'Default' },
            { id: 'bypassPermissions', name: 'Full access' },
          ],
        },
      },
    });
    await transport.start();
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/set_mode') reply(child, message.id, {});
    };
    await transport.setPermissionMode('full');
    expect(transport.currentMode).toBe('bypassPermissions');
    await transport.setPermissionMode('ask');
    expect(transport.currentMode).toBe('default');
    await close(child, transport);
  });
  it('uses a shell-free process and establishes a standard ACP session', async () => {
    const { child, transport, getSpawnOptions } = fixture();
    await transport.start();

    expect(transport.state).toBe('ready');
    expect(transport.sessionId).toBe('fixture-session');
    expect(getSpawnOptions()).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new']);
    expect(child.stdin.frames[0]?.params).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(child.stdin.frames[1]?.params).toMatchObject({
      cwd: '/workspace',
      mcpServers: [expect.objectContaining({ name: 'pilion-browser', command: '/trusted/mcp' })],
    });
    expect(transport.capabilities).toMatchObject({
      protocol: PROTOCOL_VERSION,
      client: {
        session: 'native',
        browserMcp: 'native',
        fs: 'unsupported',
        terminal: 'unsupported',
      },
      agent: { promptCapabilities: { image: true } },
      agentInfo: { name: 'fixture-agent' },
    });

    await close(child, transport);
  });

  it('restores an existing ACP session when resume is negotiated', async () => {
    const { child, transport } = fixture({
      resumeSessionId: 'persisted-session',
      agentCapabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {} },
      },
    });
    await transport.start();
    expect(transport.sessionId).toBe('persisted-session');
    expect(child.stdin.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/resume',
    ]);
    await close(child, transport);
  });

  it('uses the negotiated goal control method and publishes goal state', async () => {
    const { child, transport } = fixture({
      initializeMeta: {
        goal: {
          version: 1,
          controlMethod: '_session/goal',
          actions: ['set', 'clear'],
        },
      },
    });
    await transport.start();
    const goals: unknown[] = [];
    transport.on('goal', (goal) => goals.push(goal));
    child.stdin.onFrame = (message) => {
      if (message.method !== '_session/goal') return;
      const goal =
        message.params?.action === 'set'
          ? {
              objective: message.params.objective,
              status: 'active',
              controlMethod: '_session/goal',
            }
          : null;
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'fixture-session',
            update: { sessionUpdate: 'session_info_update', _meta: { goal } },
          },
        })}\n`,
      );
      reply(child, message.id, {});
    };
    expect(transport.supportsPersistentGoals).toBe(true);
    await transport.setGoal('Ship the browser task');
    expect(transport.goal).toMatchObject({
      objective: 'Ship the browser task',
      status: 'active',
    });
    await transport.clearGoal();
    expect(goals).toHaveLength(2);
    expect(goals.at(-1)).toBeNull();
    expect(transport.traceSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'client_to_agent',
          method: '_session/goal',
          kind: 'request',
        }),
        expect.objectContaining({
          direction: 'agent_to_client',
          method: 'session/update',
          update: 'session_info_update',
        }),
      ]),
    );
    expect(JSON.stringify(transport.traceSnapshot)).not.toContain('Ship the browser task');
    await close(child, transport);
  });

  it('uses session/prompt, forwards session/update, and sends session/cancel', async () => {
    const { child, transport } = fixture();
    await transport.start();
    const updates: string[] = [];
    transport.on('sessionUpdate', (notification) => {
      if (
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
      ) {
        updates.push(notification.update.content.text);
      }
    });
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/prompt') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'fixture-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'done' },
              },
            },
          })}\n`,
        );
        reply(child, message.id, { stopReason: 'end_turn' });
      }
    };

    await expect(transport.prompt([{ type: 'text', text: 'hello' }])).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(updates).toEqual(['done']);
    await transport.cancel();
    expect(child.stdin.frames.at(-1)).toMatchObject({
      method: 'session/cancel',
      params: { sessionId: 'fixture-session' },
    });

    await close(child, transport);
  });

  it('routes standard ACP permission requests through the client handler', async () => {
    const requestPermission = vi.fn(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow-once' },
    }));
    const { child, transport } = fixture({ requestPermission });
    await transport.start();
    child.stdin.onFrame = (message) => {
      if (message.method !== 'session/prompt') return;
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 91,
          method: 'session/request_permission',
          params: {
            sessionId: 'fixture-session',
            toolCall: { toolCallId: 'tool-1', title: 'Run tool', rawInput: {} },
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
          },
        })}\n`,
      );
    };
    const response = new Promise<RpcMessage>((resolveResponse) => {
      const previous = child.stdin.onFrame;
      child.stdin.onFrame = (message) => {
        previous?.(message);
        if (message.id === 91 && message.result) {
          resolveResponse(message);
          const prompt = child.stdin.frames.find((frame) => frame.method === 'session/prompt');
          reply(child, prompt?.id, { stopReason: 'end_turn' });
        }
      };
    });

    const prompt = transport.prompt([{ type: 'text', text: 'permission' }]);
    await expect(response).resolves.toMatchObject({
      id: 91,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    expect(requestPermission).toHaveBeenCalledOnce();

    await close(child, transport);
  });

  it('authenticates and retries session/new when the Agent requires login', async () => {
    const { child, transport } = fixture({ authRequired: true });
    await transport.start();

    expect(child.stdin.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new',
    ]);
    expect(child.stdin.frames[2]?.params).toEqual({ methodId: 'browser-login' });
    expect(transport.sessionId).toBe('fixture-session');

    await close(child, transport);
  });

  it('rejects a protocol version the client does not support', async () => {
    const { transport } = fixture({ protocolVersion: PROTOCOL_VERSION + 1 });
    await expectCode(transport.start(), 'HANDSHAKE_FAILED');
    expect(transport.state).toBe('failed');
  });

  it('rejects malformed and oversized ACP frames', async () => {
    const malformed = fixture({ autoInitialize: false });
    const malformedStart = malformed.transport.start();
    // Non-JSON is only tolerated before the first frame, so the bad line follows a valid one.
    malformed.child.stdout.write('{"jsonrpc":"2.0","method":"_fixture/hello"}\n{not-json}\n');
    await expectCode(malformedStart, 'PROTOCOL_INVALID_FRAME');
    expect(malformed.transport.state).toBe('failed');

    const notRpc = fixture({ autoInitialize: false });
    const notRpcStart = notRpc.transport.start();
    notRpc.child.stdout.write('{"hello":"world"}\n');
    await expectCode(notRpcStart, 'PROTOCOL_INVALID_FRAME');

    const oversized = fixture({ autoInitialize: false, limits: { maxFrameBytes: 128 } });
    const oversizedStart = oversized.transport.start();
    oversized.child.stdout.write('x'.repeat(129));
    await expectCode(oversizedStart, 'PROTOCOL_FRAME_TOO_LARGE');
    expect(oversized.transport.state).toBe('failed');
  });

  it('sends a prompt that fills every image slot with a maximum-size image', async () => {
    const { child, transport } = fixture();
    await transport.start();
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/prompt') reply(child, message.id, { stopReason: 'end_turn' });
    };
    const data = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3));
    const images = Array.from({ length: MAX_IMAGES_PER_PROMPT }, (_, index) => ({
      type: 'image' as const,
      data,
      mimeType: 'image/png',
      uri: `shot-${index}.png`,
    }));
    await expect(
      transport.prompt([...images, { type: 'text', text: 'x'.repeat(100_000) }]),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(transport.state).toBe('ready');
  });

  it('still fails the connection on an outbound frame over its own cap', async () => {
    const { transport } = fixture({ limits: { maxOutboundFrameBytes: 4096 } });
    await transport.start();
    await expect(
      transport.prompt([{ type: 'text', text: 'x'.repeat(8192) }]),
    ).rejects.toBeInstanceOf(Error);
    expect(transport.state).toBe('failed');
  });

  it('rejects an in-flight prompt when the Agent exits', async () => {
    const { child, transport } = fixture();
    await transport.start();
    child.stdin.onFrame = () => {
      /* keep the prompt in flight */
    };
    const prompt = transport.prompt([{ type: 'text', text: 'slow' }]);
    child.emit('exit', 9, null);
    await expect(prompt).rejects.toBeInstanceOf(Error);
    expect(transport.state).toBe('closed');
  });

  it.each([
    [9, null, /exit code 9/],
    [null, 'SIGKILL' as const, /SIGKILL/],
  ])('names how the Agent process ended (%s/%s)', async (code, signal, expected) => {
    const { child, transport } = fixture();
    await transport.start();
    child.stdin.onFrame = () => {
      /* keep the prompt in flight */
    };
    const prompt = transport.prompt([{ type: 'text', text: 'slow' }]);
    child.emit('exit', code, signal);
    await expect(prompt).rejects.toThrow(expected);
  });

  it('bounds a stalled authentication by the handshake budget', async () => {
    const { transport } = fixture({
      authRequired: true,
      authHangs: true,
      limits: { handshakeTimeoutMs: 60, requestTimeoutMs: 5_000 },
    });
    const started = Date.now();
    await expectCode(transport.start(), 'HANDSHAKE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('signals the whole tree on Windows so an npx grandchild is not orphaned', () => {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const child = new FakeChild(4321);
    killProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      runCommand: (command, args) => commands.push({ command, args }),
    });
    expect(commands).toEqual([{ command: 'taskkill', args: ['/pid', '4321', '/T', '/F'] }]);
  });

  it('closes when the process reports a spawn error and never emits exit', async () => {
    const { child, transport } = fixture({ autoInitialize: false });
    const started = transport.start();
    // Node reports a failed spawn as 'error' followed by 'close', with no 'exit'.
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    child.emit('close', -2, null);
    await expect(started).rejects.toThrow();
    await transport.stop();
    expect(transport.state).toBe('closed');
  });

  it('escalates termination after a protocol failure', async () => {
    const { child, transport } = fixture({
      autoInitialize: false,
      limits: { maxFrameBytes: 1024 * 1024 },
    });
    const started = transport.start();
    child.stdout.write('x'.repeat(1024 * 1024 + 1));
    await expectCode(started, 'PROTOCOL_FRAME_TOO_LARGE');
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).toContain('SIGKILL');
  });

  it('accepts an inbound frame well over 1 MiB by default', async () => {
    const { child, transport } = fixture();
    await transport.start();
    const received = new Promise<number>((resolveReceived) => {
      transport.on('sessionUpdate', (notification) => {
        if (
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text'
        )
          resolveReceived(notification.update.content.text.length);
      });
    });
    const text = 'A'.repeat(2 * 1024 * 1024);
    sessionUpdate(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    await expect(received).resolves.toBe(text.length);
    expect(transport.state).toBe('ready');
    await close(child, transport);
  });

  it('reports a broken connection once and terminates it once, however many failures follow', async () => {
    const { child, transport } = fixture({
      autoInitialize: false,
      limits: { maxFrameBytes: 128, terminateTimeoutMs: 1_000 },
    });
    const errors: string[] = [];
    transport.on('protocolError', (error) => errors.push(error.code));
    const started = transport.start();
    child.stdout.write('x'.repeat(129));
    await expectCode(started, 'PROTOCOL_FRAME_TOO_LARGE');
    // More reports of the same broken connection: more output, stdout ending mid-frame, a process error.
    child.stdout.write('y'.repeat(200));
    child.stdout.end();
    child.emit('error', new Error('EPIPE'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    expect(errors).toEqual(['PROTOCOL_FRAME_TOO_LARGE']);
    expect(child.killed).toEqual(['SIGTERM']);
    expect(transport.state).toBe('failed');
  });

  it('ends closed when spawning the Agent throws, so stop() has nothing left to wait for', async () => {
    const trust = new AgentTrustStore();
    const config = trust.approve({ id: 'missing-agent', command: '/missing/agent' });
    const transport = new AgentTransport(trust, config, {
      spawn: () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      },
      session: { cwd: '/workspace' },
    });
    const states: string[] = [];
    transport.on('state', ({ current }) => states.push(current));

    await expectCode(transport.start(), 'SPAWN_FAILED');
    expect(transport.state).toBe('closed');
    expect(states).toEqual(['spawning', 'failed', 'closed']);
    await transport.stop();
    expect(transport.state).toBe('closed');
  });

  it('tells a start() that stop() interrupted apart from an Agent that went away', async () => {
    const { child, transport } = fixture({ autoInitialize: false });
    const errors: unknown[] = [];
    transport.on('protocolError', (error) => errors.push(error));
    const started = transport.start();
    started.catch(() => undefined);
    await vi.waitFor(() => expect(child.stdin.frames[0]?.method).toBe('initialize'));

    const stopping = transport.stop();
    child.emit('exit', 0, null);
    await stopping;

    const error = await started.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ name: 'AgentTransportError', code: 'STOPPED' });
    expect((error as Error).message).not.toMatch(/unexpectedly/);
    expect(errors).toEqual([]);
    expect(transport.state).toBe('closed');
  });

  it('runs one prompt at a time and accepts the next once the first settles', async () => {
    const { child, transport } = fixture();
    await transport.start();
    child.stdin.onFrame = () => {
      /* keep the first prompt in flight */
    };
    const first = transport.prompt([{ type: 'text', text: 'first' }]);
    await expectCode(transport.prompt([{ type: 'text', text: 'second' }]), 'INVALID_STATE');
    await vi.waitFor(() =>
      expect(child.stdin.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(
        1,
      ),
    );

    const sent = child.stdin.frames.find((frame) => frame.method === 'session/prompt');
    reply(child, sent?.id, { stopReason: 'end_turn' });
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
    child.stdin.onFrame = (message) => {
      if (message.method === 'session/prompt') reply(child, message.id, { stopReason: 'end_turn' });
    };
    await expect(transport.prompt([{ type: 'text', text: 'third' }])).resolves.toEqual({
      stopReason: 'end_turn',
    });
    await close(child, transport);
  });

  it('tolerates a login banner before the first ACP frame and keeps it for diagnosis', async () => {
    const { child, transport } = fixture();
    const errors: string[] = [];
    transport.on('protocolError', (error) => errors.push(error.code));
    const started = transport.start();
    child.stdout.write('Welcome to build-host\n\r\n   \nLast login: Tue from 10.0.0.1\r\n');
    await started;

    expect(transport.state).toBe('ready');
    expect(transport.stderrSnapshot.text).toBe(
      '[stdout before ACP] Welcome to build-host\n[stdout before ACP] Last login: Tue from 10.0.0.1\n',
    );

    // Once the Agent speaks ACP, a line that is not JSON is a protocol error again.
    child.stdout.write('Last login: again\n');
    await vi.waitFor(() => expect(transport.state).toBe('failed'));
    expect(errors).toEqual(['PROTOCOL_INVALID_FRAME']);
  });

  it('fails a handshake drowned in non-JSON output', async () => {
    const lines = fixture({ autoInitialize: false });
    const linesStart = lines.transport.start();
    lines.child.stdout.write(
      Array.from({ length: 21 }, (_, index) => `banner ${index}\n`).join(''),
    );
    await expect(linesStart).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID_FRAME',
      message: expect.stringMatching(/before its first ACP frame/),
    });

    const bytes = fixture({ autoInitialize: false });
    const bytesStart = bytes.transport.start();
    bytes.child.stdout.write(`${'b'.repeat(9 * 1024)}\n`);
    await expectCode(bytesStart, 'PROTOCOL_INVALID_FRAME');
  });

  it.each([
    [-32002, 'Resource not found'],
    [-32603, 'Session persisted-session not found'],
    [-32602, 'Unknown sessionId: persisted-session'],
  ])(
    'opens a new session when the Agent no longer knows the resumed one (%s)',
    async (code, message) => {
      const { child, transport } = fixture({
        resumeSessionId: 'persisted-session',
        resumeError: { code, message },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      });
      await transport.start();
      expect(transport.sessionId).toBe('fixture-session');
      expect(child.stdin.frames.map((frame) => frame.method)).toEqual([
        'initialize',
        'session/resume',
        'session/new',
      ]);
      await close(child, transport);
    },
  );

  it('still fails a resume the Agent cannot perform at all', async () => {
    const { child, transport } = fixture({
      resumeSessionId: 'persisted-session',
      resumeError: { code: -32601, message: 'Method not found: session/resume' },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });
    await expect(transport.start()).rejects.toThrow(/Method not found/);
    expect(child.stdin.frames.map((frame) => frame.method)).not.toContain('session/new');
  });

  it('passes proxies and the Windows profile variables through, and nothing else', async () => {
    const baseEnv = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      https_proxy: 'http://proxy.internal:8080',
      ALL_PROXY: 'socks5://proxy.internal:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      GITHUB_TOKEN: 'not-for-the-agent',
    };
    const { child, transport, getSpawnOptions } = fixture({ baseEnv });
    await transport.start();
    const inherited: Record<string, string> = { ...baseEnv };
    delete inherited.GITHUB_TOKEN;
    expect(getSpawnOptions()?.env).toEqual(inherited);
    await close(child, transport);
  });

  it.each(['auto', 'dontAsk', 'unrestricted'])(
    'refuses to report ask mode while stuck in the no-ask mode %s',
    async (modeId) => {
      const { child, transport } = fixture({
        sessionResponse: {
          modes: { currentModeId: modeId, availableModes: [{ id: modeId, name: modeId }] },
        },
      });
      await transport.start();
      await expect(transport.setPermissionMode('ask')).rejects.toThrow(
        '该 Agent 未提供需要确认的权限模式',
      );
      expect(transport.currentMode).toBe(modeId);
      await close(child, transport);
    },
  );
});

describe('AgentProcessManager', () => {
  const limits = {
    handshakeTimeoutMs: 100,
    requestTimeoutMs: 100,
    drainTimeoutMs: 5,
    terminateTimeoutMs: 5,
  };

  it('does not keep a transport whose Agent could not be spawned', async () => {
    const manager = new AgentProcessManager();
    const config = manager.approve({ id: 'missing-agent', command: '/missing/agent' });
    await expectCode(
      manager.connect(config, {
        spawn: () => {
          throw new Error('spawn EACCES');
        },
        limits,
        session: { cwd: '/workspace' },
      }),
      'SPAWN_FAILED',
    );
    expect(manager.connectionCount).toBe(0);
  });

  it('forgets the approved launch config once its process has ended', async () => {
    const manager = new AgentProcessManager();
    const child = new FakeChild();
    child.stdin.onFrame = (message) => {
      if (message.method === 'initialize')
        reply(child, message.id, { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} });
      if (message.method === 'session/new') reply(child, message.id, { sessionId: 'managed' });
    };
    const config = manager.approve({
      id: 'managed-agent',
      command: '/trusted/agent',
      env: { AGENT_TOKEN: 'not-a-real-token' },
    });
    const transport = await manager.connect(config, {
      spawn: () => child,
      killTree: (process, signal) => {
        process.kill(signal);
      },
      limits,
      session: { cwd: '/workspace' },
    });
    expect(manager.connectionCount).toBe(1);
    expect(() => manager.trust.assert(config)).not.toThrow();

    await close(child, transport);
    expect(manager.connectionCount).toBe(0);
    expect(() => manager.trust.assert(config)).toThrow(
      expect.objectContaining({ code: 'UNTRUSTED_CONFIG' }),
    );
  });
});

describe('AgentTransport prompt silence detection', () => {
  const WINDOW = 1_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A turn left in flight on a clock the test drives. The handshake runs on real timers first. */
  async function turn(options: Parameters<typeof fixture>[0] = {}) {
    const { child, transport } = fixture({
      ...options,
      limits: { promptIdleTimeoutMs: WINDOW, ...options.limits },
    });
    await transport.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const silences: number[] = [];
    transport.on('idle', ({ silentMs }) => silences.push(silentMs));
    const outcome: { settled?: 'resolved' | 'rejected' } = {};
    const prompt = transport.prompt([{ type: 'text', text: 'a long task' }]);
    prompt.then(
      () => (outcome.settled = 'resolved'),
      () => (outcome.settled = 'rejected'),
    );
    await vi.advanceTimersByTimeAsync(0);
    return {
      child,
      transport,
      silences,
      outcome,
      prompt,
      advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
      agentSays() {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'fixture-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'working' },
              },
            },
          })}\n`,
        );
      },
      agentAsksPermission() {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 91,
            method: 'session/request_permission',
            params: {
              sessionId: 'fixture-session',
              toolCall: { toolCallId: 'tool-1', title: 'Run tool', rawInput: {} },
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
            },
          })}\n`,
        );
      },
      agentEndsTurn(stopReason = 'end_turn') {
        const frame = child.stdin.frames.find((item) => item.method === 'session/prompt');
        reply(child, frame?.id, { stopReason });
      },
      async finish() {
        vi.useRealTimers();
        await close(child, transport);
      },
    };
  }

  it('never calls an Agent silent while it keeps sending updates, however long the turn runs', async () => {
    const t = await turn();
    for (let round = 0; round < 5; round += 1) {
      await t.advance(400);
      t.agentSays();
    }
    await t.advance(0);

    expect(t.silences).toEqual([]);
    expect(t.outcome.settled).toBeUndefined();
    t.agentEndsTurn();
    await expect(t.prompt).resolves.toEqual({ stopReason: 'end_turn' });
    await t.finish();
  });

  it('reports silence once the window passes and leaves the turn alive for the caller to cancel', async () => {
    const t = await turn();
    await t.advance(WINDOW - 1);
    expect(t.silences).toEqual([]);
    await t.advance(1);
    expect(t.silences).toHaveLength(1);
    expect(t.silences[0]).toBeGreaterThanOrEqual(WINDOW);

    await t.advance(3 * WINDOW);
    expect(t.silences).toHaveLength(1);
    expect(t.outcome.settled).toBeUndefined();
    expect(t.transport.state).toBe('ready');
    expect(t.child.killed).toEqual([]);
    t.agentEndsTurn('cancelled');
    await expect(t.prompt).resolves.toEqual({ stopReason: 'cancelled' });
    await t.finish();
  });

  it('does not count the time Pilion keeps the Agent waiting for an answer', async () => {
    let allow!: (response: RequestPermissionResponse) => void;
    const answer = new Promise<RequestPermissionResponse>((resolve) => {
      allow = resolve;
    });
    const t = await turn({ requestPermission: () => answer });
    t.agentAsksPermission();
    await t.advance(5 * WINDOW);
    expect(t.silences).toEqual([]);

    allow({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    await t.advance(0);
    await t.advance(WINDOW - 1);
    expect(t.silences).toEqual([]);
    await t.advance(1);
    expect(t.silences).toHaveLength(1);
    await t.finish();
  });

  it('does not count the work Pilion does for the Agent, and gives it a full window afterwards', async () => {
    const t = await turn();
    const release = t.transport.holdIdle();
    await t.advance(5 * WINDOW + WINDOW / 2);
    expect(t.silences).toEqual([]);

    release();
    await t.advance(WINDOW - 1);
    expect(t.silences).toEqual([]);
    await t.advance(1);
    expect(t.silences).toHaveLength(1);
    await t.finish();
  });

  it('treats a hold released twice as released once', async () => {
    const t = await turn();
    const first = t.transport.holdIdle();
    t.transport.holdIdle();
    first();
    first();

    await t.advance(5 * WINDOW);
    expect(t.silences).toEqual([]);
    await t.finish();
  });

  it('stops watching once the turn has ended', async () => {
    const t = await turn();
    await t.advance(WINDOW);
    expect(t.silences).toHaveLength(1);

    t.agentEndsTurn('cancelled');
    await t.advance(0);
    await t.advance(10 * WINDOW);
    expect(t.silences).toHaveLength(1);
    await t.finish();
  });

  /** A goal running with no prompt in flight, on a clock the test drives. */
  async function goal() {
    const { child, transport } = fixture({
      initializeMeta: {
        goal: { version: 1, controlMethod: '_session/goal', actions: ['set', 'clear'] },
      },
      limits: { promptIdleTimeoutMs: WINDOW },
    });
    await transport.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const silences: number[] = [];
    transport.on('idle', ({ silentMs }) => silences.push(silentMs));
    const report = (status: string | null) => {
      sessionUpdate(child, {
        sessionUpdate: 'session_info_update',
        _meta: {
          goal: status && { objective: 'Ship it', status, controlMethod: '_session/goal' },
        },
      });
    };
    const goalReported = () =>
      new Promise<void>((resolveReported) => transport.on('goal', () => resolveReported()));
    child.stdin.onFrame = (message) => {
      if (message.method === '_session/goal') {
        if (message.params?.action === 'set') report('active');
        reply(child, message.id, {});
      }
      if (message.method === 'session/prompt') reply(child, message.id, { stopReason: 'end_turn' });
    };
    await transport.setGoal('Ship it');
    return {
      child,
      transport,
      silences,
      report,
      goalReported,
      advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
      async finish() {
        vi.useRealTimers();
        await close(child, transport);
      },
    };
  }

  it('watches a goal that runs with no prompt in flight, until the goal stops', async () => {
    const g = await goal();
    await g.advance(WINDOW - 1);
    expect(g.silences).toEqual([]);
    await g.advance(1);
    expect(g.silences).toHaveLength(1);

    const reported = g.goalReported();
    g.report('complete');
    await reported;
    await g.advance(10 * WINDOW);
    expect(g.silences).toHaveLength(1);
    await g.finish();
  });

  it('keeps watching the goal after a prompt inside it settles, and stops when it is cleared', async () => {
    const g = await goal();
    await expect(g.transport.prompt([{ type: 'text', text: 'nudge' }])).resolves.toEqual({
      stopReason: 'end_turn',
    });
    await g.advance(WINDOW);
    expect(g.silences).toHaveLength(1);

    await g.transport.clearGoal();
    await g.advance(10 * WINDOW);
    expect(g.silences).toHaveLength(1);
    await g.finish();
  });
});
