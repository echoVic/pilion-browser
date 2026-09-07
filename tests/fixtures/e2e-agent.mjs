/* global process */
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Readable, Writable } from 'node:stream';

let mcpClient;
let mcpTransport;
const sessionId = 'pilion-e2e-session';

const app = agent({ name: 'pilion-e2e-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
    agentCapabilities: {},
    agentInfo: { name: 'pilion-e2e-agent', title: 'Pilion E2E Agent', version: '1.0.0' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async ({ params }) => {
    const server = params.mcpServers.find(candidate => !('type' in candidate));
    if (!server) throw new Error('Pilion browser MCP server was not provided');
    const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
    mcpTransport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...inheritedEnv, ...Object.fromEntries(server.env.map(item => [item.name, item.value])) },
      cwd: params.cwd,
      stderr: 'pipe',
      maxBufferSize: 1024 * 1024,
    });
    mcpClient = new McpClient({ name: 'pilion-e2e-agent', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);
    return { sessionId };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const observed = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    const observedText = observed.content.find(item => item.type === 'text')?.text;
    const observation = observedText ? JSON.parse(observedText) : {};
    const elementRef = observation.elements?.[0]?.ref;
    let text = 'No interactive element';
    if (elementRef) {
      const clicked = await mcpClient.callTool({ name: 'browser_click', arguments: { elementRef } });
      text = clicked.isError ? 'Browser click rejected' : 'Browser click completed';
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, async () => {});

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));

await connection.closed;
await mcpClient?.close();
