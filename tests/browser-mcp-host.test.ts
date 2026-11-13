import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserMcpHost } from '../src/main/agents/browser-mcp-host';
import type { ToolRequest } from '../src/shared/contracts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A short root: macOS's tmpdir() plus a scratch folder would already be too long for a socket. */
async function scratch(): Promise<string> {
  const root = await mkdtemp('/tmp/pmh-');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function host(
  root: string,
  execute: (request: ToolRequest) => Promise<unknown> = async () => ({ ok: true }),
  requestTimeoutMs?: number,
): BrowserMcpHost {
  const created = new BrowserMcpHost({
    // userData on a real machine can be this deep; the socket cannot live under it.
    directory: join(root, 'profile', 'x'.repeat(100)),
    socketRoot: root,
    bridgePath: '',
    execute,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  });
  cleanups.push(() => created.stop());
  return created;
}

async function token(started: BrowserMcpHost): Promise<string> {
  const server = await started.start();
  return server.env.find((item) => item.name === 'PILION_BROWSER_MCP_TOKEN')!.value;
}

function requestLine(secret: string, id = randomUUID()): string {
  return `${JSON.stringify({ token: secret, id, request: { requestId: id, name: 'browser.page_info', args: {} } })}\n`;
}

/** Sends one bridge request (then `followUp`, in a later write) and resolves with the host's answer line. */
function ask(path: string, payload: string, followUp?: string): Promise<Record<string, unknown>> {
  return new Promise((resolveAnswer, rejectAnswer) => {
    const socket = createConnection(path);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(payload);
      if (followUp) setTimeout(() => socket.write(followUp), 20);
    });
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => {
      try {
        resolveAnswer(JSON.parse(data.split('\n')[0]) as Record<string, unknown>);
      } catch (error) {
        rejectAnswer(error);
      }
    });
    socket.on('error', rejectAnswer);
  });
}

const uid = process.getuid?.() ?? 0;

describe.skipIf(process.platform === 'win32')('browser MCP host socket', () => {
  it('moves the socket into a private per-user directory when the profile path is too long', async () => {
    const root = await scratch();
    const started = host(root);
    const server = await started.start();
    const directory = join(root, `pilion-mcp-${uid}`);

    expect(started.socketPath.startsWith(`${directory}/`)).toBe(true);
    expect(Buffer.byteLength(started.socketPath)).toBeLessThan(104);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(started.socketPath)).mode & 0o777).toBe(0o600);
    expect(server.env).toContainEqual({
      name: 'PILION_BROWSER_MCP_SOCKET',
      value: started.socketPath,
    });
  });

  it('refuses a socket directory that is a symlink or not a directory', async () => {
    const root = await scratch();
    const directory = join(root, `pilion-mcp-${uid}`);
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), directory);
    await expect(host(root).start()).rejects.toThrow(/Refusing to use/);
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);

    await rm(directory);
    await writeFile(directory, '');
    await expect(host(root).start()).rejects.toThrow(/Refusing to use/);
  });

  it('tightens a loosened directory of its own before creating the socket in it', async () => {
    const root = await scratch();
    const directory = join(root, `pilion-mcp-${uid}`);
    await mkdir(directory);
    await chmod(directory, 0o755);
    await host(root).start();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('sweeps sockets left by a Pilion that is gone and keeps those of live processes', async () => {
    const root = await scratch();
    const directory = join(root, `pilion-mcp-${uid}`);
    await mkdir(directory, { mode: 0o700 });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const stale = `${gone}-aaaaaaaaaaaa.sock`;
    const live = `${process.pid}-bbbbbbbbbbbb.sock`;
    for (const name of [stale, live, 'unrelated.txt']) await writeFile(join(directory, name), '');

    const started = host(root);
    await started.start();
    const entries = await readdir(directory);
    expect(entries).not.toContain(stale);
    expect(entries).toEqual(expect.arrayContaining([live, 'unrelated.txt']));
    expect(entries).toContain(started.socketPath.slice(directory.length + 1));
  });
});

describe.skipIf(process.platform === 'win32')('browser MCP host requests', () => {
  it('answers a tool that outlives the request timeout with an error, and drops its late result', async () => {
    let release!: (value: unknown) => void;
    const started = host(
      await scratch(),
      () =>
        new Promise((resolveTool) => {
          release = resolveTool;
        }),
      100,
    );
    const secret = await token(started);
    const id = randomUUID();
    await expect(ask(started.socketPath, requestLine(secret, id))).resolves.toEqual({
      id,
      error: 'Browser MCP host request timed out',
    });
    release({ late: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  });

  it('runs one request per connection and ignores what follows it', async () => {
    const calls: string[] = [];
    const started = host(await scratch(), async (request) => {
      calls.push(request.requestId);
      // Still running when the follow-up arrives.
      await new Promise((resolveTool) => setTimeout(resolveTool, 60));
      return { ok: true };
    });
    const secret = await token(started);
    const id = randomUUID();
    await expect(
      ask(started.socketPath, requestLine(secret, id), requestLine(secret)),
    ).resolves.toEqual({ id, result: { ok: true } });
    expect(calls).toEqual([id]);
  });

  it('answers an execute that throws synchronously, and rejects a wrong token', async () => {
    const started = host(await scratch(), () => {
      throw new Error('tool exploded');
    });
    const secret = await token(started);
    const id = randomUUID();
    await expect(ask(started.socketPath, requestLine(secret, id))).resolves.toEqual({
      id,
      error: 'tool exploded',
    });
    await expect(
      ask(started.socketPath, requestLine('w'.repeat(secret.length), id)),
    ).resolves.toEqual({ id, error: 'Browser MCP host authentication failed' });
  });
});
