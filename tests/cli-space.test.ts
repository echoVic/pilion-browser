import { Socket, createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSpaceError, SPACE_MESSAGES } from '../src/main/external/space-protocol.js';
import { callControl, ExternalCallError } from '../src/main/external/client.js';

vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  createConnection: vi.fn(),
}));

describe('control client protocol with an injected socket transport', () => {
  afterEach(() => vi.restoreAllMocks());

  function transport(onWrite: (frame: Record<string, unknown>, socket: Socket) => void) {
    const socket = new Socket();
    vi.mocked(createConnection).mockReturnValue(socket);
    vi.spyOn(socket, 'write').mockImplementation((chunk) => {
      onWrite(JSON.parse(String(chunk).trim()), socket);
      return true;
    });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }

  it('sends base hello before control, ignores unrelated ids and returns the matching result', async () => {
    const frames: Record<string, unknown>[] = [];
    const socket = transport((frame, sock) => {
      frames.push(frame);
      queueMicrotask(() => sock.emit('data', Buffer.from(
        frame.id
          ? `${JSON.stringify({ id: 'other', result: 'wrong' })}\n${JSON.stringify({ id: frame.id, result: { spaceId: 'agent-1' } })}\n`
          : '{"version":"1.2.3"}\n',
      )));
    });
    await expect(callControl(
      { socketPath: '/unused', token: 'test-token', space: 'agent-ended' },
      { op: 'space.create', label: '比价' },
    )).resolves.toEqual({ spaceId: 'agent-1' });
    expect(frames).toEqual([
      { token: 'test-token' },
      { id: expect.any(String), control: { op: 'space.create', label: '比价' } },
    ]);
    expect(socket.destroyed).toBe(true);
  });

  it.each(['hello', 'control'])('preserves Space diagnostics on a %s error', async (stage) => {
    transport((frame, socket) => {
      const error = { error: SPACE_MESSAGES.SPACE_ENDED, code: 'SPACE_ENDED', details: 'private' };
      queueMicrotask(() => socket.emit('data', Buffer.from(
        JSON.stringify(!frame.id && stage === 'control' ? {} : { ...error, ...(frame.id ? { id: frame.id } : {}) }) + '\n',
      )));
    });
    await expect(callControl({ socketPath: '/unused', token: 'test-token' }, { op: 'space.list' }))
      .rejects.toMatchObject({ code: 'SPACE_ENDED', message: SPACE_MESSAGES.SPACE_ENDED });
  });

  it.each(['null', '[]', '{oops'])('rejects malformed responses: %s', async (line) => {
    transport((_frame, socket) => queueMicrotask(() => socket.emit('data', Buffer.from(`${line}\n`))));
    await expect(callControl({ socketPath: '/unused', token: 'test-token' }, { op: 'space.list' }))
      .rejects.toMatchObject({ code: 'PILION_EXTERNAL_MALFORMED_RESPONSE' });
  });

  it('bounds the response buffer', async () => {
    transport((_frame, socket) => queueMicrotask(() => socket.emit('data', Buffer.alloc(1024 * 1024 + 1))));
    await expect(callControl({ socketPath: '/unused', token: 'test-token' }, { op: 'space.list' }))
      .rejects.toMatchObject({ code: 'PILION_EXTERNAL_RESPONSE_LIMIT' });
  });

  it('marks a control outcome unknown when its connection closes after dispatch', async () => {
    transport((frame, socket) => queueMicrotask(() => {
      if (frame.id) socket.emit('end');
      else socket.emit('data', Buffer.from('{}\n'));
    }));
    await expect(callControl({ socketPath: '/unused', token: 'test-token' }, { op: 'space.close', spaceId: 'agent-1' }))
      .rejects.toMatchObject({ code: 'PILION_EXTERNAL_CONNECTION_CLOSED', outcome: 'unknown' });
  });
});

describe('space error handling in CLI', () => {
  it('ExternalCallError with SPACE_ENDED code surfaces the right message', () => {
    const err = new ExternalCallError(SPACE_MESSAGES.SPACE_ENDED, { code: 'SPACE_ENDED' });
    expect(err.code).toBe('SPACE_ENDED');
    expect(err.message).toBe(SPACE_MESSAGES.SPACE_ENDED);
  });

  it('AgentSpaceError and ExternalCallError carry the same message for SPACE_NOT_FOUND', () => {
    const a = new AgentSpaceError('SPACE_NOT_FOUND');
    const b = new ExternalCallError(SPACE_MESSAGES.SPACE_NOT_FOUND, { code: 'SPACE_NOT_FOUND' });
    expect(a.message).toBe(b.message);
  });
});
