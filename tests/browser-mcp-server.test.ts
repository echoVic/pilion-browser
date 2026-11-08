import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpServer } from '../src/main/agents/browser-mcp-server';
import { MAX_UPLOAD_FILES } from '../src/shared/contracts';

async function connected(
  implementation?: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const execute = vi.fn(
    implementation ?? (async (name: string, args: Record<string, unknown>) => ({ name, args })),
  );
  const server = createBrowserMcpServer(execute as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, execute };
}

describe('browser MCP server skill tools', () => {
  it('forwards a bounded observe offset and rejects invalid pages before execution', async () => {
    const { client, execute } = await connected();
    const result = await client.callTool({
      name: 'browser_observe',
      arguments: { tabId: 'task-tab', offset: 200 },
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith('browser.observe', { tabId: 'task-tab', offset: 200 });
    execute.mockClear();
    for (const offset of [-1, 0.5, '200', 100001]) {
      const invalid = await client.callTool({
        name: 'browser_observe',
        arguments: { tabId: 'task-tab', offset },
      });
      expect(invalid.isError).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });

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

describe('scroll and upload tools', () => {
  it('exposes scroll with a bounded direction and upload with absolute-path files', async () => {
    const { client, execute } = await connected();
    const tools = (await client.listTools()).tools;
    const scroll = tools.find((tool) => tool.name === 'browser_scroll');
    const upload = tools.find((tool) => tool.name === 'browser_upload_file');
    expect(scroll?.description).toMatch(/not gated by approval|not a page effect/i);
    expect(upload?.description).toMatch(/absolute path/i);

    const ok = await client.callTool({
      name: 'browser_scroll',
      arguments: { tabId: 'task-tab', direction: 'down', amount: 400 },
    });
    expect(ok.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith('browser.scroll', {
      tabId: 'task-tab',
      direction: 'down',
      amount: 400,
    });

    execute.mockClear();
    const badDirection = await client.callTool({
      name: 'browser_scroll',
      arguments: { tabId: 'task-tab', direction: 'sideways' },
    });
    expect(badDirection.isError).toBe(true);
    const emptyFiles = await client.callTool({
      name: 'browser_upload_file',
      arguments: {
        tabId: 'task-tab',
        elementRef: {
          id: 'e',
          tabId: 'task-tab',
          frameId: 'main',
          documentEpoch: 0,
          frameEpoch: 0,
          localFingerprint: 'a'.repeat(64),
        },
        files: [],
      },
    });
    expect(emptyFiles.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects more than the shared MAX_UPLOAD_FILES (issue #4b)', async () => {
    const { client, execute } = await connected();
    const tooMany = await client.callTool({
      name: 'browser_upload_file',
      arguments: {
        tabId: 'task-tab',
        elementRef: {
          id: 'e',
          tabId: 'task-tab',
          frameId: 'main',
          documentEpoch: 0,
          frameEpoch: 0,
          localFingerprint: 'a'.repeat(64),
        },
        files: Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => `/tmp/${i}.png`),
      },
    });
    expect(tooMany.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('screenshot image content', () => {
  it('returns a jpeg screenshot as image content with the real mimeType', async () => {
    const data = Buffer.from('jpeg-bytes').toString('base64');
    const { client } = await connected(async () => ({
      mimeType: 'image/jpeg',
      data,
      downgraded: true,
      format: 'jpeg',
    }));
    const result = await client.callTool({
      name: 'browser_screenshot',
      arguments: { tabId: 'task-tab', format: 'jpeg', scale: 0.5 },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'image', data, mimeType: 'image/jpeg' });
  });

  it('exposes the downsampling flags and rejects an out-of-range scale before executing', async () => {
    const { client, execute } = await connected();
    const tools = (await client.listTools()).tools;
    const shot = tools.find((tool) => tool.name === 'browser_screenshot');
    const schema = JSON.stringify(shot?.inputSchema);
    for (const flag of ['scale', 'quality', 'format', 'clip']) expect(schema).toContain(flag);
    const bad = await client.callTool({ name: 'browser_screenshot', arguments: { scale: 2 } });
    expect(bad.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('issue #3 MCP tools', () => {
  const elementRef = {
    id: 'e',
    tabId: 'task-tab',
    frameId: 'main',
    documentEpoch: 0,
    frameEpoch: 0,
    localFingerprint: 'a'.repeat(64),
  };

  it('registers browser_hover and routes it to the executor', async () => {
    const { client, execute } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === 'browser_hover')).toBeDefined();
    const result = await client.callTool({
      name: 'browser_hover',
      arguments: { tabId: 'task-tab', elementRef },
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith('browser.hover', { tabId: 'task-tab', elementRef });
  });

  it('allows press without elementRef and click with force', async () => {
    const { client, execute } = await connected();
    const press = await client.callTool({ name: 'browser_press', arguments: { key: 'Space' } });
    expect(press.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith('browser.press', { key: 'Space' });
    execute.mockClear();
    const click = await client.callTool({
      name: 'browser_click',
      arguments: { elementRef, force: true },
    });
    expect(click.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith('browser.click', { elementRef, force: true });
  });
});
