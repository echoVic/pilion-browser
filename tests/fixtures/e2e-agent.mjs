/* global process, setTimeout */
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Readable, Writable } from 'node:stream';

let mcpClient;
let mcpTransport;
let cancelPrompt;
const sessionId = 'pilion-e2e-session';
let model = 'fixture-fast';
let mode = 'default';
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      {
        group: 'fixture',
        name: 'Fixture',
        options: [
          { value: 'fixture-fast', name: 'Fast' },
          { value: 'fixture-reasoning', name: 'Reasoning' },
        ],
      },
    ],
  },
];

const app = agent({ name: 'pilion-e2e-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
    agentCapabilities: {},
    agentInfo: { name: 'pilion-e2e-agent', title: 'Pilion E2E Agent', version: '1.0.0' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async ({ params }) => {
    const server = params.mcpServers.find((candidate) => !('type' in candidate));
    if (!server) throw new Error('Pilion browser MCP server was not provided');
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry) => entry[1] !== undefined),
    );
    mcpTransport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...inheritedEnv,
        ...Object.fromEntries(server.env.map((item) => [item.name, item.value])),
      },
      cwd: params.cwd,
      stderr: 'pipe',
      maxBufferSize: 1024 * 1024,
    });
    mcpClient = new McpClient({ name: 'pilion-e2e-agent', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);
    return {
      sessionId,
      configOptions: configOptions(),
      modes: {
        currentModeId: mode,
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Full access' },
        ],
      },
    };
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    mode = params.modeId;
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (params.value === 'fixture-reasoning' || params.value === 'fixture-fast')
      model = params.value;
    else throw new Error('Unknown model');
    return { configOptions: configOptions() };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const promptText = params.prompt
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    if (promptText.includes('UI 回归')) {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '检查页面和工具输出。' },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'test-tool',
          title: '读取页面',
          kind: 'read',
          status: 'in_progress',
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'test-tool', status: 'completed' },
      });
      for (let index = 1; index <= 80; index += 1) {
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `段落 ${index}：流式回复中的内容。\n\n` },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('ACP 审批')) {
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: 'approval-test',
          title: '检查项目文件',
          kind: 'read',
          rawInput: { description: '内容'.repeat(1500) },
        },
        options: [
          { optionId: 'allow-once', name: 'Approve', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
        ],
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify({ permission: permission.outcome, model, mode }),
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('等待取消')) {
      await new Promise((resolve) => {
        cancelPrompt = resolve;
      });
      cancelPrompt = undefined;
      return { stopReason: 'cancelled' };
    }
    if (promptText.includes('总结页面')) {
      const info = await mcpClient.callTool({ name: 'browser_page_info', arguments: {} });
      const payload = JSON.parse(info.content.find((item) => item.type === 'text').text);
      const text = `## 页面摘要\n\n${payload.text}\n\n[来源](${payload.url})`;
      for (const chunk of [text.slice(0, 10), text.slice(10, 30), text.slice(30)]) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        });
      }
      return { stopReason: 'end_turn' };
    }
    const observed = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
    const observedText = observed.content.find((item) => item.type === 'text')?.text;
    const observation = observedText ? JSON.parse(observedText) : {};
    const elementRef = observation.elements?.[0]?.ref;
    let text = 'No interactive element';
    if (elementRef) {
      const clicked = await mcpClient.callTool({
        name: 'browser_click',
        arguments: { elementRef },
      });
      text = clicked.isError ? 'Browser click rejected' : 'Browser click completed';
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelPrompt?.();
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

await connection.closed;
await mcpClient?.close();
