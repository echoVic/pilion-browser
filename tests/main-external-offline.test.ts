import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalClientRegistry } from '../src/main/external/client-registry';
import { externalPrincipalForClient } from '../src/main/external/types';

/**
 * 设置页「吊销 / 删除客户端」的 IPC 处理函数连同离线路径原样在 vm 里跑，
 * 注册表用真的 ExternalClientRegistry 写临时目录：通道没在监听时也要真正落盘、立刻失效。
 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const helpers = [
  'cutExternalClientOffline',
  'revokeExternalClientOffline',
  'deleteExternalClientOffline',
];

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function handlerText(channel: string): string {
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      !call &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'handle' &&
      node.arguments[0]?.getText(source) === channel
    )
      call = node;
    if (!call) ts.forEachChild(node, visit);
  };
  visit(source);
  expect(call, channel).toBeDefined();
  return call!.arguments[2]!.getText(source);
}

let userData: string;
let dir: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'pilion-offline-'));
  dir = join(userData, 'external');
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

function harness(externalServer: unknown) {
  const order: string[] = [];
  const context: Record<string, unknown> = {
    externalServer,
    ExternalClientRegistry,
    externalPrincipalForClient,
    join,
    app: { getPath: () => userData },
    externalRuntime: {
      revokePrincipalAcl: vi.fn((principal: string) => order.push(`acl:${principal}`)),
      spaces: { stopClient: vi.fn(async (clientId: string) => order.push(`spaces:${clientId}`)) },
    },
    store: { recordEvent: vi.fn() },
    emit: vi.fn(),
    requireIntegration: () => ({
      onClientGone: vi.fn(async (clientId: string) => order.push(`gone:${clientId}`)),
    }),
  };
  for (const name of helpers) {
    const fn = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    expect(fn, name).toBeDefined();
    runInNewContext(transpile(fn!.getText(source)), context);
  }
  const run = (channel: string) =>
    runInNewContext(transpile(`(${handlerText(channel)})`), context) as (value: {
      id: string;
    }) => Promise<unknown>;
  return {
    context,
    order,
    revoke: run('IPC.externalClientRevoke'),
    remove: run('IPC.externalClientDelete'),
  };
}

function onDisk(): Array<{ clientId: string; revokedAt?: string }> {
  return (
    JSON.parse(readFileSync(join(dir, 'clients.json'), 'utf8')) as {
      clients: Array<{ clientId: string; revokedAt?: string }>;
    }
  ).clients;
}

it('revoking a client while the channel is off writes the revocation to disk and cuts what it left behind', async () => {
  const { client, token } = await new ExternalClientRegistry(dir).create('CLI');
  const h = harness(undefined);
  const result = (await h.revoke({ id: client.clientId })) as { revokedAt?: string };
  expect(result.revokedAt).toEqual(expect.any(String));
  expect(onDisk().find((c) => c.clientId === client.clientId)?.revokedAt).toBe(result.revokedAt);
  expect(await new ExternalClientRegistry(dir).verify(token)).toBeUndefined();
  // 先切断进程内残留（Tab ACL、Agent Space），集成文件最后清。
  expect(h.order).toEqual([
    `acl:external:${client.clientId}`,
    `spaces:${client.clientId}`,
    `gone:${client.clientId}`,
  ]);
  expect(
    (h.context.store as { recordEvent: ReturnType<typeof vi.fn> }).recordEvent,
  ).toHaveBeenCalledWith('external', 'external.client.revoked', 'external.client.revoked', {
    clientId: client.clientId,
    name: 'CLI',
  });
  expect(h.context.emit).toHaveBeenCalled();
});

it('a server that exists but is not listening (e.g. failed to start) is not asked to revoke', async () => {
  const { client } = await new ExternalClientRegistry(dir).create('CLI');
  const server = {
    isListening: false,
    revokeClient: vi.fn(async () => {
      throw new Error('外部控制通道没有在运行，无法吊销客户端');
    }),
  };
  const h = harness(server);
  await h.revoke({ id: client.clientId });
  expect(server.revokeClient).not.toHaveBeenCalled();
  expect(onDisk().find((c) => c.clientId === client.clientId)?.revokedAt).toEqual(
    expect.any(String),
  );
});

it('deleting a client while the channel is off removes it from disk, and an instance that already loaded it rejects its token', async () => {
  const { client, token } = await new ExternalClientRegistry(dir).create('CLI');
  // 正在启动的 server 手里那份注册表：已经读过盘、也验过这个 token。
  const loaded = new ExternalClientRegistry(dir);
  expect(await loaded.verify(token)).toMatchObject({ clientId: client.clientId });
  const server = { isListening: false, deleteClient: vi.fn() };
  const h = harness(server);
  expect(await h.remove({ id: client.clientId })).toBe(true);
  expect(server.deleteClient).not.toHaveBeenCalled();
  expect(onDisk().some((c) => c.clientId === client.clientId)).toBe(false);
  expect(await loaded.verify(token)).toBeUndefined();
  expect(h.order).toEqual([
    `acl:external:${client.clientId}`,
    `spaces:${client.clientId}`,
    `gone:${client.clientId}`,
  ]);
});

it('the revocation still reaches disk when stopping the Agent Spaces fails, and the failure is reported', async () => {
  const { client } = await new ExternalClientRegistry(dir).create('CLI');
  const h = harness(undefined);
  const runtime = h.context.externalRuntime as {
    spaces: { stopClient: ReturnType<typeof vi.fn> };
  };
  runtime.spaces.stopClient.mockRejectedValueOnce(new Error('workspace write failed'));
  await expect(h.revoke({ id: client.clientId })).rejects.toThrow('workspace write failed');
  expect(onDisk().find((c) => c.clientId === client.clientId)?.revokedAt).toEqual(
    expect.any(String),
  );
});

it('with the channel listening the server revokes and deletes, and the on-disk path stays untouched', async () => {
  const entry = { clientId: 'c1', name: 'CLI', revokedAt: '2026-11-12T00:00:00.000Z' };
  const server = {
    isListening: true,
    revokeClient: vi.fn(async () => entry),
    deleteClient: vi.fn(async () => true),
  };
  const h = harness(server);
  h.context.ExternalClientRegistry = vi.fn(() => {
    throw new Error('offline path used');
  });
  expect(await h.revoke({ id: 'c1' })).toBe(entry);
  expect(await h.remove({ id: 'c1' })).toBe(true);
  expect(server.revokeClient).toHaveBeenCalledWith('c1');
  expect(server.deleteClient).toHaveBeenCalledWith('c1');
  expect(h.order).toEqual(['gone:c1', 'gone:c1']);
});
