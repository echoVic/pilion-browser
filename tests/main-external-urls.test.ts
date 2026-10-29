import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ExternalUrlQueue } from '../src/main/external-urls';

const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function execute(code: string, context: Record<string, unknown>) {
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}

function runtime(platform = 'darwin') {
  const app = Object.assign(new EventEmitter(), { focus: vi.fn() });
  const opened: string[] = [];
  const context: Record<string, unknown> = {
    app,
    process: { platform },
    ExternalUrlQueue,
    openTab: async (url: string) => {
      opened.push(url);
      context.activeTabId = url;
    },
    window: { show: vi.fn(), focus: vi.fn() },
    readable: String,
    emit: vi.fn(),
    agentTabId: 'agent-tab',
    // openExternalUrl 经 window-focus.activateApp 收口：正常模式 show →（darwin）app.focus → window.focus。
    activateApp: (win: { show: () => void; focus: () => void }) => {
      win.show();
      if (platform === 'darwin') app.focus({ steal: true });
      win.focus();
    },
  };
  const nodes = source.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text === 'openExternalUrl';
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === 'externalUrls',
      );
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    return (
      node.expression.expression.getText(source) === 'app.on' &&
      node.expression.arguments[0]?.getText(source) === "'will-finish-launching'"
    );
  });
  expect(nodes).toHaveLength(3);
  execute(
    `${nodes.map((node) => node.getText(source)).join('\n')}\nglobalThis.urls = externalUrls;`,
    context,
  );
  return { app, opened, context, urls: context.urls as ExternalUrlQueue };
}

it('registers open-url before ready, prevents the OS default and queues until workspace startup finishes', async () => {
  const { app, opened, urls } = runtime();
  expect(app.listenerCount('open-url')).toBe(0);
  app.emit('will-finish-launching');
  const event = { preventDefault: vi.fn() };
  app.emit('open-url', event, 'https://example.com/?from=os');
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(opened).toEqual([]);
  await urls.flush();
  expect(opened).toEqual(['https://example.com/?from=os']);
});

it.each(['darwin', 'linux'])(
  'opens external links through openTab and brings the %s window forward without moving the Agent target',
  async (platform) => {
    const { app, opened, context, urls } = runtime(platform);
    await urls.flush();
    app.emit('will-finish-launching');
    app.emit('open-url', { preventDefault() {} }, 'http://127.0.0.1/');
    await urls.flush();
    expect(opened).toEqual(['http://127.0.0.1/']);
    expect(context.activeTabId).toBe('http://127.0.0.1/');
    expect(context.agentTabId).toBe('agent-tab');
    const window = context.window as {
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
    };
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(app.focus).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
  },
);

it('flushes startup links after restored tabs have been opened and activated', async () => {
  const { opened, context, urls } = runtime();
  await urls.receive('https://example.com/?from=os');
  const init = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'init',
  )!;
  const statements = [...init.body!.statements];
  const restore = statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === 'restore',
      ),
  );
  expect(restore).toBeGreaterThan(-1);
  const pages = new Map<string, object>();
  Object.assign(context, {
    settings: { data: { startupBehavior: 'restore' } },
    savedTabState: undefined,
    DEFAULT_SPACE: { id: 'default' },
    tabOrganization: { activeSpaceId: 'default', spaces: [{ id: 'default' }] },
    selectSpace: async () => {},
    setInterval: () => ({ unref() {} }),
    powerMonitor: new EventEmitter(),
    autoArchiveTabs: async () => {},
    log: vi.fn(),
    workspace: { data: { tabs: ['https://example.com/restored'], activeTabIndex: 0 } },
    pages,
    HOME: 'about:blank',
    openTab: async (url: string) => {
      opened.push(url);
      pages.set(url, {});
      context.activeTabId = url;
    },
    activateTab: (id: string) => {
      context.activeTabId = id;
    },
    startUpdates: async () => {},
  });
  execute(
    `async function finishStartup() { ${statements
      .slice(restore)
      .map((node) => node.getText(source))
      .join('\n')} }`,
    context,
  );
  await (context.finishStartup as () => Promise<void>)();
  expect(opened).toEqual(['https://example.com/restored', 'https://example.com/?from=os']);
  expect(context.activeTabId).toBe('https://example.com/?from=os');
});
