import { describe, expect, it } from 'vitest';
import { JsonLineDecoder } from '../src/main/agents/json-lines';

const frame = (id: number) => `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;

describe('JsonLineDecoder', () => {
  it('skips blank lines anywhere in the stream, as the ACP SDK does', () => {
    const decoder = new JsonLineDecoder(1024);
    expect(decoder.push(`\n${frame(1)}\r\n   \n${frame(2)}`)).toEqual([
      JSON.parse(frame(1)),
      JSON.parse(frame(2)),
    ]);
  });

  it('assembles a frame split over many chunks and still enforces the cap on the whole line', () => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 'A'.repeat(64 * 1024) } });
    const decoder = new JsonLineDecoder(128 * 1024);
    const chunks = text.match(/[\s\S]{1,100}/g) ?? [];
    for (const chunk of chunks) expect(decoder.push(chunk)).toEqual([]);
    expect(decoder.push('\n')).toEqual([JSON.parse(text)]);

    const capped = new JsonLineDecoder(1024);
    expect(() => {
      for (let index = 0; index < 20; index += 1) capped.push('x'.repeat(100));
    }).toThrow(expect.objectContaining({ code: 'PROTOCOL_FRAME_TOO_LARGE' }));
  });

  it('tolerates non-JSON only before the first frame, within its budget', () => {
    const noise: string[] = [];
    const decoder = new JsonLineDecoder(1024, {
      maxLines: 2,
      maxBytes: 64,
      onNoise: (line) => noise.push(line),
    });
    expect(decoder.push(`motd\r\nhello\n${frame(1)}`)).toHaveLength(1);
    expect(noise).toEqual(['motd', 'hello']);
    expect(() => decoder.push('late noise\n')).toThrow(
      expect.objectContaining({
        code: 'PROTOCOL_INVALID_FRAME',
        message: 'Frame is not valid JSON',
      }),
    );

    const tooMany = new JsonLineDecoder(1024, { maxLines: 2, maxBytes: 64, onNoise: () => {} });
    expect(() => tooMany.push('a\nb\nc\n')).toThrow(/before its first ACP frame/);
    const tooBig = new JsonLineDecoder(1024, { maxLines: 2, maxBytes: 64, onNoise: () => {} });
    expect(() => tooBig.push(`${'b'.repeat(65)}\n`)).toThrow(/before its first ACP frame/);
  });

  it('never treats JSON that is not JSON-RPC as noise', () => {
    const decoder = new JsonLineDecoder(1024, { maxLines: 20, maxBytes: 1024, onNoise: () => {} });
    expect(() => decoder.push('{"banner":true}\n')).toThrow('Frame is not a JSON-RPC 2.0 message');
  });

  it('without a noise budget, rejects the first non-JSON line', () => {
    expect(() => new JsonLineDecoder(1024).push('motd\n')).toThrow('Frame is not valid JSON');
  });

  it('reports a stream that ends mid-frame', () => {
    const decoder = new JsonLineDecoder(1024);
    decoder.push('{"jsonrpc":');
    expect(() => decoder.end()).toThrow('stdout ended with an incomplete frame');
  });
});
