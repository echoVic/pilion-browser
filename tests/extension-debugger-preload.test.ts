import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = ts.transpileModule(
  readFileSync(new URL('../src/preload/extension-debugger.cts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
function load(
  url = `chrome-extension://${'a'.repeat(32)}/page.html`,
  worker = false,
  getManifest: (() => unknown) | undefined = () => ({ permissions: ['debugger'] }),
) {
  type Listener = (...args: unknown[]) => void;
  type Api = {
    attach(...args: unknown[]): Promise<unknown>;
    detach(source: object, callback: () => void): void;
    getTargets(): Promise<unknown>;
    onEvent: {
      addListener(fn: Listener): void;
      removeListener(fn: Listener): void;
      hasListener(fn: Listener): boolean;
      hasListeners(): boolean;
    };
  };
  const main = {
    location: { href: url },
    chrome: { runtime: { getManifest } },
    browser: {},
  } as unknown as Record<string, unknown> & {
    chrome: { debugger: Api; runtime: { lastError?: { message: string } } };
    browser: { debugger: Api };
  };
  const calls: unknown[][] = [];
  let deliver: (...args: unknown[]) => void = () => {};
  const contextBridge = {
    exposeInMainWorld(key: string, value: unknown) {
      main[key] = value;
    },
    executeInMainWorld({ func }: { func(): void }) {
      runInNewContext(`(${func.toString()})()`, main);
    },
  };
  runInNewContext(source, {
    require: () => ({
      contextBridge,
      ipcRenderer: {
        invoke: async (...args: unknown[]) => {
          calls.push(args);
          if (args[1] === 'detach') throw Error('detached failure');
          return { real: true };
        },
        on: (_channel: string, listener: typeof deliver) => {
          deliver = listener;
        },
      },
    }),
    exports: {},
    process: { type: worker ? 'service-worker' : 'renderer' },
    ...(!worker ? { location: { href: url } } : {}),
  });
  return { main, calls, deliver: (...args: unknown[]) => deliver({}, ...args) };
}
it('supports promises, callbacks, real event delivery and aliases after chrome freezes', async () => {
  const { main, calls, deliver } = load();
  Object.freeze(main.chrome);
  const api = main.chrome.debugger;
  expect(main.browser.debugger).toBe(api);
  expect(await api.attach({ tabId: 4 }, '1.3')).toEqual({ real: true });
  expect(calls).toEqual([
    ['pilion:extension-debugger', 'subscribe', []],
    ['pilion:extension-debugger', 'attach', [{ tabId: 4 }, '1.3']],
  ]);
  let seen: unknown[] = [];
  const listener = (...args: unknown[]) => {
    seen = args;
  };
  api.onEvent.addListener(listener);
  expect(api.onEvent.hasListener(listener)).toBe(true);
  deliver('onEvent', { tabId: 4 }, 'Runtime.consoleAPICalled', {});
  expect(seen).toEqual([{ tabId: 4 }, 'Runtime.consoleAPICalled', {}]);
  api.onEvent.removeListener(listener);
  expect(api.onEvent.hasListeners()).toBe(false);
  await new Promise<void>((resolve) =>
    api.detach({ tabId: 4 }, () => {
      expect(main.chrome.runtime.lastError!.message).toContain('detached failure');
      resolve();
    }),
  );
  expect(main.chrome.runtime.lastError).toBeUndefined();
  expect(main.__pilionDebuggerBridge).toBeUndefined();
});
it('installs in workers without isolated-world location, and refuses normal webpages', async () => {
  expect(await load(undefined, true).main.chrome.debugger.getTargets()).toEqual({ real: true });
  expect(load('https://example.com').main.chrome.debugger).toBeUndefined();
  expect(load('https://example.com', true).main.chrome.debugger).toBeUndefined();
});

it.each([false, true])(
  'does not expose debugger or subscribe without manifest permission (worker=%s)',
  (worker) => {
    for (const getManifest of [
      () => ({ permissions: ['storage'] }),
      () => ({ optional_permissions: ['debugger'] }),
      () => ({}),
      () => ({ permissions: 'debugger' }),
      () => {
        throw Error('Manifest unavailable');
      },
    ]) {
      const { main, calls } = load(undefined, worker, getManifest);
      expect(main.chrome.debugger).toBeUndefined();
      expect(main.browser.debugger).toBeUndefined();
      expect(main.__pilionDebuggerBridge).toBeUndefined();
      expect(calls).toEqual([]);
    }
  },
);
