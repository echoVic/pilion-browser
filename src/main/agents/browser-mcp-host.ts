import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserMcpServer } from './browser-mcp-server.js';
import { ToolRequestSchema, type ToolRequest } from '../../shared/contracts.js';

const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;
const BridgeRequestSchema = z.object({
  token: z.string().min(32).max(256),
  id: z.string().uuid(),
  request: ToolRequestSchema,
}).strict();

type BrowserMcpHostOptions = {
  directory: string;
  bridgePath: string;
  execute(request: ToolRequest): Promise<unknown>;
};

/** Authenticated local endpoint used only by the stdio MCP bridge process. */
export class BrowserMcpHost {
  #server?: Server;
  #socketPath?: string;
  readonly #sockets = new Set<Socket>();
  readonly #token = randomBytes(32).toString('base64url');
  get socketPath(): string { if (!this.#socketPath) throw new Error('MCP host is not listening'); return this.#socketPath; }

  constructor(private readonly options: BrowserMcpHostOptions) {}

  async start(remoteSocket?: string): Promise<McpServerStdio> {
    if (this.#server) throw new Error('Browser MCP host is already running');
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const socketName = `${randomUUID()}.sock`;
    const preferredSocketPath = join(this.options.directory, socketName);
    this.#socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\pilion-browser-${randomUUID()}`
      : Buffer.byteLength(preferredSocketPath) < 96
        ? preferredSocketPath
        : join('/tmp', `pilion-${process.pid}-${socketName}`);
    const server = createServer(socket => {
      if (!remoteSocket) { this.#handle(socket); return; }
      this.#sockets.add(socket);
      const mcp = createBrowserMcpServer((name, args) => this.options.execute(
        ToolRequestSchema.parse({ requestId: randomUUID(), name, args, timeoutMs: 60_000 }),
      ));
      socket.on('error', () => { void mcp.close(); });
      socket.once('close', () => { this.#sockets.delete(socket); void mcp.close(); });
      void mcp.connect(new StdioServerTransport(socket, socket, { maxBufferSize: MAX_BRIDGE_FRAME_BYTES })).catch(() => socket.destroy());
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
    if (remoteSocket) return { name: 'pilion-browser', command: 'nc', args: ['-U', remoteSocket], env: [] };
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
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    if (socketPath && process.platform !== 'win32') {
      await rm(socketPath, { force: true });
    }
  }

  #handle(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify({ error: message })}\n`);
    };
    socket.setTimeout(90_000, () => fail('Browser MCP host request timed out'));
    socket.on('data', chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_BRIDGE_FRAME_BYTES) {
        fail('Browser MCP host request exceeded the frame limit');
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      settled = true;
      void this.#dispatch(socket, buffer.subarray(0, newline).toString('utf8'));
    });
    socket.on('error', () => { settled = true; });
  }

  async #dispatch(socket: Socket, frame: string): Promise<void> {
    let id: string | undefined;
    try {
      const parsed = BridgeRequestSchema.parse(JSON.parse(frame));
      id = parsed.id;
      if (!sameSecret(parsed.token, this.#token)) throw new Error('Browser MCP host authentication failed');
      const result = await this.options.execute(parsed.request);
      socket.end(`${JSON.stringify({ id, result })}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({
        ...(id ? { id } : {}),
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
