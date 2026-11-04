import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callControl, callTool, handshake } from '../src/main/external/client.js';

const REQUEST = { name: 'browser.click' as const, args: {} };

describe('external client error preservation', () => {
  let dir: string;
  let server: Server | undefined;
  let sockets: Set<Socket>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pec-'));
    sockets = new Set();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function endpoint(onFrame: (socket: Socket, frame: Record<string, unknown>) => void) {
    const socketPath = join(dir, 'test.sock');
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) onFrame(socket, JSON.parse(line));
          newline = buffer.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    return { socketPath, token: randomUUID() };
  }

  async function rejected(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
    const result = await promise.then(
      () => {
        throw new Error('Expected rejection');
      },
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    return result as Error & Record<string, unknown>;
  }

  it('callTool includes the chosen space in hello', async () => {
    const hellos: object[] = [];
    const ep = await endpoint((socket, frame) => {
      if (!frame.id) hellos.push(frame);
      socket.write(`${JSON.stringify(frame.id ? { id: frame.id, result: { ok: true } } : {})}\n`);
    });
    await expect(callTool({ ...ep, space: 'agent-1' }, REQUEST)).resolves.toEqual({ ok: true });
    expect(hellos).toEqual([{ token: ep.token, space: 'agent-1' }]);
  });

  it('callControl sends a base hello and control frame without a tool request', async () => {
    const frames: Record<string, unknown>[] = [];
    const ep = await endpoint((socket, frame) => {
      frames.push(frame);
      socket.write(`${JSON.stringify(frame.id ? { id: frame.id, result: { spaceId: 'agent-1' } } : { version: '1.2.3' })}\n`);
    });
    await expect(callControl({ ...ep, space: 'agent-stale' }, { op: 'space.create', label: '比价' })).resolves.toEqual({ spaceId: 'agent-1' });
    expect(frames[0]).toEqual({ token: ep.token });
    expect(frames[1]).toEqual({ id: expect.any(String), control: { op: 'space.create', label: '比价' } });
  });

  it('callControl preserves Space error diagnostics on the wire', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(`${JSON.stringify(frame.id ? { id: frame.id, error: 'Space 已结束，请用 pilion space new 新建', code: 'SPACE_ENDED' } : {})}\n`);
    });
    const error = await rejected(callControl(ep, { op: 'space.close', spaceId: 'agent-1' }));
    expect(error).toMatchObject({ code: 'SPACE_ENDED', message: 'Space 已结束，请用 pilion space new 新建' });
  });

  it('preserves typed server error fields without arbitrary details', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(
        `${JSON.stringify(
          frame.id
            ? {
                id: frame.id,
                error: 'observe again',
                code: 'STALE_ELEMENT',
                retryable: true,
                outcome: 'unknown',
                details: { secret: 'must-not-leak' },
              }
            : {},
        )}\n`,
      );
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error).toMatchObject({
      name: 'ExternalCallError',
      message: 'observe again',
      code: 'STALE_ELEMENT',
      retryable: true,
      outcome: 'unknown',
    });
    expect(error).not.toHaveProperty('details');
  });

  it('preserves retryable false without inferring an outcome', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(
        `${JSON.stringify(
          frame.id
            ? { id: frame.id, error: 'denied', code: 'PERMISSION_DENIED', retryable: false }
            : {},
        )}\n`,
      );
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error).toMatchObject({ message: 'denied', code: 'PERMISSION_DENIED', retryable: false });
    expect(error).not.toHaveProperty('outcome');
  });

  it('keeps old message-only failures compatible', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(`${JSON.stringify(frame.id ? { id: frame.id, error: 'legacy' } : {})}\n`);
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error.message).toBe('legacy');
    for (const field of ['code', 'retryable', 'outcome']) expect(error).not.toHaveProperty(field);
  });

  it('drops invalid diagnostic fields from a response', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(
        `${JSON.stringify(
          frame.id
            ? {
                id: frame.id,
                error: 'bad diagnostics',
                code: 'X'.repeat(65),
                retryable: 'true',
                outcome: 'failed',
              }
            : {},
        )}\n`,
      );
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error.message).toBe('bad diagnostics');
    for (const field of ['code', 'retryable', 'outcome']) expect(error).not.toHaveProperty(field);
  });

  it.each(['call', 'handshake'])(
    'preserves auth diagnostics before dispatch for %s',
    async (method) => {
      let requests = 0;
      const ep = await endpoint((socket, frame) => {
        if (frame.id) requests += 1;
        socket.end('{"error":"authentication failed","code":"AUTH_FAILED","retryable":false}\n');
      });
      const error = await rejected(method === 'call' ? callTool(ep, REQUEST) : handshake(ep));
      expect(error).toMatchObject({
        message: 'authentication failed',
        code: 'AUTH_FAILED',
        retryable: false,
      });
      expect(error).not.toHaveProperty('outcome');
      expect(requests).toBe(0);
    },
  );

  it.each([false, true])(
    'marks a closed connection unknown only after dispatch=%s',
    async (ack) => {
      let requests = 0;
      const ep = await endpoint((socket, frame) => {
        if (!frame.id && ack) socket.write('{}\n');
        else {
          if (frame.id) requests += 1;
          socket.end();
        }
      });
      const error = await rejected(callTool(ep, REQUEST));
      expect(error.code).toBe('PILION_EXTERNAL_CONNECTION_CLOSED');
      expect(error.outcome).toBe(ack ? 'unknown' : undefined);
      expect(error).not.toHaveProperty('retryable');
      expect(requests).toBe(ack ? 1 : 0);
    },
  );

  it.each([false, true])('marks a socket timeout unknown only after dispatch=%s', async (ack) => {
    // Real sockets/handshake; shorten only this client's 90-second inactivity timeout.
    const original = Socket.prototype.setTimeout;
    vi.spyOn(Socket.prototype, 'setTimeout').mockImplementation(function (
      this: Socket,
      timeout,
      callback,
    ) {
      return original.call(this, timeout === 90_000 ? 100 : timeout, callback);
    });
    let requests = 0;
    const ep = await endpoint((socket, frame) => {
      if (!frame.id && ack) socket.write('{}\n');
      if (frame.id) requests += 1;
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error).toMatchObject({
      message: 'Pilion external call timed out',
      code: 'PILION_EXTERNAL_TIMEOUT',
    });
    expect(error.outcome).toBe(ack ? 'unknown' : undefined);
    expect(error).not.toHaveProperty('retryable');
    expect(requests).toBe(ack ? 1 : 0);
  });

  it('reports the existing response limit with unknown outcome after dispatch', async () => {
    let requests = 0;
    const ep = await endpoint((socket, frame) => {
      if (!frame.id) socket.write('{}\n');
      else {
        requests += 1;
        socket.end(`${JSON.stringify({ id: frame.id, result: 'x'.repeat(1024 * 1024) })}\n`);
      }
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error).toMatchObject({
      code: 'PILION_EXTERNAL_RESPONSE_LIMIT',
      outcome: 'unknown',
    });
    expect(error).not.toHaveProperty('retryable');
    expect(requests).toBe(1);
  });

  it.each([false, true])('marks a malformed frame unknown only after dispatch=%s', async (ack) => {
    const ep = await endpoint((socket, frame) => {
      if (!frame.id && ack) socket.write('{}\n');
      else socket.end('null\n');
    });
    const error = await rejected(callTool(ep, REQUEST));
    expect(error).toMatchObject({ code: 'PILION_EXTERNAL_MALFORMED_RESPONSE' });
    expect(error.outcome).toBe(ack ? 'unknown' : undefined);
    expect(error).not.toHaveProperty('retryable');
  });

  it('keeps successful replies and handshake version unchanged', async () => {
    const ep = await endpoint((socket, frame) => {
      socket.write(
        `${JSON.stringify(frame.id ? { id: frame.id, result: { ok: true } } : { version: '1.2.3' })}\n`,
      );
    });
    await expect(handshake(ep)).resolves.toEqual({ version: '1.2.3' });
    await expect(callTool(ep, REQUEST)).resolves.toEqual({ ok: true });
  });
});
