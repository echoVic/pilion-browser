import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AgentTransport,
  AgentTransportError,
  AgentTrustStore,
  type ChildProcessLike,
  type SpawnAgent,
} from '../src/main/agents/index';

class FakeStdin extends EventEmitter {
  destroyed = false;
  ended = false;
  blocked = false;
  readonly frames: string[] = [];
  onFrame?: (message: { method?: string; id?: number }) => void;

  write(value: Buffer): boolean {
    const frame = value.toString('utf8');
    this.frames.push(frame);
    this.onFrame?.(JSON.parse(frame));
    return !this.blocked;
  }

  end(): void {
    this.ended = true;
  }

  release(): void {
    this.blocked = false;
    this.emit('drain');
  }
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new FakeStdin() as unknown as ChildProcessLike['stdin'];
  readonly pid = undefined;
  killed: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fixture(options: { autoHandshake?: boolean; limits?: Record<string, number> } = {}) {
  const child = new FakeChild();
  const stdin = child.stdin as unknown as FakeStdin;
  const trust = new AgentTrustStore();
  const config = trust.approve({ id: 'test-agent', command: '/trusted/agent', args: ['--stdio'] });
  let spawnOptions: Parameters<SpawnAgent>[2] | undefined;
  const spawn: SpawnAgent = (_command, _args, received) => {
    spawnOptions = received;
    const handshakeSecret = received.env.PILION_ACP_DRAFT_HANDSHAKE_SECRET;
    if (options.autoHandshake !== false) {
      stdin.onFrame = message => {
        if (message.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: 'pilion-acp-draft-1',
              handshakeSecret,
            },
          })}\n`);
        }
      };
    }
    return child;
  };
  const transport = new AgentTransport(trust, config, {
    spawn,
    killTree: (process, signal) => { process.kill(signal); },
    limits: { handshakeTimeoutMs: 100, requestTimeoutMs: 100, ...options.limits },
  });
  return { child, stdin, transport, getSpawnOptions: () => spawnOptions };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AgentTransportError', code });
}

describe('AgentTransport stdio JSON-RPC draft adapter', () => {
  it('uses a dedicated shell-free spawn and a one-time handshake secret', async () => {
    const { transport, getSpawnOptions } = fixture();
    await transport.start();
    expect(transport.state).toBe('ready');
    expect(getSpawnOptions()).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(getSpawnOptions()?.env.PILION_ACP_DRAFT_HANDSHAKE_SECRET).toBeUndefined();
    expect(transport.capabilities.matrix).toEqual(expect.objectContaining({
      'agent.task': 'native',
      'browser.tools': 'emulated',
      'acp.official': 'unsupported',
      'process.arbitrary-shell': 'unsafe',
    }));
  });

  it('rejects an invalid stdout frame with a structured error', async () => {
    const { child, transport } = fixture({ autoHandshake: false });
    const started = transport.start();
    child.stdout.write('{not-json}\n');
    await expectCode(started, 'PROTOCOL_INVALID_FRAME');
    expect(transport.state).toBe('failed');
  });

  it('rejects a stdout frame over the configured maximum', async () => {
    const { child, transport } = fixture({ autoHandshake: false, limits: { maxFrameBytes: 128 } });
    const started = transport.start();
    child.stdout.write('x'.repeat(129));
    await expectCode(started, 'PROTOCOL_FRAME_TOO_LARGE');
  });

  it('enforces stdin high-water backpressure and resumes at drain', async () => {
    const { stdin, transport } = fixture({ limits: { writeHighWaterBytes: 700, writeLowWaterBytes: 100 } });
    await transport.start();
    stdin.blocked = true;
    transport.notify('first', { value: 'x'.repeat(100) });
    transport.notify('second', { value: 'x'.repeat(500) });
    expect(() => transport.notify('third', { value: 'x'.repeat(500) })).toThrowError(
      expect.objectContaining({ code: 'WRITE_BACKPRESSURE' }),
    );
    stdin.release();
    expect(stdin.frames.some(frame => frame.includes('"method":"second"'))).toBe(true);
  });

  it('detects a duplicate response instead of settling twice', async () => {
    const { child, stdin, transport } = fixture();
    await transport.start();
    let requestId = 0;
    stdin.onFrame = message => {
      if (message.method !== 'work' || message.id === undefined) return;
      requestId = message.id;
      const response = `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: 'ok' })}\n`;
      child.stdout.write(response);
      child.stdout.write(response);
    };
    const errors: AgentTransportError[] = [];
    transport.on('protocolError', error => errors.push(error));
    await expect(transport.request('work')).resolves.toBe('ok');
    expect(requestId).toBeGreaterThan(0);
    expect(errors.some(error => error.code === 'PROTOCOL_DUPLICATE_RESPONSE')).toBe(true);
    expect(transport.state).toBe('failed');
  });

  it('never emits Agent requests after failed and escalates termination', async () => {
    const { child, transport } = fixture({ autoHandshake: false, limits: { terminateTimeoutMs: 5 } });
    const started = transport.start();
    child.stdout.write('{invalid}\n');
    await expectCode(started, 'PROTOCOL_INVALID_FRAME');
    let requests = 0;
    transport.on('request', () => { requests += 1; });
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'late', method: 'browser/tool', params: {} })}\n`);
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(requests).toBe(0);
    expect(child.killed).toContain('SIGTERM');
    expect(child.killed).toContain('SIGKILL');
  });

  it('fails every in-flight request when the Agent exits', async () => {
    const { child, stdin, transport } = fixture();
    await transport.start();
    stdin.onFrame = () => { /* intentionally leave request in flight */ };
    const first = transport.request('slow-one');
    const second = transport.request('slow-two');
    child.emit('exit', 9, null);
    await expectCode(first, 'PROCESS_EXITED');
    await expectCode(second, 'PROCESS_EXITED');
    expect(transport.state).toBe('closed');
  });
});
