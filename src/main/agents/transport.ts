import { spawn as nodeSpawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AgentTransportError, asTransportError } from './errors.js';
import { JsonLineDecoder } from './json-lines.js';
import { StderrRingBuffer } from './stderr-ring.js';
import { AgentTrustStore, createHandshakeSecret } from './trust.js';
import {
  DRAFT_PROTOCOL_VERSION,
  type CapabilitySnapshot,
  type ChildProcessLike,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SpawnAgent,
  type TransportEventMap,
  type TransportLimits,
  type TransportState,
  type TrustedAgentConfig,
} from './types.js';

const DEFAULT_LIMITS: TransportLimits = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  writeHighWaterBytes: 1024 * 1024,
  writeLowWaterBytes: 256 * 1024,
  stderrMaxBytes: 64 * 1024,
  stderrRateBytesPerSecond: 16 * 1024,
  handshakeTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  drainTimeoutMs: 1_000,
  terminateTimeoutMs: 2_000,
});

export const DRAFT_CAPABILITY_SNAPSHOT: CapabilitySnapshot = Object.freeze({
  protocol: DRAFT_PROTOCOL_VERSION,
  capturedAt: 'static:draft-adapter-v1',
  matrix: Object.freeze({
    'agent.task': 'native',
    'agent.cancel': 'native',
    'browser.tools': 'emulated',
    'acp.official': 'unsupported',
    'process.arbitrary-shell': 'unsafe',
  }),
});

const ALLOWED_TRANSITIONS: Readonly<Record<TransportState, readonly TransportState[]>> = {
  idle: ['spawning', 'closed'],
  spawning: ['handshaking', 'failed', 'stopping', 'closed'],
  handshaking: ['ready', 'failed', 'stopping', 'closed'],
  ready: ['draining', 'stopping', 'failed', 'closed'],
  draining: ['stopping', 'failed', 'closed'],
  stopping: ['failed', 'closed'],
  failed: ['stopping', 'closed'],
  closed: [],
};

type Pending = {
  resolve(value: unknown): void;
  reject(error: AgentTransportError): void;
  timer: NodeJS.Timeout;
};

type QueueEntry = { bytes: number; frame: Buffer };

export interface AgentTransportOptions {
  limits?: Partial<TransportLimits>;
  spawn?: SpawnAgent;
  baseEnv?: NodeJS.ProcessEnv;
  killTree?: (child: ChildProcessLike, signal: NodeJS.Signals) => void;
}

/**
 * A private, line-delimited JSON-RPC draft adapter. It deliberately does not claim ACP compatibility.
 * One AgentTransport owns exactly one spawned process and cannot be restarted.
 */
export class AgentTransport extends EventEmitter {
  #state: TransportState = 'idle';
  #child?: ChildProcessLike;
  #decoder: JsonLineDecoder;
  #stderr: StderrRingBuffer;
  #pending = new Map<number, Pending>();
  #completed = new Set<number>();
  #sequence = 0;
  #queue: QueueEntry[] = [];
  #queuedBytes = 0;
  #writeBlocked = false;
  #exitPromise?: Promise<void>;
  #resolveExit?: () => void;
  #limits: TransportLimits;
  #spawn: SpawnAgent;
  #baseEnv: NodeJS.ProcessEnv;
  #killTree: (child: ChildProcessLike, signal: NodeJS.Signals) => void;

  constructor(
    private readonly trust: AgentTrustStore,
    private readonly config: TrustedAgentConfig,
    options: AgentTransportOptions = {},
  ) {
    super();
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    if (this.#limits.writeLowWaterBytes >= this.#limits.writeHighWaterBytes) {
      throw new RangeError('writeLowWaterBytes must be below writeHighWaterBytes');
    }
    this.#decoder = new JsonLineDecoder(this.#limits.maxFrameBytes);
    this.#stderr = new StderrRingBuffer(this.#limits.stderrMaxBytes, this.#limits.stderrRateBytesPerSecond);
    this.#spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions) as ChildProcessLike);
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#killTree = options.killTree ?? defaultKillTree;
  }

  get state(): TransportState {
    return this.#state;
  }

  get capabilities(): CapabilitySnapshot {
    return DRAFT_CAPABILITY_SNAPSHOT;
  }

  get stderrSnapshot(): { text: string; droppedBytes: number } {
    return this.#stderr.snapshot();
  }

  override on<K extends keyof TransportEventMap>(event: K, listener: (value: TransportEventMap[K]) => void): this {
    return super.on(event, listener);
  }

  async start(): Promise<CapabilitySnapshot> {
    if (this.#state !== 'idle') throw this.#invalidState('start');
    this.trust.assert(this.config);
    this.#transition('spawning');
    const secret = createHandshakeSecret();
    const env: NodeJS.ProcessEnv = {
      ...pickBaseEnv(this.#baseEnv),
      ...(this.config.env ?? {}),
      PILION_ACP_DRAFT_HANDSHAKE_SECRET: secret,
    };
    try {
      this.#child = this.#spawn(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (cause) {
      const error = asTransportError(cause, 'SPAWN_FAILED', 'Unable to spawn Agent process');
      this.#fail(error, false);
      throw error;
    }
    delete env.PILION_ACP_DRAFT_HANDSHAKE_SECRET;
    this.#attach(this.#child);
    this.#transition('handshaking');
    try {
      const result = await this.#requestRaw(
        'initialize',
        {
          protocolVersion: DRAFT_PROTOCOL_VERSION,
          adapter: 'private-draft; not official ACP',
          capabilitySnapshot: DRAFT_CAPABILITY_SNAPSHOT,
        },
        this.#limits.handshakeTimeoutMs,
      );
      if (!validHandshake(result, secret)) {
        throw new AgentTransportError('HANDSHAKE_FAILED', 'Agent returned an invalid protocol version or one-time secret');
      }
      this.#transition('ready');
      return DRAFT_CAPABILITY_SNAPSHOT;
    } catch (cause) {
      const error = cause instanceof AgentTransportError && cause.code === 'REQUEST_TIMEOUT'
        ? new AgentTransportError('HANDSHAKE_TIMEOUT', 'Agent handshake timed out', undefined, { cause })
        : asTransportError(cause, 'HANDSHAKE_FAILED', 'Agent handshake failed');
      this.#fail(error, true);
      throw error;
    }
  }

  request(method: string, params?: unknown, timeoutMs = this.#limits.requestTimeoutMs): Promise<unknown> {
    if (this.#state !== 'ready') return Promise.reject(this.#invalidState('request'));
    return this.#requestRaw(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (this.#state !== 'ready') throw this.#invalidState('notify');
    this.#send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result: unknown): void {
    if (!['ready', 'draining'].includes(this.#state)) throw this.#invalidState('respond');
    this.#send({ jsonrpc: '2.0', id, result });
  }

  respondError(id: string | number, code: number, message: string, data?: unknown): void {
    if (!['ready', 'draining'].includes(this.#state)) throw this.#invalidState('respondError');
    this.#send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  /** Half-close stdin after queued frames flush; stdout remains readable while state is draining. */
  closeInput(): void {
    if (this.#state === 'ready') this.#transition('draining');
    if (this.#state !== 'draining') throw this.#invalidState('closeInput');
    this.#flush();
    if (!this.#queue.length && !this.#writeBlocked) this.#child?.stdin.end();
  }

  async stop(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'idle') {
      this.#transition('closed');
      return;
    }
    if (this.#state === 'ready') {
      this.#send({ jsonrpc: '2.0', method: 'shutdown', params: {} });
      this.closeInput();
      await this.#waitForExit(this.#limits.drainTimeoutMs);
      if ((this.#state as TransportState) === 'closed') return;
    }
    if (this.#state !== 'stopping') this.#transition('stopping');
    this.#terminate('SIGTERM');
    await this.#waitForExit(this.#limits.terminateTimeoutMs);
    if ((this.#state as TransportState) !== 'closed') {
      this.#terminate('SIGKILL');
      await this.#waitForExit(this.#limits.terminateTimeoutMs);
    }
  }

  #attach(child: ChildProcessLike): void {
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    child.stdout.on('data', chunk => {
      try {
        for (const message of this.#decoder.push(chunk as Buffer)) this.#message(message);
      } catch (cause) {
        this.#fail(asTransportError(cause, 'PROTOCOL_INVALID_FRAME', 'Invalid Agent stdout frame'), true);
      }
    });
    child.stdout.on('end', () => {
      try { this.#decoder.end(); } catch (cause) {
        this.#fail(asTransportError(cause, 'PROTOCOL_INVALID_FRAME', 'Incomplete Agent stdout frame'), true);
      }
    });
    child.stderr.on('data', chunk => {
      const value = this.#stderr.push(chunk as Buffer);
      if (value.accepted || value.droppedBytes) this.emit('stderr', { chunk: value.accepted, droppedBytes: value.droppedBytes });
    });
    child.stdin.on('drain', () => {
      this.#writeBlocked = false;
      this.#flush();
    });
    child.on('error', cause => this.#fail(asTransportError(cause, 'SPAWN_FAILED', 'Agent process error'), false));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.#onExit(code, signal));
  }

  #message(message: JsonRpcMessage): void {
    const inboundAllowed = 'method' in message
      ? ['ready', 'draining'].includes(this.#state)
      : ['handshaking', 'ready', 'draining'].includes(this.#state);
    if (!inboundAllowed) {
      this.#fail(new AgentTransportError('PROTOCOL_MESSAGE_IN_INVALID_STATE', `Inbound message is not allowed while transport is ${this.#state}`), true);
      return;
    }
    if ('method' in message) {
      if ('id' in message) this.emit('request', message as JsonRpcRequest);
      else this.emit('notification', message as JsonRpcNotification);
      return;
    }
    const response = message as JsonRpcResponse;
    if (typeof response.id !== 'number') {
      this.#protocolFailure('PROTOCOL_UNKNOWN_RESPONSE', 'Response id was not issued by this transport', response.id);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#protocolFailure(
        this.#completed.has(response.id) ? 'PROTOCOL_DUPLICATE_RESPONSE' : 'PROTOCOL_UNKNOWN_RESPONSE',
        this.#completed.has(response.id) ? 'Duplicate JSON-RPC response' : 'Unknown JSON-RPC response id',
        response.id,
      );
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    this.#completed.add(response.id);
    if (this.#completed.size > 1024) this.#completed.delete(this.#completed.values().next().value!);
    if (response.error) pending.reject(new AgentTransportError('PROTOCOL_INVALID_FRAME', response.error.message, { rpcCode: response.error.code }));
    else pending.resolve(response.result);
  }

  #protocolFailure(code: 'PROTOCOL_DUPLICATE_RESPONSE' | 'PROTOCOL_UNKNOWN_RESPONSE', message: string, id: unknown): void {
    this.#fail(new AgentTransportError(code, message, { id }), true);
  }

  #requestRaw(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AgentTransportError('REQUEST_TIMEOUT', `JSON-RPC request timed out: ${method}`, { id, method, timeoutMs }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(asTransportError(cause, 'WRITE_BACKPRESSURE', 'Unable to queue JSON-RPC request'));
      }
    });
  }

  #send(message: JsonRpcMessage): void {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`);
    if (frame.length > this.#limits.maxFrameBytes) {
      throw new AgentTransportError('PROTOCOL_FRAME_TOO_LARGE', 'Outbound JSON-RPC frame exceeds configured limit');
    }
    if (this.#queuedBytes + frame.length > this.#limits.writeHighWaterBytes) {
      throw new AgentTransportError('WRITE_BACKPRESSURE', 'Agent stdin queue exceeded high-water mark', {
        queuedBytes: this.#queuedBytes,
        frameBytes: frame.length,
        highWaterBytes: this.#limits.writeHighWaterBytes,
      });
    }
    this.#queue.push({ bytes: frame.length, frame });
    this.#queuedBytes += frame.length;
    this.#flush();
  }

  #flush(): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || this.#writeBlocked) return;
    while (this.#queue.length) {
      const item = this.#queue.shift()!;
      this.#queuedBytes -= item.bytes;
      if (!stdin.write(item.frame)) {
        this.#writeBlocked = true;
        this.emit('backpressure', { queuedBytes: this.#queuedBytes, active: true });
        break;
      }
    }
    if (!this.#writeBlocked && this.#queuedBytes <= this.#limits.writeLowWaterBytes) {
      this.emit('backpressure', { queuedBytes: this.#queuedBytes, active: false });
      if (this.#state === 'draining' && !this.#queue.length) stdin.end();
    }
  }

  #fail(error: AgentTransportError, terminate: boolean): void {
    if (this.#state === 'closed') return;
    if (this.#state !== 'failed' && ALLOWED_TRANSITIONS[this.#state].includes('failed')) this.#transition('failed');
    this.emit('protocolError', error);
    this.#rejectPending(error);
    if (terminate) {
      this.#terminate('SIGTERM');
      const escalation = setTimeout(() => {
        if (this.#state !== 'closed') this.#terminate('SIGKILL');
      }, this.#limits.terminateTimeoutMs);
      escalation.unref();
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = ['draining', 'stopping', 'failed'].includes(this.#state);
    const error = new AgentTransportError('PROCESS_EXITED', 'Agent process exited', { code, signal, expected });
    this.#rejectPending(error);
    if (this.#state !== 'closed' && ALLOWED_TRANSITIONS[this.#state].includes('closed')) this.#transition('closed');
    this.#resolveExit?.();
  }

  #rejectPending(error: AgentTransportError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #terminate(signal: NodeJS.Signals): void {
    if (this.#child) this.#killTree(this.#child, signal);
  }

  async #waitForExit(timeoutMs: number): Promise<void> {
    if (!this.#exitPromise || this.#state === 'closed') return;
    await Promise.race([this.#exitPromise, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
  }

  #transition(next: TransportState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].includes(next)) throw this.#invalidState(`transition to ${next}`);
    const previous = this.#state;
    this.#state = next;
    this.emit('state', { previous, current: next });
  }

  #invalidState(operation: string): AgentTransportError {
    return new AgentTransportError('INVALID_STATE', `Cannot ${operation} while transport is ${this.#state}`, {
      operation,
      state: this.#state,
    });
  }
}

function pickBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'LANG', 'SystemRoot']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}

function validHandshake(value: unknown, secret: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.protocolVersion !== DRAFT_PROTOCOL_VERSION || typeof response.handshakeSecret !== 'string') return false;
  const actual = Buffer.from(response.handshakeSecret);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function defaultKillTree(child: ChildProcessLike, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the state check and signal delivery.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}
