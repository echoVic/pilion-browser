import { AgentTransportError } from './errors.js';
import type { JsonRpcMessage } from './types.js';

export class JsonLineDecoder {
  #buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 16) throw new RangeError('maxFrameBytes must be >= 16');
  }

  push(chunk: Buffer | string): JsonRpcMessage[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.maxFrameBytes) this.#tooLarge(this.#buffer.length);
        return messages;
      }
      if (newline > this.maxFrameBytes) this.#tooLarge(newline);
      let frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (!frame.length) throw new AgentTransportError('PROTOCOL_INVALID_FRAME', 'Empty JSON-RPC frame');
      let value: unknown;
      try {
        value = JSON.parse(frame.toString('utf8'));
      } catch (cause) {
        throw new AgentTransportError('PROTOCOL_INVALID_FRAME', 'Frame is not valid JSON', undefined, { cause });
      }
      if (!isMessage(value)) throw new AgentTransportError('PROTOCOL_INVALID_FRAME', 'Frame is not a JSON-RPC 2.0 message');
      messages.push(value);
    }
  }

  end(): void {
    if (this.#buffer.length) throw new AgentTransportError('PROTOCOL_INVALID_FRAME', 'stdout ended with an incomplete frame');
  }

  #tooLarge(bytes: number): never {
    throw new AgentTransportError('PROTOCOL_FRAME_TOO_LARGE', 'JSON-RPC frame exceeds configured limit', {
      bytes,
      maxFrameBytes: this.maxFrameBytes,
    });
  }
}

function validId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isMessage(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;
  if (typeof message.method === 'string') return message.id === undefined || validId(message.id);
  if (!validId(message.id)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = message.error as Record<string, unknown> | null;
  return !!error && typeof error.code === 'number' && typeof error.message === 'string';
}
