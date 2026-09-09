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
  type AgentGoalCapability,
  type AgentGoalSnapshot,
  type AgentProtocolTrace,
  type CapabilitySnapshot,
  type ChildProcessLike,
  type JsonRpcMessage,
  type SpawnAgent,
  type TransportEventMap,
  type TransportLimits,
  type TransportState,
  type TrustedAgentConfig,
} from './types.js';
import type { SessionConfigOption, SessionMode } from '@agentclientprotocol/sdk';
import {
  flattenOptions,
  LegacyModelsSchema,
  modelOption,
  permissionTarget,
  type LegacyModels,
} from './session-controls.js';
import type { PermissionMode } from '../../shared/contracts.js';

const DEFAULT_LIMITS: TransportLimits = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  stderrMaxBytes: 64 * 1024,
  stderrRateBytesPerSecond: 16 * 1024,
  handshakeTimeoutMs: 5_000,
  requestTimeoutMs: 10 * 60_000,
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

type AgentGoalRequest =
  { sessionId: string; action: 'set'; objective: string } | { sessionId: string; action: 'clear' };

/** One shell-free Agent process, one official ACP v1 connection, and one ACP session. */
export class AgentTransport extends EventEmitter {
  #state: TransportState = 'idle';
  #child?: ChildProcessLike;
  #connection?: ClientConnection;
  #sessionId?: string;
  #configOptions: readonly SessionConfigOption[] = [];
  #modes: readonly SessionMode[] = [];
  #currentMode?: string;
  #currentModel?: string;
  #legacyModels?: LegacyModels;
  #goal?: AgentGoalSnapshot | null;
  #trace: AgentProtocolTrace[] = [];
  #pendingMethods = new Map<string, string>();
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
    this.#stderr = new StderrRingBuffer(
      this.#limits.stderrMaxBytes,
      this.#limits.stderrRateBytesPerSecond,
    );
    this.#spawn =
      options.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], spawnOptions) as ChildProcessLike);
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
  get configOptions(): readonly SessionConfigOption[] {
    return this.#configOptions;
  }
  get modes(): readonly SessionMode[] {
    return this.#modes;
  }
  get currentMode(): string | undefined {
    return this.#currentMode;
  }
  get currentModel(): string | undefined {
    return this.#currentModel;
  }
  get models(): { value: string; name: string }[] {
    const option = modelOption(this.#configOptions);
    return option?.type === 'select'
      ? flattenOptions(option.options).map((item) => ({ value: item.value, name: item.name }))
      : (this.#legacyModels?.availableModels.map((item) => ({
          value: item.modelId,
          name: item.name,
        })) ?? []);
  }
  get goal(): AgentGoalSnapshot | null | undefined {
    return this.#goal;
  }
  get traceSnapshot(): readonly AgentProtocolTrace[] {
    return [...this.#trace];
  }
  get supportsPersistentGoals(): boolean {
    return this.supportsGoal('set');
  }
  supportsGoal(action: 'set' | 'clear'): boolean {
    return this.#capabilities.goal?.actions.includes(action) ?? false;
  }

  get stderrSnapshot(): { text: string; droppedBytes: number } {
    return this.#stderr.snapshot();
  }

  override on<K extends keyof TransportEventMap>(
    event: K,
    listener: (value: TransportEventMap[K]) => void,
  ): this {
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
        .onRequest(methods.client.session.requestPermission, ({ params }) =>
          this.#requestPermission(params),
        )
        .onNotification(methods.client.session.update, ({ params }) => {
          if (params.sessionId !== this.#sessionId) return;
          if (params.update.sessionUpdate === 'config_option_update')
            this.#setOptions(params.update.configOptions);
          if (params.update.sessionUpdate === 'current_mode_update')
            this.#currentMode = params.update.currentModeId;
          const goal = goalFromUpdate(params.update);
          if (goal !== undefined) {
            this.#goal = goal;
            this.emit('goal', goal);
          }
          this.emit('sessionUpdate', params);
        });
      const stream = ndJsonStream(
        this.#guardedOutput(this.#child),
        this.#guardedInput(this.#child),
      );
      this.#connection = acpApp.connect(stream);
      void this.#connection.closed.then(
        () => this.#onConnectionClosed(),
        (cause) =>
          this.#fail(asTransportError(cause, 'TRANSPORT_CLOSED', 'ACP connection closed'), true),
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
      const session = await this.#openSession();
      this.#sessionId = session.sessionId;
      this.#setOptions(session.configOptions ?? []);
      this.#modes = Object.freeze([...(session.modes?.availableModes ?? [])]);
      this.#currentMode = session.modes?.currentModeId ?? this.#currentMode;
      this.#currentModel ??= this.#legacyModels?.currentModelId;
      this.#transition('ready');
      return this.#capabilities;
    } catch (cause) {
      const error =
        this.#failure ??
        (cause instanceof AgentTransportError
          ? cause
          : asTransportError(cause, 'HANDSHAKE_FAILED', 'ACP initialization failed'));
      this.#fail(error, true);
      throw error;
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.#connection || !this.#sessionId) throw this.#invalidState('set mode');
    if (!this.#modes.some((mode) => mode.id === modeId))
      throw new Error('Agent 不支持所选权限模式');
    await withTimeout(
      this.#connection.agent.request(methods.agent.session.setMode, {
        sessionId: this.#sessionId,
        modeId,
      }),
      15_000,
      'REQUEST_TIMEOUT',
      '切换 Agent 权限模式超时',
    );
    this.#currentMode = modeId;
  }
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.#connection || !this.#sessionId) throw this.#invalidState('set config option');
    const option = this.#configOptions.find((item) => item.id === configId);
    if (
      option?.type !== 'select' ||
      !flattenOptions(option.options).some((item) => item.value === value)
    )
      throw new Error('Agent 不支持所选配置');
    const response = await withTimeout(
      this.#connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.#sessionId,
        configId,
        value,
      }),
      15_000,
      'REQUEST_TIMEOUT',
      '切换 Agent 配置超时',
    );
    this.#setOptions(response.configOptions);
  }
  async setModel(modelId: string): Promise<void> {
    if (!this.#connection || !this.#sessionId) throw this.#invalidState('set model');
    if (!this.models.some((model) => model.value === modelId))
      throw new Error('Agent 不支持所选模型');
    const option = modelOption(this.#configOptions);
    if (option) {
      await this.setConfigOption(option.id, modelId);
      return;
    }
    await withTimeout(
      this.#connection.agent.request('session/set_model', { sessionId: this.#sessionId, modelId }),
      15_000,
      'REQUEST_TIMEOUT',
      '切换模型超时',
    );
    this.#currentModel = modelId;
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const target = permissionTarget(mode, this.#modes, this.#configOptions);
    if (target?.configId) await this.setConfigOption(target.configId, target.value);
    else if (target) await this.setMode(target.value);
    else if (
      mode === 'ask' &&
      this.#currentMode &&
      /bypass|full-access|yolo/i.test(this.#currentMode)
    )
      throw new Error('该 Agent 未提供需要确认的权限模式');
  }
  #setOptions(options: readonly SessionConfigOption[]): void {
    this.#configOptions = options;
    const model = modelOption(options);
    if (model?.type === 'select') this.#currentModel = model.currentValue;
    const mode = options.find((item) => item.category === 'mode' && item.type === 'select');
    if (mode?.type === 'select') this.#currentMode = mode.currentValue;
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
    ).catch((error) => {
      if (error instanceof AgentTransportError && error.code === 'REQUEST_TIMEOUT')
        this.#fail(error, true);
      throw error;
    });
  }

  async cancel(): Promise<void> {
    if (!['ready', 'draining'].includes(this.#state) || !this.#connection || !this.#sessionId)
      return;
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#sessionId,
    });
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
      try {
        await cancellation;
      } catch {
        /* connection may already be closing */
      }
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
    const goal = goalCapability(initialized._meta);
    this.#capabilities = Object.freeze({
      protocol: initialized.protocolVersion,
      client: UNINITIALIZED_CAPABILITIES.client,
      agent: Object.freeze({ ...(initialized.agentCapabilities ?? {}) }),
      ...(initialized.agentInfo ? { agentInfo: Object.freeze({ ...initialized.agentInfo }) } : {}),
      authMethods: Object.freeze([...(initialized.authMethods ?? [])]),
      ...(goal ? { goal } : {}),
    });
  }

  async #openSession(): Promise<NewSessionResponse> {
    try {
      return await this.#restoreSession();
    } catch (cause) {
      if (isAuthRequired(cause)) {
        await this.#authenticate();
        return this.#restoreSession();
      }
      if (!isResourceNotFound(cause)) throw cause;
      this.#sessionId = undefined;
    }
    try {
      return await this.#newSession();
    } catch (cause) {
      if (!isAuthRequired(cause)) throw cause;
      await this.#authenticate();
      return this.#newSession();
    }
  }

  async #restoreSession(): Promise<NewSessionResponse> {
    const sessionId = this.options.session.resumeSessionId;
    if (!sessionId) throw RequestError.resourceNotFound();
    const request = {
      sessionId,
      cwd: this.options.session.cwd.startsWith('/')
        ? this.options.session.cwd
        : resolve(this.options.session.cwd),
      mcpServers: [...(this.options.session.mcpServers ?? [])],
    };
    this.#sessionId = sessionId;
    const capabilities = this.#capabilities.agent;
    if (capabilities.sessionCapabilities?.resume) {
      const response = await withTimeout(
        this.#connection!.agent.request(methods.agent.session.resume, request),
        this.#limits.handshakeTimeoutMs,
        'HANDSHAKE_TIMEOUT',
        'ACP session/resume timed out',
      );
      return { sessionId, ...(response ?? {}) };
    }
    if (capabilities.loadSession) {
      await withTimeout(
        this.#connection!.agent.request(methods.agent.session.load, request),
        this.#limits.handshakeTimeoutMs,
        'HANDSHAKE_TIMEOUT',
        'ACP session/load timed out',
      );
      return { sessionId };
    }
    throw RequestError.resourceNotFound();
  }

  #newSession(): Promise<NewSessionResponse> {
    return withTimeout(
      this.#connection!.agent.request(methods.agent.session.new, {
        cwd: this.options.session.cwd.startsWith('/')
          ? this.options.session.cwd
          : resolve(this.options.session.cwd),
        mcpServers: [...(this.options.session.mcpServers ?? [])],
      }),
      this.#limits.handshakeTimeoutMs,
      'HANDSHAKE_TIMEOUT',
      'ACP session/new timed out',
    );
  }

  async setGoal(objective: string): Promise<void> {
    const capability = this.#capabilities.goal;
    if (!this.#connection || !this.#sessionId || !capability?.actions.includes('set'))
      throw new Error('Agent 未声明 goal set 能力');
    await withTimeout(
      this.#connection.agent.request<Record<string, never>, AgentGoalRequest>(
        capability.controlMethod,
        {
          sessionId: this.#sessionId,
          action: 'set',
          objective,
        },
      ),
      this.#limits.requestTimeoutMs,
      'REQUEST_TIMEOUT',
      'ACP goal set timed out',
    );
  }

  async clearGoal(): Promise<void> {
    const capability = this.#capabilities.goal;
    if (!this.#connection || !this.#sessionId || !capability?.actions.includes('clear')) return;
    await withTimeout(
      this.#connection.agent.request<Record<string, never>, AgentGoalRequest>(
        capability.controlMethod,
        {
          sessionId: this.#sessionId,
          action: 'clear',
        },
      ),
      15_000,
      'REQUEST_TIMEOUT',
      'ACP goal clear timed out',
    );
  }

  async #authenticate(): Promise<void> {
    const supported = this.#capabilities.authMethods.filter(
      (method) => !('type' in method) || method.type !== 'terminal',
    );
    const configured = this.options.session.authMethodId;
    const selected = configured
      ? supported.find((method) => method.id === configured)
      : supported.length === 1
        ? supported[0]
        : undefined;
    if (!selected) {
      const available = supported.map((method) => method.id).join(', ') || 'none';
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
    if (this.options.session.requestPermission)
      return this.options.session.requestPermission(request);
    const reject = request.options.find(
      (option) => option.kind === 'reject_once' || option.kind === 'reject_always',
    );
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  #attachProcess(child: ChildProcessLike): void {
    this.#exitPromise = new Promise((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
    child.stderr.on('data', (chunk) => {
      const value = this.#stderr.push(chunk as Buffer);
      if (value.accepted || value.droppedBytes)
        this.emit('stderr', { chunk: value.accepted, droppedBytes: value.droppedBytes });
    });
    child.on('error', (cause) =>
      this.#fail(asTransportError(cause, 'SPAWN_FAILED', 'Agent process error'), false),
    );
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      this.#onExit(code, signal),
    );
  }

  #guardedInput(child: ChildProcessLike): ReadableStream<Uint8Array> {
    const decoder = new JsonLineDecoder(this.#limits.maxFrameBytes);
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on('data', (chunk) => {
          try {
            for (const message of decoder.push(Buffer.from(chunk))) {
              this.#recordTrace('agent_to_client', message);
              if (
                'result' in message &&
                message.result &&
                typeof message.result === 'object' &&
                'sessionId' in message.result &&
                'models' in message.result
              ) {
                const models = LegacyModelsSchema.safeParse(message.result.models);
                if (models.success) this.#legacyModels = models.data;
              }
              controller.enqueue(Buffer.from(`${JSON.stringify(message)}\n`));
            }
          } catch (cause) {
            const error = asTransportError(
              cause,
              'PROTOCOL_INVALID_FRAME',
              'Invalid ACP JSON-RPC frame',
            );
            this.#fail(error, true);
            controller.error(error);
          }
        });
        child.stdout.on('end', () => {
          try {
            decoder.end();
            controller.close();
          } catch (cause) {
            const error = asTransportError(
              cause,
              'PROTOCOL_INVALID_FRAME',
              'Incomplete ACP JSON-RPC frame',
            );
            this.#fail(error, true);
            controller.error(error);
          }
        });
        child.stdout.on('error', (cause) => {
          const error = asTransportError(cause, 'TRANSPORT_CLOSED', 'Unable to read Agent stdout');
          this.#fail(error, true);
          controller.error(error);
        });
      },
    });
  }

  #guardedOutput(child: ChildProcessLike): WritableStream<Uint8Array> {
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const decoder = new JsonLineDecoder(this.#limits.maxFrameBytes);
    const guard = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        try {
          for (const message of decoder.push(Buffer.from(chunk)))
            this.#recordTrace('client_to_agent', message);
          controller.enqueue(chunk);
        } catch (cause) {
          const error = asTransportError(
            cause,
            'PROTOCOL_INVALID_FRAME',
            'Invalid outbound ACP JSON-RPC frame',
          );
          this.#fail(error, true);
          throw error;
        }
      },
      flush: () => decoder.end(),
    });
    void guard.readable.pipeTo(output).catch((cause) => {
      if (!['closed', 'stopping', 'draining'].includes(this.#state)) {
        this.#fail(
          asTransportError(cause, 'WRITE_BACKPRESSURE', 'Unable to write ACP message'),
          true,
        );
      }
    });
    return guard.writable;
  }

  #recordTrace(direction: AgentProtocolTrace['direction'], message: JsonRpcMessage): void {
    let trace: AgentProtocolTrace;
    if ('method' in message) {
      const id = 'id' in message ? message.id : undefined;
      const update =
        message.method === methods.client.session.update &&
        message.params &&
        typeof message.params === 'object' &&
        'update' in message.params &&
        message.params.update &&
        typeof message.params.update === 'object' &&
        'sessionUpdate' in message.params.update &&
        typeof message.params.update.sessionUpdate === 'string'
          ? message.params.update.sessionUpdate
          : undefined;
      trace = {
        at: new Date().toISOString(),
        direction,
        kind: id === undefined ? 'notification' : 'request',
        ...(id === undefined ? {} : { id }),
        method: message.method,
        ...(update ? { update } : {}),
      };
      if (id !== undefined)
        this.#pendingMethods.set(traceKey(oppositeDirection(direction), id), message.method);
    } else {
      const key = traceKey(direction, message.id);
      const method = this.#pendingMethods.get(key);
      this.#pendingMethods.delete(key);
      trace = {
        at: new Date().toISOString(),
        direction,
        kind: 'response',
        id: message.id,
        ...(method ? { method } : {}),
        outcome: message.error ? 'error' : 'result',
      };
    }
    this.#trace.push(Object.freeze(trace));
    if (this.#trace.length > 200) this.#trace.shift();
    this.emit('trace', trace);
  }

  #fail(error: AgentTransportError, terminate: boolean): void {
    if (this.#state === 'closed') return;
    this.#failure ??= error;
    if (this.#state !== 'failed' && ALLOWED_TRANSITIONS[this.#state].includes('failed'))
      this.#transition('failed');
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
    this.#fail(
      new AgentTransportError('TRANSPORT_CLOSED', 'ACP connection closed unexpectedly'),
      true,
    );
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = ['draining', 'stopping', 'failed'].includes(this.#state);
    const error = new AgentTransportError('PROCESS_EXITED', 'Agent process exited', {
      code,
      signal,
      expected,
    });
    this.#connection?.close(error);
    if (!expected) this.emit('protocolError', error);
    if (this.#state !== 'closed' && ALLOWED_TRANSITIONS[this.#state].includes('closed'))
      this.#transition('closed');
    this.#resolveExit?.();
  }

  #terminate(signal: NodeJS.Signals): void {
    if (this.#child) this.#killTree(this.#child, signal);
  }

  async #waitForExit(timeoutMs: number): Promise<void> {
    if (!this.#exitPromise || this.#state === 'closed') return;
    await Promise.race([
      this.#exitPromise,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, timeoutMs)),
    ]);
  }

  #transition(next: TransportState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].includes(next))
      throw this.#invalidState(`transition to ${next}`);
    const previous = this.#state;
    this.#state = next;
    this.emit('state', { previous, current: next });
  }

  #invalidState(operation: string): AgentTransportError {
    return new AgentTransportError(
      'INVALID_STATE',
      `Cannot ${operation} while transport is ${this.#state}`,
      {
        operation,
        state: this.#state,
      },
    );
  }
}

function traceKey(direction: AgentProtocolTrace['direction'], id: string | number | null): string {
  return `${direction}:${typeof id}:${String(id)}`;
}

function oppositeDirection(
  direction: AgentProtocolTrace['direction'],
): AgentProtocolTrace['direction'] {
  return direction === 'client_to_agent' ? 'agent_to_client' : 'client_to_agent';
}

function goalCapability(meta: unknown): AgentGoalCapability | undefined {
  if (!meta || typeof meta !== 'object') return;
  const goal = (meta as Record<string, unknown>).goal;
  if (!goal || typeof goal !== 'object') return;
  const value = goal as Record<string, unknown>;
  if (value.version !== 1 || typeof value.controlMethod !== 'string') return;
  if (!Array.isArray(value.actions)) return;
  const actions = value.actions.filter(
    (action): action is 'set' | 'clear' => action === 'set' || action === 'clear',
  );
  if (!actions.length) return;
  return Object.freeze({
    version: 1,
    controlMethod: value.controlMethod,
    actions: Object.freeze(actions),
  });
}

function goalFromUpdate(update: unknown): AgentGoalSnapshot | null | undefined {
  if (!update || typeof update !== 'object') return;
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, 'goal'))
    return;
  const goal = (meta as Record<string, unknown>).goal;
  if (goal === null) return null;
  if (!goal || typeof goal !== 'object') return;
  const value = goal as Record<string, unknown>;
  const statuses = ['active', 'paused', 'blocked', 'limited', 'complete'] as const;
  if (
    typeof value.objective !== 'string' ||
    !statuses.includes(value.status as (typeof statuses)[number]) ||
    typeof value.controlMethod !== 'string'
  )
    return;
  return Object.freeze({
    objective: value.objective,
    status: value.status as AgentGoalSnapshot['status'],
    ...(typeof value.iterations === 'number' ? { iterations: value.iterations } : {}),
    ...(typeof value.lastReason === 'string' || value.lastReason === null
      ? { lastReason: value.lastReason }
      : {}),
    ...(typeof value.createdAt === 'number' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.tokenBudget === 'number' || value.tokenBudget === null
      ? { tokenBudget: value.tokenBudget }
      : {}),
    ...(typeof value.tokensUsed === 'number' ? { tokensUsed: value.tokensUsed } : {}),
    ...(typeof value.timeUsedSeconds === 'number'
      ? { timeUsedSeconds: value.timeUsedSeconds }
      : {}),
    controlMethod: value.controlMethod,
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
    const timer = setTimeout(
      () => rejectPromise(new AgentTransportError(code, message, { timeoutMs })),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.code === -32000 &&
    error.message.startsWith('Authentication required')
  );
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32002;
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
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
