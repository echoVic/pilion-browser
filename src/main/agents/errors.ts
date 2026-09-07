export type AgentErrorCode =
  | 'UNTRUSTED_CONFIG'
  | 'INVALID_STATE'
  | 'SPAWN_FAILED'
  | 'HANDSHAKE_FAILED'
  | 'HANDSHAKE_TIMEOUT'
  | 'PROTOCOL_INVALID_FRAME'
  | 'PROTOCOL_FRAME_TOO_LARGE'
  | 'WRITE_BACKPRESSURE'
  | 'REQUEST_TIMEOUT'
  | 'PROCESS_EXITED'
  | 'TRANSPORT_CLOSED';

export class AgentTransportError extends Error {
  readonly name = 'AgentTransportError';

  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): { code: AgentErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function asTransportError(error: unknown, code: AgentErrorCode, message: string): AgentTransportError {
  return error instanceof AgentTransportError
    ? error
    : new AgentTransportError(code, message, undefined, { cause: error });
}
