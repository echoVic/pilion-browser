import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { AgentTransportError, asTransportError } from './errors.js';
import { JsonLineDecoder } from './json-lines.js';
import { StderrRingBuffer } from './stderr-ring.js';
import { AgentTrustStore } from './trust.js';
import {
  type AgentSessionOptions,
  type CapabilitySnapshot,
  type ChildProcessLike,
  type SpawnAgent,
  type TransportEventMap,
  type TransportLimits,
  type TransportState,
  type TrustedAgentConfig,
} from './types.js';

const DEFAULT_LIMITS: TransportLimits = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  stderrMaxBytes: 64 * 1024,
  stderrRateBytesPerSecond: 16 * 1024,
  handshakeTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  drainTimeoutMs: 1_000,
  terminateTimeoutMs: 2_000,
});

const UNINITIALIZED_CAPABILITIES: CapabilitySnapshot = Object.freeze({
  protocol: PROTOCOL_VERSION,
  client: Object.freeze({
    session: 'native',
    fs: 'unsupported',
    terminal: 'unsupported',
    browserMcp: 'native',
  }),
  agent: Object.freeze({}),
  authMethods: Object.freeze([]),
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

export interface AgentTransportOptions {
  session: AgentSessionOptions;
  limits?: Partial<TransportLimits>;
  spawn?: SpawnAgent;
  baseEnv?: NodeJS.ProcessEnv;
  killTree?: (child: ChildProcessLike, signal: NodeJS.Signals) => void;
}

/** One shell-free Agent process, one official ACP v1 connection, and one ACP session. */
export class AgentTransport extends EventEmitter {
  #state: TransportState = 'idle';
  #child?: ChildProcessLike;
  #connection?: ClientConnection;
  #sessionId?: string;
  #capabilities = UNINITIALIZED_CAPABILITIES;
  #failure?: AgentTransportError;
  #stderr: StderrRingBuffer;
  #exitPromise?: Promise<void>;
  #resolveExit?: () => void;
  #limits: TransportLimits;
  #spawn: SpawnAgent;
  #baseEnv: NodeJS.ProcessEnv;
  #killTree: (child: ChildProcessLike, signal: NodeJS.Signals) => void;

  constructor(
    private readonly trust: AgentTrustStore,
    private readonly config: TrustedAgentConfig,
    private readonly options: AgentTransportOptions,
  ) {
    super();
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.#stderr = new StderrRingBuffer(this.#limits.stderrMaxBytes, this.#limits.stderrRateBytesPerSecond);
    this.#spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions) as ChildProcessLike);
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#killTree = options.killTree ?? defaultKillTree;
  }

  get state(): TransportState {
    return this.#state;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get capabilities(): CapabilitySnapshot {
    return this.#capabilities;
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
    const env: NodeJS.ProcessEnv = {
      ...pickBaseEnv(this.#baseEnv),
      ...(this.config.env ?? {}),
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

    this.#attachProcess(this.#child);
    this.#transition('handshaking');
    try {
      const acpApp = client({ name: 'pilion-browser' })
        .onRequest(methods.client.session.requestPermission, ({ params }) => this.#requestPermission(params))
        .onNotification(methods.client.session.update, ({ params }) => {
          if (params.sessionId === this.#sessionId) this.emit('sessionUpdate', params);
        });
      const stream = ndJsonStream(
        this.#guardedOutput(this.#child),
        this.#guardedInput(this.#child),
      );
      this.#connection = acpApp.connect(stream);
      void this.#connection.closed.then(
        () => this.#onConnectionClosed(),
        cause => this.#fail(asTransportError(cause, 'TRANSPORT_CLOSED', 'ACP connection closed'), true),
      );
      const initialized = await withTimeout(
        this.#connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'pilion-browser', title: 'Pilion Browser', version: '0.1.0' },
        }),
        this.#limits.handshakeTimeoutMs,
        'HANDSHAKE_TIMEOUT',
        'ACP initialize timed out',
      );
      this.#acceptInitialization(initialized);
      let session: NewSessionResponse;
      try {
        session = await this.#newSession();
      } catch (cause) {
        if (!isAuthRequired(cause)) throw cause;
        await this.#authenticate();
        session = await this.#newSession();
      }
      this.#sessionId = session.sessionId;
      this.#transition('ready');
      return this.#capabilities;
    } catch (cause) {
      const error = this.#failure ?? (cause instanceof AgentTransportError
        ? cause
        : asTransportError(cause, 'HANDSHAKE_FAILED', 'ACP initialization failed'));
      this.#fail(error, true);
      throw error;
    }
  }

  prompt(text: string): Promise<PromptResponse> {
    if (this.#state !== 'ready' || !this.#connection || !this.#sessionId) {
      return Promise.reject(this.#invalidState('prompt'));
    }
    return withTimeout(
      this.#connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text }],
      }),
      this.#limits.requestTimeoutMs,
      'REQUEST_TIMEOUT',
      'ACP session/prompt timed out',
    ).catch(error => {
      if (error instanceof AgentTransportError && error.code === 'REQUEST_TIMEOUT') void this.cancel();
      throw error;
    });
  }

  async cancel(): Promise<void> {
    if (!['ready', 'draining'].includes(this.#state) || !this.#connection || !this.#sessionId) return;
    await this.#connection.agent.notify(methods.agent.session.cancel, { sessionId: this.#sessionId });
  }

  async stop(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'idle') {
      this.#transition('closed');
      return;
    }
    if (this.#state === 'ready') {
      const cancellation = this.cancel();
      this.#transition('draining');
      try { await cancellation; } catch { /* connection may already be closing */ }
    }
    this.#connection?.close();
    this.#child?.stdin.end();
    await this.#waitForExit(this.#limits.drainTimeoutMs);
    if ((this.#state as TransportState) === 'closed') return;
    if (this.#state !== 'stopping') this.#transition('stopping');
    this.#terminate('SIGTERM');
    await this.#waitForExit(this.#limits.terminateTimeoutMs);
    if ((this.#state as TransportState) !== 'closed') {
      this.#terminate('SIGKILL');
      await this.#waitForExit(this.#limits.terminateTimeoutMs);
    }
  }

  #acceptInitialization(initialized: InitializeResponse): void {
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new AgentTransportError(
        'HANDSHAKE_FAILED',
        `Unsupported ACP protocol version ${initialized.protocolVersion}; expected ${PROTOCOL_VERSION}`,
      );
    }
    this.#capabilities = Object.freeze({
      protocol: initialized.protocolVersion,
      client: UNINITIALIZED_CAPABILITIES.client,
      agent: Object.freeze({ ...(initialized.agentCapabilities ?? {}) }),
      ...(initialized.agentInfo ? { agentInfo: Object.freeze({ ...initialized.agentInfo }) } : {}),
      authMethods: Object.freeze([...(initialized.authMethods ?? [])]),
    });
  }

  #newSession(): Promise<NewSessionResponse> {
    return withTimeout(
      this.#connection!.agent.request(methods.agent.session.new, {
        cwd: resolve(this.options.session.cwd),
        mcpServers: [...(this.options.session.mcpServers ?? [])],
      }),
      this.#limits.handshakeTimeoutMs,
      'HANDSHAKE_TIMEOUT',
      'ACP session/new timed out',
    );
  }

  async #authenticate(): Promise<void> {
    const supported = this.#capabilities.authMethods.filter(method => !('type' in method) || method.type !== 'terminal');
    const configured = this.options.session.authMethodId;
    const selected = configured
      ? supported.find(method => method.id === configured)
      : supported.length === 1 ? supported[0] : undefined;
    if (!selected) {
      const available = supported.map(method => method.id).join(', ') || 'none';
      throw new AgentTransportError(
        'HANDSHAKE_FAILED',
        configured
          ? `ACP authentication method "${configured}" is not available; Agent methods: ${available}`
          : `ACP authentication required; configure authMethodId from: ${available}`,
      );
    }
    await withTimeout(
      this.#connection!.agent.request(methods.agent.authenticate, { methodId: selected.id }),
      this.#limits.requestTimeoutMs,
      'HANDSHAKE_TIMEOUT',
      'ACP authentication timed out',
    );
  }

  async #requestPermission(
    request: Parameters<NonNullable<AgentSessionOptions['requestPermission']>>[0],
  ): Promise<RequestPermissionResponse> {
    if (request.sessionId !== this.#sessionId) return { outcome: { outcome: 'cancelled' } };
    if (this.options.session.requestPermission) return this.options.session.requestPermission(request);
    const reject = request.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  #attachProcess(child: ChildProcessLike): void {
    this.#exitPromise = new Promise(resolveExit => { this.#resolveExit = resolveExit; });
    child.stderr.on('data', chunk => {
      const value = this.#stderr.push(chunk as Buffer);
      if (value.accepted || value.droppedBytes) this.emit('stderr', { chunk: value.accepted, droppedBytes: value.droppedBytes });
    });
    child.on('error', cause => this.#fail(asTransportError(cause, 'SPAWN_FAILED', 'Agent process error'), false));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.#onExit(code, signal));
  }

  #guardedInput(child: ChildProcessLike): ReadableStream<Uint8Array> {
    const decoder = new JsonLineDecoder(this.#limits.maxFrameBytes);
    return new ReadableStream<Uint8Array>({
      start: controller => {
        child.stdout.on('data', chunk => {
          try {
            for (const message of decoder.push(Buffer.from(chunk))) {
              controller.enqueue(Buffer.from(`${JSON.stringify(message)}\n`));
            }
          } catch (cause) {
            const error = asTransportError(cause, 'PROTOCOL_INVALID_FRAME', 'Invalid ACP JSON-RPC frame');
            this.#fail(error, true);
            controller.error(error);
          }
        });
        child.stdout.on('end', () => {
          try {
            decoder.end();
            controller.close();
          } catch (cause) {
            const error = asTransportError(cause, 'PROTOCOL_INVALID_FRAME', 'Incomplete ACP JSON-RPC frame');
            this.#fail(error, true);
            controller.error(error);
          }
        });
        child.stdout.on('error', cause => {
          const error = asTransportError(cause, 'TRANSPORT_CLOSED', 'Unable to read Agent stdout');
          this.#fail(error, true);
          controller.error(error);
        });
      },
    });
  }

  #guardedOutput(child: ChildProcessLike): WritableStream<Uint8Array> {
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const guard = frameLimit(this.#limits.maxFrameBytes, error => this.#fail(error, true));
    void guard.readable.pipeTo(output).catch(cause => {
      if (!['closed', 'stopping', 'draining'].includes(this.#state)) {
        this.#fail(asTransportError(cause, 'WRITE_BACKPRESSURE', 'Unable to write ACP message'), true);
      }
    });
    return guard.writable;
  }

  #fail(error: AgentTransportError, terminate: boolean): void {
    if (this.#state === 'closed') return;
    this.#failure ??= error;
    if (this.#state !== 'failed' && ALLOWED_TRANSITIONS[this.#state].includes('failed')) this.#transition('failed');
    this.emit('protocolError', error);
    this.#connection?.close(error);
    if (terminate) {
      this.#terminate('SIGTERM');
      const escalation = setTimeout(() => {
        if (this.#state !== 'closed') this.#terminate('SIGKILL');
      }, this.#limits.terminateTimeoutMs);
      escalation.unref();
    }
  }

  #onConnectionClosed(): void {
    if (['closed', 'stopping', 'draining', 'failed'].includes(this.#state)) return;
    this.#fail(new AgentTransportError('TRANSPORT_CLOSED', 'ACP connection closed unexpectedly'), true);
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = ['draining', 'stopping', 'failed'].includes(this.#state);
    const error = new AgentTransportError('PROCESS_EXITED', 'Agent process exited', { code, signal, expected });
    this.#connection?.close(error);
    if (!expected) this.emit('protocolError', error);
    if (this.#state !== 'closed' && ALLOWED_TRANSITIONS[this.#state].includes('closed')) this.#transition('closed');
    this.#resolveExit?.();
  }

  #terminate(signal: NodeJS.Signals): void {
    if (this.#child) this.#killTree(this.#child, signal);
  }

  async #waitForExit(timeoutMs: number): Promise<void> {
    if (!this.#exitPromise || this.#state === 'closed') return;
    await Promise.race([this.#exitPromise, new Promise<void>(resolveWait => setTimeout(resolveWait, timeoutMs))]);
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

function frameLimit(
  maxFrameBytes: number,
  onError: (error: AgentTransportError) => void,
): TransformStream<Uint8Array, Uint8Array> {
  let frameBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      for (const byte of chunk) {
        frameBytes = byte === 0x0a ? 0 : frameBytes + 1;
        if (frameBytes <= maxFrameBytes) continue;
        const error = new AgentTransportError('PROTOCOL_FRAME_TOO_LARGE', 'ACP JSON-RPC frame exceeds configured limit', {
          maxFrameBytes,
        });
        onError(error);
        throw error;
      }
      controller.enqueue(chunk);
    },
  });
}

function pickBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'LANG', 'SystemRoot']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: 'HANDSHAKE_TIMEOUT' | 'REQUEST_TIMEOUT',
  message: string,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new AgentTransportError(code, message, { timeoutMs })), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32000 && error.message.startsWith('Authentication required');
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
