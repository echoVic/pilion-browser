import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/main/browser/errors.js';
import { printError, type CliIo } from '../src/main/external/cli/output.js';

function output(error: unknown, json = true) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  printError(io, json, error as Error | string);
  return { stdout, stderr };
}

describe('CLI error output', () => {
  it('preserves BrowserError diagnostics without details or stack', () => {
    const error = new BrowserError('STALE_ELEMENT', 'observe again', true, {
      token: 'must-not-leak',
    });
    Object.assign(error, { outcome: 'unknown' });
    expect(output(error)).toEqual({
      stdout: [
        '{"error":"observe again","code":"STALE_ELEMENT","retryable":true,"outcome":"unknown"}',
      ],
      stderr: [],
    });
  });

  it('preserves retryable false without adding an outcome', () => {
    expect(JSON.parse(output(new BrowserError('PERMISSION_DENIED', 'denied')).stdout[0]!)).toEqual({
      error: 'denied',
      code: 'PERMISSION_DENIED',
      retryable: false,
    });
  });

  it.each(['legacy error', new Error('legacy error')])('keeps plain errors compatible', (error) => {
    expect(output(error)).toEqual({ stdout: ['{"error":"legacy error"}'], stderr: [] });
  });

  it.each([
    [42, '42'],
    [null, 'null'],
  ])('keeps non-Error thrown values as string errors', (value, message) => {
    expect(JSON.parse(output(value).stdout[0]!)).toEqual({ error: message });
  });

  it.each([
    { code: 'X'.repeat(65), retryable: 'true', outcome: 'safe' },
    { code: 'unsafe\ncode', retryable: 1, outcome: 'failed' },
    { code: 'UNSAFE\n', retryable: 'true', outcome: 'safe' },
    { code: { nested: true }, retryable: null, outcome: { nested: true } },
  ])('ignores malformed or unbounded diagnostics', (fields) => {
    const error = Object.assign(new Error('failed'), fields, { details: { secret: 'hidden' } });
    expect(output(error)).toEqual({ stdout: ['{"error":"failed"}'], stderr: [] });
  });

  it('keeps text mode on stderr with only the message', () => {
    expect(output(new BrowserError('STALE_ELEMENT', 'observe again', true), false)).toEqual({
      stdout: [],
      stderr: ['observe again'],
    });
  });
});
