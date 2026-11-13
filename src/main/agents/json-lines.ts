import { AgentTransportError } from './errors.js';
import type { JsonRpcMessage } from './types.js';

/**
 * Text a launcher may print on stdout before the Agent speaks ACP, such as a remote shell's
 * login banner from `.bashrc`. It is tolerated only before the first valid frame, and only this much.
 */
export interface LeadingNoiseLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  /** Receives each tolerated line, so it can be kept for diagnosis. */
  readonly onNoise: (line: string) => void;
}

/**
 * preamble ──first valid frame──▶ framed
 *
 * In `preamble` a line that is not JSON is noise, within LeadingNoiseLimits; in `framed` it is a
 * protocol error. A decoder without noise limits starts `framed`.
 */
type DecoderPhase = 'preamble' | 'framed';

export class JsonLineDecoder {
  // Chunks of the line still waiting for its newline. Joined once per line, not once per chunk,
  // so a large frame arriving in many small chunks is not copied over and over.
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #phase: DecoderPhase;
  #noiseLines = 0;
  #noiseBytes = 0;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly leadingNoise?: LeadingNoiseLimits,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 16)
      throw new RangeError('maxFrameBytes must be >= 16');
    this.#phase = leadingNoise ? 'preamble' : 'framed';
  }

  push(chunk: Buffer | string): JsonRpcMessage[] {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) {
        if (data.length) {
          this.#pending.push(data);
          this.#pendingBytes += data.length;
        }
        if (this.#pendingBytes > this.maxFrameBytes) this.#tooLarge(this.#pendingBytes);
        return messages;
      }
      const lineBytes = this.#pendingBytes + newline;
      if (lineBytes > this.maxFrameBytes) this.#tooLarge(lineBytes);
      let frame = this.#pending.length
        ? Buffer.concat([...this.#pending, data.subarray(0, newline)], lineBytes)
        : data.subarray(0, newline);
      this.#pending = [];
      this.#pendingBytes = 0;
      data = data.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      const text = frame.toString('utf8');
      // A blank line carries nothing; the ACP SDK skips it too.
      if (!text.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (cause) {
        if (this.#acceptNoise(text, frame.length)) continue;
        throw new AgentTransportError(
          'PROTOCOL_INVALID_FRAME',
          'Frame is not valid JSON',
          undefined,
          { cause },
        );
      }
      if (!isMessage(value))
        throw new AgentTransportError(
          'PROTOCOL_INVALID_FRAME',
          'Frame is not a JSON-RPC 2.0 message',
        );
      this.#phase = 'framed';
      messages.push(value);
    }
  }

  end(): void {
    if (this.#pendingBytes)
      throw new AgentTransportError(
        'PROTOCOL_INVALID_FRAME',
        'stdout ended with an incomplete frame',
      );
  }

  #acceptNoise(line: string, bytes: number): boolean {
    if (this.#phase !== 'preamble' || !this.leadingNoise) return false;
    this.#noiseLines += 1;
    this.#noiseBytes += bytes;
    if (
      this.#noiseLines > this.leadingNoise.maxLines ||
      this.#noiseBytes > this.leadingNoise.maxBytes
    )
      throw new AgentTransportError(
        'PROTOCOL_INVALID_FRAME',
        'Agent printed too much non-JSON output before its first ACP frame',
        { lines: this.#noiseLines, bytes: this.#noiseBytes },
      );
    this.leadingNoise.onNoise(line);
    return true;
  }

  #tooLarge(bytes: number): never {
    throw new AgentTransportError(
      'PROTOCOL_FRAME_TOO_LARGE',
      'JSON-RPC frame exceeds configured limit',
      {
        bytes,
        maxFrameBytes: this.maxFrameBytes,
      },
    );
  }
}

function validId(value: unknown): value is string | number | null {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
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
