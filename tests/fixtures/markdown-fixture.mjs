/* global process, setTimeout */
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const sessionId = 'md-fixture';
const md = `# 一级标题

## 二级标题

普通段落，包含 **加粗**、*斜体*、\`行内代码\` 和 [链接](https://example.com)。

> 这是一段引用。
> 可以多行。

### 列表

- 无序列表项一
- 无序列表项二
  - 嵌套项

1. 有序列表一
2. 有序列表二

### 任务列表

- [x] 已完成
- [ ] 未完成

### 表格

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| title | string | 标题 |
| count | number | 数量 |

### 代码块

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

### 分割线

---

最后一段，包含 ~~删除线~~ 和 emoji ✨。`;

const app = agent({ name: 'md-fixture' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
    agentCapabilities: {},
    agentInfo: { name: 'md-fixture', title: 'Markdown Fixture', version: '1.0.0' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async () => ({
    sessionId,
    configOptions: [],
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
  }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    for (const chunk of [md.slice(0, 60), md.slice(60)]) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
      });
      await new Promise((r) => setTimeout(r, 120));
    }
    return { stopReason: 'end_turn' };
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
