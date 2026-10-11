import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { IPC, type DefaultBrowserStatus } from '../src/shared/contracts';
import { getDefaultBrowserStatus, setDefaultBrowser } from '../src/main/default-browser';

interface DefaultBrowserApi {
  get(): Promise<DefaultBrowserStatus>;
  set(): Promise<DefaultBrowserStatus>;
}

it.each(['index.ts', 'entry.cts'])(
  'exposes the same narrow default browser bridge in %s',
  async (file) => {
    let api: { defaultBrowser?: DefaultBrowserApi } | undefined;
    const calls: unknown[][] = [];
    const status = { supported: true, isDefault: false };
    runInNewContext(
      ts.transpileModule(readFileSync(new URL(`../src/preload/${file}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports: {},
        require: (name: string) =>
          name === 'electron'
            ? {
                contextBridge: {
                  exposeInMainWorld: (_name: string, bridge: typeof api) => {
                    api = bridge;
                  },
                },
                ipcRenderer: {
                  on() {},
                  invoke: async (...args: unknown[]) => {
                    calls.push(args);
                    return status;
                  },
                },
              }
            : { IPC },
      },
    );
    expect(api?.defaultBrowser).toBeDefined();
    expect(Object.keys(api!.defaultBrowser!).sort()).toEqual(['get', 'set']);
    expect(await api!.defaultBrowser!.get()).toEqual(status);
    expect(await api!.defaultBrowser!.set()).toEqual(status);
    expect(calls).toEqual([['default-browser:get'], ['default-browser:set']]);
  },
);

it('allows both default browser channels in preferences and invokes the guarded macOS status logic', () => {
  const text = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const register = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc',
  )!;
  const calls = register.body!.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ['IPC.defaultBrowserGet', 'IPC.defaultBrowserSet'].includes(
        node.expression.arguments[0]?.getText(source),
      ),
  );
  expect(calls).toHaveLength(2);
  const handlers = new Map<string, () => DefaultBrowserStatus>();
  const protocols: string[] = [];
  let isDefault = false;
  runInNewContext(
    ts.transpileModule(calls.map((node) => node.getText(source)).join('\n'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      IPC,
      preferences: { preferences: true },
      getDefaultBrowserStatus,
      setDefaultBrowser,
      process: { platform: 'darwin', env: { NODE_ENV: 'test' } },
      app: {
        isPackaged: false,
        isDefaultProtocolClient: () => isDefault,
        setAsDefaultProtocolClient: (protocol: string) => {
          protocols.push(protocol);
          isDefault = true;
          return true;
        },
      },
      handle: (
        channel: string,
        schema: unknown,
        handler: () => DefaultBrowserStatus,
        options: unknown,
      ) => {
        expect(schema).toBeUndefined();
        expect(options).toEqual({ preferences: true });
        handlers.set(channel, handler);
      },
    },
  );
  expect(handlers.get('default-browser:get')!()).toEqual({ supported: true, isDefault: false });
  expect(handlers.get('default-browser:set')!()).toEqual({ supported: true, isDefault: true });
  expect(protocols).toEqual(['http', 'https']);
});
