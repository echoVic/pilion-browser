export type BrowserErrorCode =
  | 'TAB_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'DANGEROUS_URL'
  | 'PRIVATE_NETWORK_BLOCKED'
  | 'STALE_ELEMENT'
  | 'GRANT_REQUIRED'
  | 'INVALID_GRANT'
  | 'PREPARATION_NOT_FOUND'
  | 'EXECUTION_TOKEN_USED'
  | 'STALE_FENCING_TOKEN'
  | 'PREPARATION_EXPIRED'
  | 'UNSUPPORTED_ELEMENT'
  | 'OPTION_NOT_FOUND'
  | 'KEY_NOT_ALLOWED'
  | 'INTERNAL_ERROR';

export class BrowserError extends Error {
  readonly name = 'BrowserError';

  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  return new BrowserError('INTERNAL_ERROR', 'Browser operation failed', false, {
    cause: error instanceof Error ? error.message : String(error),
  });
}
