/* global process */
import { appendFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'pilion-acp-probe', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await appendFile(process.env.PILION_PROBE_LOG, 'tools/list\n');
  return {
    tools: [
      {
        name: 'browser_page_info',
        description: 'Read the browser page.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});
server.setRequestHandler(CallToolRequestSchema, async () => {
  await appendFile(process.env.PILION_PROBE_LOG, 'tools/call\n');
  return { content: [{ type: 'text', text: 'Browser probe' }] };
});
await server.connect(new StdioServerTransport());
