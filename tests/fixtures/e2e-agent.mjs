/* global process, setTimeout */
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Readable, Writable } from 'node:stream';

let mcpClient;
let mcpTransport;
let cancelPrompt;
const sessionId = 'pilion-e2e-session';
const goalMode = process.env.PILION_E2E_GOAL === '1';
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
    ...(goalMode
      ? {
          _meta: {
            goal: {
              version: 1,
              controlMethod: '_session/goal',
              actions: ['set', 'clear'],
            },
          },
        }
      : {}),
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
  .onRequest(
    '_session/goal',
    {
      parse(value) {
        return value;
      },
    },
    async ({ params, client }) => {
      if (!goalMode) throw new Error('Goal mode is disabled');
      const request = params;
      if (request.action === 'clear') {
        await client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'session_info_update', _meta: { goal: null } },
        });
        return {};
      }
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: {
            goal: {
              objective: request.objective,
              status: 'active',
              controlMethod: '_session/goal',
            },
          },
        },
      });
      setTimeout(() => {
        void (async () => {
          const info = await mcpClient.callTool({ name: 'browser_page_info', arguments: {} });
          const payload = JSON.parse(info.content.find((item) => item.type === 'text').text);
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Goal completed for ${payload.title || payload.url}`,
              },
            },
          });
          await client.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'session_info_update', _meta: { goal: null } },
          });
        })();
      }, 500);
      return {};
    },
  )
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    try {
      return await (async () => {
        const promptText = params.prompt
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('');
        if (promptText.includes('提炼成一份可复用的技能文档')) {
          // 固定的提炼结果：只从轨迹里挑步骤，把邮箱换成占位符。
          const block = promptText.slice(promptText.indexOf('```json pilion-trajectory'));
          const trajectory = JSON.parse(
            block.split('\n').slice(1, block.split('\n').indexOf('```')).join('\n'),
          );
          const actions = trajectory.entries
            .filter((entry) => entry.kind === 'step' && entry.step.kind !== 'note')
            .map((entry) => entry.step);
          const doc = [
            `# ${trajectory.meta.name}`,
            '',
            '## 什么时候用',
            '',
            '需要打开示例站点并进入 IANA 说明页时。',
            '',
            '## 前置条件',
            '',
            '- 无',
            '',
            '## 已知坑',
            '',
            '- 无',
            '',
            '```json pilion-skill',
            JSON.stringify(
              { meta: { about: '打开示例站点并点进说明页' }, steps: actions },
              null,
              2,
            ),
            '```',
          ].join('\n');
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `提炼结果如下：\n\n${doc}\n` },
            },
          });
          return { stopReason: 'end_turn' };
        }
        // 交接说明里没有「用技能」三个字，只有 browser_skills_play 与 fromStep = N。
        if (promptText.includes('用技能') || promptText.includes('browser_skills_play')) {
          const listed = await mcpClient.callTool({ name: 'browser_skills_list', arguments: {} });
          const skills = JSON.parse(listed.content.find((item) => item.type === 'text').text);
          const fromStepMatch = /fromStep = (\d+)/.exec(promptText);
          const played = await mcpClient.callTool({
            name: 'browser_skills_play',
            arguments: {
              skillId: skills[0].id,
              ...(fromStepMatch ? { fromStep: Number(fromStepMatch[1]) } : {}),
            },
          });
          const outcome = JSON.parse(played.content.find((item) => item.type === 'text').text);
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `技能结果：${JSON.stringify(outcome)}` },
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText === '继续任务') {
          const info = await mcpClient.callTool({ name: 'browser_page_info', arguments: {} });
          const payload = JSON.parse(info.content.find((item) => item.type === 'text').text);
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `已读取最新页面并继续完成任务：${payload.text}`,
              },
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText.includes('鼠标交互验收')) {
          const interact = async (label, name, args = {}) => {
            const observed = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
            const snapshot = JSON.parse(observed.content.find((item) => item.type === 'text').text);
            const target = snapshot.elements.find((item) => item.name === label);
            if (!target) throw new Error(`Missing element: ${label}`);
            const result = await mcpClient.callTool({
              name,
              arguments: { elementRef: target.ref, ...args },
            });
            if (result.isError) {
              process.stderr.write(`Pointer fixture ${label}: ${JSON.stringify(result.content)}\n`);
              throw new Error(JSON.stringify(result.content));
            }
          };
          if (promptText.includes('取消')) {
            await interact('显示结果', 'browser_click');
            return { stopReason: 'end_turn' };
          }
          await interact('姓名', 'browser_type', { text: '你好 Pilion', replace: true });
          await interact('类型', 'browser_select', { value: 'two' });
          await interact('同意测试', 'browser_check', { checked: true });
          await interact('显示结果', 'browser_click');
          await new Promise((resolve) => setTimeout(resolve, 800));
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '鼠标交互验收完成' },
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText.includes('空回复续接')) {
          for (const status of ['in_progress', 'completed']) {
            await client.notify(methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'duplicate-tool',
                title: '读取标签页',
                kind: 'read',
                status,
              },
            });
          }
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '...(no content)' },
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText.includes('空白页浏览验收')) {
          const call = async (name, args = {}) => {
            const result = await mcpClient.callTool({ name, arguments: args });
            const text = result.content.find((item) => item.type === 'text')?.text;
            if (result.isError) throw new Error(text);
            return JSON.parse(text);
          };
          await call('browser_tabs_list');
          await call('browser_navigate', { url: 'https://example.com' });
          const page = await call('browser_page_info');
          const observation = await call('browser_observe');
          const link = observation.elements.find((item) => item.name === 'Learn more');
          if (!link) throw new Error('Example Domain link missing');
          await call('browser_click', { elementRef: link.ref });
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `空白页验收完成：${page.text}` },
            },
          });
          return { stopReason: 'end_turn' };
        }
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
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'test-tool',
              status: 'completed',
            },
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
        if (promptText.includes('接管等价验收')) {
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '已输出的内容' },
            },
          });
          await new Promise((resolve) => {
            cancelPrompt = resolve;
          });
          cancelPrompt = undefined;
          await new Promise((resolve) => setTimeout(resolve, 250));
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '不应出现的迟到输出' },
            },
          });
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'late-tool',
              title: '迟到工具',
              kind: 'read',
              status: 'in_progress',
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText.includes('需要登录')) {
          const handed = await mcpClient.callTool({
            name: 'browser_request_human',
            arguments: { reason: '这个页面需要你先登录，我无法代你输入密码' },
          });
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: handed.isError ? '交接失败' : '已交回浏览器' },
            },
          });
          return { stopReason: 'end_turn' };
        }
        if (promptText.includes('接管了浏览器')) {
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `收到交接：${promptText}` },
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
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: chunk },
              },
            });
          }
          return { stopReason: 'end_turn' };
        }
        let text = 'No interactive element';
        // A real Agent re-observes and retries when a click is rejected with a
        // retryable "observe again" reason (e.g. the fingerprint check sees the
        // layout shift under the pointer on a slow machine). Mirror that here so
        // the fixture is not brittle against that transient rejection.
        for (let attempt = 0; attempt < 3; attempt++) {
          const observed = await mcpClient.callTool({ name: 'browser_observe', arguments: {} });
          const observedText = observed.content.find((item) => item.type === 'text')?.text;
          const observation = observedText ? JSON.parse(observedText) : {};
          const elementRef = observation.elements?.[0]?.ref;
          if (!elementRef) break;
          const clicked = await mcpClient.callTool({
            name: 'browser_click',
            arguments: { elementRef },
          });
          const reason = clicked.content?.find((item) => item.type === 'text')?.text ?? '';
          if (!clicked.isError) {
            text = 'Browser click completed';
            break;
          }
          text = `Browser click rejected: ${reason}`;
          if (!reason.includes('observe again')) break;
        }
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        });
        return { stopReason: 'end_turn' };
      })();
    } catch (error) {
      // Surface the failure in the conversation so E2E snapshots show the real reason, then fail the turn.
      await client
        .notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Fixture error: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        })
        .catch(() => undefined);
      throw error;
    }
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelPrompt?.();
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

await connection.closed;
await mcpClient?.close();
