import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserMcpServer } from './browser-mcp-server.js';
import { ToolRequestSchema, type ToolRequest } from '../../shared/contracts.js';

const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
/** Below every platform's sun_path limit (104 bytes on macOS, including the terminator). */
const MAX_SOCKET_PATH_BYTES = 96;
/** `<pid>-<random>.sock`: the pid lets a later start sweep sockets left by a crashed Pilion. */
const SOCKET_NAME = /^(\d+)-[0-9a-f]+\.sock$/;
const BridgeRequestSchema = z
  .object({
    token: z.string().min(32).max(256),
    id: z.string().uuid(),
    request: ToolRequestSchema,
  })
  .strict();

type BrowserMcpHostOptions = {
  directory: string;
  bridgePath: string;
  execute(request: ToolRequest): Promise<unknown>;
  /** Parent of the per-user socket directory used when `directory` is too long; os.tmpdir() by default. */
  socketRoot?: string;
  /** How long one bridge request may take, from connect to answer; 90 s by default. */
  requestTimeoutMs?: number;
};

/**
 * One bridge client. `executing` lasts while the tool runs; a disconnect or the timeout ends it
 * early, and the result that arrives afterwards is dropped (execute takes no cancel signal).
 * Bytes after the request line are ignored: one connection carries one request.
 *
 *   reading ──full frame──▶ executing ──answered──▶ done
 *      │                        │
 *      └──timeout, oversize, ───┴──timeout or client gone──▶ done
 *         or client gone
 */
type BridgeClientPhase = 'reading' | 'executing' | 'done';

/** Authenticated local endpoint used only by the stdio MCP bridge process. */
export class BrowserMcpHost {
  #server?: Server;
  #socketPath?: string;
  readonly #sockets = new Set<Socket>();
  readonly #token = randomBytes(32).toString('base64url');
  get socketPath(): string {
    if (!this.#socketPath) throw new Error('MCP host is not listening');
    return this.#socketPath;
  }

  constructor(private readonly options: BrowserMcpHostOptions) {}

  async start(remoteSocket?: string): Promise<McpServerStdio> {
    if (this.#server) throw new Error('Browser MCP host is already running');
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    this.#socketPath = await this.#chooseSocketPath();
    const server = createServer((socket) => {
      if (!remoteSocket) {
        this.#handle(socket);
        return;
      }
      this.#sockets.add(socket);
      const mcp = createBrowserMcpServer((name, args) =>
        this.options.execute(
          ToolRequestSchema.parse({ requestId: randomUUID(), name, args, timeoutMs: 60_000 }),
        ),
      );
      socket.on('error', () => {
        void mcp.close();
      });
      socket.once('close', () => {
        this.#sockets.delete(socket);
        void mcp.close();
      });
      void mcp
        .connect(
          new StdioServerTransport(socket, socket, { maxBufferSize: MAX_BRIDGE_FRAME_BYTES }),
        )
        .catch(() => socket.destroy());
    });
    this.#server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once('error', onError);
      server.listen(this.#socketPath, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    if (process.platform !== 'win32') await chmod(this.#socketPath, 0o600);
    if (remoteSocket)
      return { name: 'pilion-browser', command: 'nc', args: ['-U', remoteSocket], env: [] };
    return {
      name: 'pilion-browser',
      command: process.execPath,
      args: [this.options.bridgePath],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'PILION_BROWSER_MCP_SOCKET', value: this.#socketPath },
        { name: 'PILION_BROWSER_MCP_TOKEN', value: this.#token },
      ],
    };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    const socketPath = this.#socketPath;
    this.#server = undefined;
    this.#socketPath = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (socketPath && process.platform !== 'win32') {
      await rm(socketPath, { force: true });
    }
  }

  /**
   * The socket is created inside a directory only this user can enter, so it is never reachable
   * by anyone else, not even in the moment between listen() and chmod().
   */
  async #chooseSocketPath(): Promise<string> {
    if (process.platform === 'win32') return `\\\\.\\pipe\\pilion-browser-${randomUUID()}`;
    const name = `${process.pid}-${randomBytes(6).toString('hex')}.sock`;
    const preferred = join(this.options.directory, name);
    if (Buffer.byteLength(preferred) < MAX_SOCKET_PATH_BYTES) return preferred;
    // userData is too deep for a socket path on macOS, so the socket moves to a short private directory.
    const uid = process.getuid?.() ?? 0;
    const roots = [this.options.socketRoot ?? tmpdir(), '/tmp'];
    for (const root of roots) {
      const directory = join(root, `pilion-mcp-${uid}`);
      const path = join(directory, name);
      if (Buffer.byteLength(path) >= MAX_SOCKET_PATH_BYTES) continue;
      await privateDirectory(directory, uid);
      await sweepStaleSockets(directory);
      return path;
    }
    throw new Error('No socket directory short enough for the browser MCP host');
  }

  #handle(socket: Socket): void {
    this.#sockets.add(socket);
    let phase: BridgeClientPhase = 'reading';
    socket.once('close', () => {
      this.#sockets.delete(socket);
      phase = 'done';
    });
    socket.on('error', () => {
      phase = 'done';
    });
    let buffer = Buffer.alloc(0);
    let id: string | undefined;
    const answer = (body: Record<string, unknown>): void => {
      if (phase === 'done') return;
      phase = 'done';
      socket.end(`${JSON.stringify({ ...(id ? { id } : {}), ...body })}\n`);
    };
    // Counted from the client's last byte, so while a tool runs it is the time since the request
    // arrived. A tool that outlives it is answered with an error rather than holding the socket.
    socket.setTimeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, () =>
      answer({ error: 'Browser MCP host request timed out' }),
    );
    socket.on('data', (chunk) => {
      if (phase !== 'reading') return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_BRIDGE_FRAME_BYTES) {
        answer({ error: 'Browser MCP host request exceeded the frame limit' });
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      phase = 'executing';
      let request: ToolRequest;
      try {
        const parsed = BridgeRequestSchema.parse(
          JSON.parse(buffer.subarray(0, newline).toString()),
        );
        id = parsed.id;
        if (!sameSecret(parsed.token, this.#token))
          throw new Error('Browser MCP host authentication failed');
        request = parsed.request;
      } catch (error) {
        answer({ error: errorMessage(error) });
        return;
      }
      // Through a promise, so an execute that throws synchronously is still answered.
      void Promise.resolve(request)
        .then((value) => this.options.execute(value))
        .then(
          (result) => answer({ result }),
          (error: unknown) => answer({ error: errorMessage(error) }),
        );
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates the per-user socket directory, or accepts it only if it is a real directory of ours. */
async function privateDirectory(path: string, uid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid)
    throw new Error(
      `Refusing to use ${path} for the browser MCP socket: not a directory owned by you`,
    );
  // Ours but loosened: tighten it before anything is created inside.
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

/** Removes sockets whose Pilion process is gone; a live process, this one included, keeps its own. */
async function sweepStaleSockets(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    const pid = Number(SOCKET_NAME.exec(entry)?.[1]);
    if (!pid || processAlive(pid)) continue;
    await rm(join(directory, entry), { force: true }).catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
