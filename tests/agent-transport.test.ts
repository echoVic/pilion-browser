import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentTransport,
  AgentTrustStore,
  type ChildProcessLike,
  type SpawnAgent,
} from '../src/main/agents/index';

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
  readonly pid = undefined;
  killed: NodeJS.Signals[] = [];

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
    authMethodId?: string;
    sessionResponse?: Record<string, unknown>;
    agentCapabilities?: Record<string, unknown>;
    initializeMeta?: Record<string, unknown>;
    resumeSessionId?: string;
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
        if (message.method === 'session/resume' || message.method === 'session/load')
          reply(child, message.id, {});
        if (message.method === 'authenticate') {
          authenticated = true;
          reply(child, message.id, {});
        }
      };
    }
    return child;
  };
  const transport = new AgentTransport(trust, config, {
    spawn,
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

    await expect(transport.prompt('hello')).resolves.toEqual({ stopReason: 'end_turn' });
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

    const prompt = transport.prompt('permission');
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
    malformed.child.stdout.write('{not-json}\n');
    await expectCode(malformedStart, 'PROTOCOL_INVALID_FRAME');
    expect(malformed.transport.state).toBe('failed');

    const oversized = fixture({ autoInitialize: false, limits: { maxFrameBytes: 128 } });
    const oversizedStart = oversized.transport.start();
    oversized.child.stdout.write('x'.repeat(129));
    await expectCode(oversizedStart, 'PROTOCOL_FRAME_TOO_LARGE');
    expect(oversized.transport.state).toBe('failed');
  });

  it('rejects an in-flight prompt when the Agent exits', async () => {
    const { child, transport } = fixture();
    await transport.start();
    child.stdin.onFrame = () => {
      /* keep the prompt in flight */
    };
    const prompt = transport.prompt('slow');
    child.emit('exit', 9, null);
    await expect(prompt).rejects.toBeInstanceOf(Error);
    expect(transport.state).toBe('closed');
  });

  it('escalates termination after a protocol failure', async () => {
    const { child, transport } = fixture({ autoInitialize: false });
    const started = transport.start();
    child.stdout.write('x'.repeat(1024 * 1024 + 1));
    await expectCode(started, 'PROTOCOL_FRAME_TOO_LARGE');
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).toContain('SIGKILL');
  });
});
