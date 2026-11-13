import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** 把 main.ts 里外部通道启停那几段原样拿出来在 vm 里跑，ExternalControlServer 换成可控的假实现。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const FUNCTIONS = ['startExternalControl', 'stopExternalControl', 'externalServerReady'];
const VARIABLES = [
  'externalServer',
  'externalStarting',
  'externalStopping',
  'externalStartError',
  'externalSpacePermissions',
];

function load(options: { slowStop?: boolean } = {}) {
  const nodes = source.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return FUNCTIONS.includes(node.name?.text ?? '');
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.some((d) =>
        VARIABLES.includes(d.name.getText(source)),
      );
    return false;
  });
  expect(nodes).toHaveLength(FUNCTIONS.length + VARIABLES.length);

  const servers: FakeServer[] = [];
  class FakeServer {
    listening = false;
    starts = 0;
    release!: () => void;
    fail!: (error: Error) => void;
    /** slowStop 时 stop() 一直挂着，直到测试调用它：模拟旧 server 还在删 socket、写注册表。 */
    finishStop?: () => void;
    constructor() {
      servers.push(this);
    }
    get isListening() {
      return this.listening;
    }
    start() {
      this.starts++;
      return new Promise<void>((resolve, reject) => {
        this.release = () => {
          this.listening = true;
          resolve();
        };
        this.fail = reject;
      });
    }
    stop() {
      this.listening = false;
      if (!options.slowStop) return Promise.resolve();
      return new Promise<void>((resolve) => {
        this.finishStop = resolve;
      });
    }
  }
  const context: Record<string, unknown> = {
    ExternalControlServer: FakeServer,
    process: { platform: 'darwin' },
    store: { recordEvent: vi.fn() },
    app: { getPath: () => '/u', getVersion: () => '1.0.0' },
    join: (...parts: string[]) => parts.join('/'),
    __dirname: '/d',
    externalRuntime: {},
    emit: vi.fn(),
    readable: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    lastError: undefined,
  };
  runInNewContext(
    ts.transpileModule(
      `${nodes.map((node) => node.getText(source)).join('\n')}
globalThis.api = {
  start: startExternalControl,
  stop: stopExternalControl,
  ready: externalServerReady,
  startError: () => externalStartError,
};`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  const api = context.api as {
    start(): void;
    stop(): Promise<void>;
    ready(): Promise<void>;
    startError(): string | undefined;
  };
  return { api, servers, context };
}

it('a second start while the first is still starting does not create another server', async () => {
  const { api, servers } = load();
  api.start();
  api.start();
  expect(servers).toHaveLength(1);
  const ready = api.ready();
  servers[0]!.release();
  await ready;
  api.start();
  expect(servers).toHaveLength(1);
});

it('a failed start keeps its reason and a later start can try again', async () => {
  const { api, servers, context } = load();
  api.start();
  const ready = api.ready();
  servers[0]!.fail(new Error('外部 socket 路径已被非 socket 占用：/u/external/external.sock'));
  await ready;
  expect(api.startError()).toBe('外部 socket 路径已被非 socket 占用：/u/external/external.sock');
  expect(context.lastError).toContain('外部控制通道启动失败');
  api.start();
  expect(servers).toHaveLength(2);
  expect(api.startError()).toBeUndefined();
});

it('turning the channel off mid-start lets the next start build a fresh server', async () => {
  const { api, servers } = load();
  api.start();
  await api.stop();
  api.start();
  expect(servers).toHaveLength(2);
});

it('turning the channel back on while the old one is still closing waits before listening', async () => {
  const { api, servers } = load({ slowStop: true });
  api.start();
  servers[0]!.release();
  await api.ready();
  const stopped = api.stop();
  api.start();
  expect(servers).toHaveLength(2);
  await vi.waitFor(() => expect(servers[0]!.finishStop).toBeDefined());
  // 旧 server 还没删完自己的 socket、没写完注册表：新 server 不能在同一路径上起来。
  expect(servers[1]!.starts).toBe(0);
  servers[0]!.finishStop!();
  await stopped;
  await vi.waitFor(() => expect(servers[1]!.starts).toBe(1));
  const ready = api.ready();
  servers[1]!.release();
  await ready;
  expect(servers[1]!.isListening).toBe(true);
});

it('turning the channel off again before a queued start runs means it never listens', async () => {
  const { api, servers } = load({ slowStop: true });
  api.start();
  servers[0]!.release();
  await api.ready();
  const firstStop = api.stop();
  api.start();
  const secondStop = api.stop();
  await vi.waitFor(() => expect(servers[0]!.finishStop).toBeDefined());
  servers[0]!.finishStop!();
  await firstStop;
  await vi.waitFor(() => expect(servers[1]!.finishStop).toBeDefined());
  servers[1]!.finishStop!();
  await secondStop;
  await new Promise((resolve) => setImmediate(resolve));
  expect(servers[1]!.starts).toBe(0);
  expect(servers.map((server) => server.isListening)).toEqual([false, false]);
});

function integrationHome(env: Record<string, string>): string {
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'integrationPaths',
  )!;
  const context: Record<string, unknown> = {
    process: { platform: 'darwin', env, execPath: '/x/Pilion', resourcesPath: '/x/res' },
    app: {
      getPath: () => '/u',
      getVersion: () => '1.0.0',
      isPackaged: true,
      getAppPath: () => '/a',
    },
    join: (...parts: string[]) => parts.join('/'),
    os: { homedir: () => '/real/home' },
    __dirname: '/d',
  };
  runInNewContext(
    ts.transpileModule(`${fn.getText(source)}\nglobalThis.paths = integrationPaths();`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return (context.paths as { home: string }).home;
}

it('PILION_INTEGRATION_HOME only redirects home under NODE_ENV=test', () => {
  expect(integrationHome({ PILION_INTEGRATION_HOME: '/tmp/e2e', NODE_ENV: 'test' })).toBe(
    '/tmp/e2e',
  );
  expect(integrationHome({ PILION_INTEGRATION_HOME: '/tmp/e2e' })).toBe('/real/home');
  expect(integrationHome({ PILION_INTEGRATION_HOME: '/tmp/e2e', NODE_ENV: 'production' })).toBe(
    '/real/home',
  );
  expect(integrationHome({ NODE_ENV: 'test' })).toBe('/real/home');
});
