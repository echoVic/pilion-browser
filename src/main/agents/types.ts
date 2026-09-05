import type { Readable, Writable } from 'node:stream';

export const DRAFT_PROTOCOL_VERSION = 'pilion-acp-draft-1' as const;

export type TransportState =
  | 'idle'
  | 'spawning'
  | 'handshaking'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'closed'
  | 'failed';

export type CapabilitySupport = 'native' | 'emulated' | 'unsupported' | 'unsafe';

export interface CapabilitySnapshot {
  readonly protocol: typeof DRAFT_PROTOCOL_VERSION;
  readonly capturedAt: string;
  readonly matrix: Readonly<Record<string, CapabilitySupport>>;
}

export interface AgentLaunchConfig {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Only configurations issued by AgentTrustStore can be launched. */
export interface TrustedAgentConfig extends AgentLaunchConfig {
  readonly trustId: string;
}

export interface TransportLimits {
  readonly maxFrameBytes: number;
  readonly writeHighWaterBytes: number;
  readonly writeLowWaterBytes: number;
  readonly stderrMaxBytes: number;
  readonly stderrRateBytesPerSecond: number;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly terminateTimeoutMs: number;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ChildProcessLike {
  readonly pid?: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnAgent = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
    detached: boolean;
    windowsHide: true;
  },
) => ChildProcessLike;

export interface TransportEventMap {
  state: { previous: TransportState; current: TransportState };
  notification: JsonRpcNotification;
  request: JsonRpcRequest;
  protocolError: import('./errors.js').AgentTransportError;
  stderr: { chunk: string; droppedBytes: number };
  backpressure: { queuedBytes: number; active: boolean };
}
