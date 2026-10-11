import { BrowserError } from '../browser/errors.js';
import { HostError } from './types.js';

export function executionFailureResult(error: unknown): {
  error: { code?: string; message: string };
} {
  return {
    error: {
      ...(error instanceof BrowserError || error instanceof HostError ? { code: error.code } : {}),
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    },
  };
}
