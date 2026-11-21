import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = () =>
  ts.transpileModule(
    readFileSync(new URL('../src/preload/extension-panels.cts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
type PanelApi = {
  getOptions(options: object, callback?: (value: { enabled: boolean }) => void): Promise<unknown>;
};
type World = Record<string, unknown> & {
  chrome: { runtime: object; sidePanel: PanelApi };
  browser: { sidePanel: PanelApi };
};
function load(url: string) {
  const requests: unknown[][] = [];
  const chrome = { runtime: {} };
  const main = { chrome, browser: {}, location: { href: url } } as unknown as World;
  const invoke = async (...args: unknown[]) => {
    requests.push(args);
    return { path: 'panel.html', enabled: true };
  };
  const contextBridge = {
    exposeInMainWorld: (key: string, value: unknown) => {
      main[key] = value;
    },
    executeInMainWorld: ({ func }: { func: () => void }) =>
      runInNewContext(`(${func.toString()})()`, main),
  };
  runInNewContext(source(), {
    require: () => ({ contextBridge, ipcRenderer: { invoke } }),
    location: { href: url },
    process: { contextIsolated: true },
    exports: {},
  });
  return { main, requests };
}
it('installs working promise and callback APIs before chrome is frozen, including browser alias', async () => {
  const { main, requests } = load(`chrome-extension://${'a'.repeat(32)}/panel.html`);
  Object.freeze(main.chrome);
  expect(await main.chrome.sidePanel.getOptions({ tabId: 7 })).toEqual({
    path: 'panel.html',
    enabled: true,
  });
  expect(requests[0]).toEqual(['pilion:extension-side-panel', 'getOptions', { tabId: 7 }]);
  await new Promise<void>((resolve) =>
    main.browser.sidePanel.getOptions({}, (result: { enabled: boolean }) => {
      expect(result.enabled).toBe(true);
      resolve();
    }),
  );
  expect(Object.keys(main)).not.toContain('__pilionSidePanelBridge');
});
it('does not add privileged APIs to regular web pages', () => {
  const { main } = load('https://example.com');
  expect(main.chrome).not.toHaveProperty('sidePanel');
});

it('installs in worker main world when worker preload has no location global', async () => {
  const main = {
    chrome: { runtime: {} },
    location: { href: `chrome-extension://${'a'.repeat(32)}/worker.js` },
  } as unknown as World;
  const contextBridge = {
    exposeInMainWorld: (key: string, value: unknown) => {
      main[key] = value;
    },
    executeInMainWorld: ({ func }: { func: () => void }) =>
      runInNewContext(`(${func.toString()})()`, main),
  };
  runInNewContext(source(), {
    require: () => ({ contextBridge, ipcRenderer: { invoke: async () => ({ enabled: true }) } }),
    process: { type: 'service-worker' },
    exports: {},
  });
  expect(await main.chrome.sidePanel.getOptions({})).toEqual({ enabled: true });
});
