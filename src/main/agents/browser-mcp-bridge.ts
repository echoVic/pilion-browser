import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { z } from 'zod';
import type { ToolName } from '../../shared/contracts.js';

const socketPath = requiredEnv('PILION_BROWSER_MCP_SOCKET');
const token = requiredEnv('PILION_BROWSER_MCP_TOKEN');
const server = new McpServer({ name: 'pilion-browser', version: '0.1.0' });

const elementRef = z.object({
  id: z.string().min(1).max(256),
  tabId: z.string().min(1).max(256),
  frameId: z.string().min(1).max(256),
  documentEpoch: z.number().int().nonnegative(),
  frameEpoch: z.number().int().nonnegative(),
  localFingerprint: z.string().min(1).max(512),
}).strict();
const optionalTab = { tabId: z.string().min(1).max(256).optional() };

register('browser_tabs_list', 'List browser tabs visible to this Agent.', 'browser.tabs.list', {});
register('browser_tabs_open', 'Open a browser tab.', 'browser.tabs.open', { url: z.string().max(8192).optional() });
register('browser_tabs_activate', 'Activate a browser tab.', 'browser.tabs.activate', { tabId: z.string().min(1).max(256) });
register('browser_tabs_close', 'Close a browser tab.', 'browser.tabs.close', { tabId: z.string().min(1).max(256) });
register('browser_navigate', 'Navigate a browser tab to a URL.', 'browser.navigate', { ...optionalTab, url: z.string().min(1).max(8192) });
register('browser_page_info', 'Read basic information about a browser page.', 'browser.page_info', optionalTab);
register('browser_observe', 'Observe the interactive elements in a browser page.', 'browser.observe', optionalTab);
register('browser_click', 'Click an element returned by browser_observe.', 'browser.click', { ...optionalTab, elementRef });
register('browser_type', 'Type text into an element returned by browser_observe.', 'browser.type', {
  ...optionalTab, elementRef, text: z.string().max(100_000), replace: z.boolean().optional(),
});
register('browser_select', 'Select an option in an element returned by browser_observe.', 'browser.select', {
  ...optionalTab, elementRef, value: z.string().min(1).max(10_000),
});
register('browser_check', 'Set a checkbox or radio element returned by browser_observe.', 'browser.check', {
  ...optionalTab, elementRef, checked: z.boolean(),
});
register('browser_press', 'Press a supported key on an element returned by browser_observe.', 'browser.press', {
  ...optionalTab,
  elementRef,
  key: z.enum([
    'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space',
  ]),
  modifiers: z.array(z.enum(['Shift'])).max(1).optional(),
});

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }));

function register(
  exposedName: string,
  description: string,
  toolName: ToolName,
  inputSchema: z.ZodRawShape,
): void {
  const callback: ToolCallback<z.ZodRawShape> = async (input): Promise<CallToolResult> => {
    try {
      const result = await callHost(toolName, input as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  server.tool(exposedName, description, inputSchema, callback);
}

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
    socket.setTimeout(30_000, () => finish(new Error('Pilion browser tool timed out')));
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
