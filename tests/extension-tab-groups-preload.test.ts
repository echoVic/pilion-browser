import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
it('survives library replacement/freeze, installs callbacks and dispatches real group events', async () => {
  const source = ts.transpileModule(
    readFileSync(new URL('../src/preload/extension-tab-groups.cts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const calls: unknown[][] = [];
  let receive: (...args: unknown[]) => void = () => {};
  const world = {
    chrome: { runtime: {}, tabs: {} } as {
      runtime: object;
      tabs: {
        group(options: object): Promise<number>;
        query(): Promise<unknown[]>;
        get(id: number): Promise<unknown>;
      };
      tabGroups: {
        get(id: number, callback: (value: unknown) => void): void;
        onRemoved: {
          addListener(listener: (group: unknown) => void): void;
          removeListener(listener: (group: unknown) => void): void;
        };
      };
    },
    location: { href: `chrome-extension://${'a'.repeat(32)}/options.html` },
  };
  const contextBridge = {
    executeInMainWorld: ({ func }: { func: () => unknown }) =>
      runInNewContext(`(${func.toString()})()`, world),
    exposeInMainWorld: (key: string, value: unknown) => Object.assign(world, { [key]: value }),
  };
  const run = () =>
    runInNewContext(source, {
      exports: {},
      process: {},
      location: world.location,
      require: () => ({
        contextBridge,
        ipcRenderer: {
          invoke: async (...args: unknown[]) => {
            calls.push(args);
            if (args[1] === 'tabs.getUiMetadata') return { windowId: 7, groupId: 42 };
            return 42;
          },
          on: (_channel: string, listener: typeof receive) => {
            receive = listener;
          },
        },
      }),
    });
  run();
  const originalTab = { id: 7, windowId: 0 };
  Object.defineProperty(world.chrome, 'tabs', {
    configurable: true,
    value: { query: async () => [originalTab], get: async () => originalTab },
  });
  Object.freeze(world.chrome);
  run();
  expect(await world.chrome.tabs.group({ tabIds: [7] })).toBe(42);
  expect(calls.at(-1)).toEqual(['pilion:extension-tab-groups', 'tabs.group', [{ tabIds: [7] }]]);
  await new Promise<void>((resolve) =>
    world.chrome.tabGroups.get(42, (result: unknown) => {
      expect(result).toBe(42);
      resolve();
    }),
  );
  const received: unknown[] = [];
  const listener = (group: unknown) => received.push(group);
  world.chrome.tabGroups.onRemoved.addListener(listener);
  receive({}, 'onRemoved', { id: 42 });
  expect(received).toEqual([{ id: 42 }]);
  world.chrome.tabGroups.onRemoved.removeListener(listener);
  receive({}, 'onRemoved', { id: 42 });
  expect(received).toHaveLength(1);
  expect(await world.chrome.tabs.query()).toEqual([{ id: 7, windowId: 7, groupId: 42 }]);
  expect(await world.chrome.tabs.get(7)).toEqual({ id: 7, windowId: 7, groupId: 42 });
});
