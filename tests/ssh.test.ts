import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { BrowserMcpHost } from '../src/main/agents/browser-mcp-host';
import { shellQuote, sshLaunch } from '../src/main/agents/ssh';

describe('SSH ACP connection', () => {
  it('quotes remote arguments without shell expansion and requires private forwarding', () => {
    const literal = 'a\'b " c $HOME `id` $(pwd)';
    expect(
      execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(literal)}`], { encoding: 'utf8' }),
    ).toBe(literal);
    const launch = sshLaunch(
      {
        id: 'a',
        name: 'Remote',
        command: '/opt/agent',
        args: [literal],
        cwd: '/home/work space',
        enabled: true,
        transport: 'ssh',
        ssh: { host: 'user@remote', port: 2222 },
        env: { TEST_VALUE: literal },
      },
      '/tmp/local.sock',
      '/tmp/remote.sock',
    );
    expect(launch.command).toBe('ssh');
    expect(launch.args).toContain('BatchMode=yes');
    expect(launch.args).toContain('ExitOnForwardFailure=yes');
    expect(launch.args).toContain('StreamLocalBindMask=0177');
    expect(launch.args).toContain('/tmp/remote.sock:/tmp/local.sock');
    expect(launch.args?.at(-1)).toContain(shellQuote(literal));
    expect(() =>
      sshLaunch(
        {
          id: 'a',
          name: 'Bad',
          command: 'a',
          args: [],
          enabled: true,
          ssh: { host: '-oProxyCommand=bad', port: 22 },
        },
        '',
        '',
      ),
    ).toThrow();
  });
  it('runs MCP over the remote return stream, validates tool inputs, and tears down connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-remote-'));
    const calls: string[] = [];
    const host = new BrowserMcpHost({
      directory,
      bridgePath: '',
      execute: async (request) => {
        calls.push(request.name);
        return { text: 'Remote browser content' };
      },
    });
    let client: Client | undefined;
    try {
      const server = await host.start('/tmp/remote.sock');
      expect(server).toEqual({
        name: 'pilion-browser',
        command: 'nc',
        args: ['-U', '/tmp/remote.sock'],
        env: [],
      });
      expect((await stat(host.socketPath)).mode & 0o777).toBe(0o600);
      client = new Client({ name: 'remote-agent', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({ command: 'nc', args: ['-U', host.socketPath] }),
      );
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(14);
      const result = await client.callTool({ name: 'browser_page_info', arguments: {} });
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ text: 'Remote browser content' }) },
      ]);
      expect(calls).toEqual(['browser.page_info']);
      const invalid = await client.callTool({ name: 'browser_press', arguments: { key: 'F12' } });
      expect(invalid.isError).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await client?.close();
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
