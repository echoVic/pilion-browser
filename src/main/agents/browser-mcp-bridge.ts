import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { ToolName } from '../../shared/contracts.js';
import { createBrowserMcpServer } from './browser-mcp-server.js';

const socketPath = requiredEnv('PILION_BROWSER_MCP_SOCKET');
const token = requiredEnv('PILION_BROWSER_MCP_TOKEN');
const server = createBrowserMcpServer(callHost);

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }));

function callHost(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectCall(error); else resolveCall(result);
    };
    socket.setTimeout(90_000, () => finish(new Error('Pilion browser tool timed out')));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        token,
        id,
        request: { requestId: id, name, args, timeoutMs: 30_000 },
      })}\n`);
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > 1024 * 1024) {
        finish(new Error('Pilion browser tool response exceeded the frame limit'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
          id?: string;
          result?: unknown;
          error?: string;
        };
        if (response.id !== id) throw new Error('Pilion browser tool response id mismatch');
        if (response.error) throw new Error(response.error);
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Pilion browser tool connection closed without a response')));
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
