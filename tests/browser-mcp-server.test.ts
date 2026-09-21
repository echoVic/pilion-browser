import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpServer } from '../src/main/agents/browser-mcp-server';

async function connected() {
  const execute = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }));
  const server = createBrowserMcpServer(execute as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, execute };
}

describe('browser MCP server skill tools', () => {
  it('lists both skill tools with instructions the Agent can follow', async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools;
    const list = tools.find((tool) => tool.name === 'browser_skills_list');
    const play = tools.find((tool) => tool.name === 'browser_skills_play');
    expect(list?.description).toMatch(/Prefer a matching skill/);
    expect(play?.description).toMatch(/fromStep = failedAt \+ 1/);
    expect(play?.description).toMatch(/HUMAN/);
  });

  it('routes browser_skills_list to the executor with no arguments', async () => {
    const { client, execute } = await connected();
    await client.callTool({ name: 'browser_skills_list', arguments: {} });
    expect(execute).toHaveBeenCalledWith('browser.skills.list', {});
  });

  it('rejects a play call with fromStep 0 before it reaches the executor', async () => {
    const { client, execute } = await connected();
    const result = await client.callTool({
      name: 'browser_skills_play',
      arguments: { skillId: 'monthly-export', fromStep: 0 },
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalledWith('browser.skills.play', expect.anything());
  });
});
