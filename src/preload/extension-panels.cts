import { contextBridge, ipcRenderer } from 'electron';

// Only privileged extension worlds get this API. Main validates each actual IPC sender again.
if (
  process.type === 'service-worker' ||
  (typeof location !== 'undefined' && /^chrome-extension:\/\/[a-p]{32}\//.test(location.href))
) {
  contextBridge.exposeInMainWorld('__pilionSidePanelBridge', {
    invoke: (method: string, options: unknown) =>
      ipcRenderer.invoke('pilion:extension-side-panel', method, options),
  });
  contextBridge.executeInMainWorld({
    func: () => {
      type Api = Record<string, (...args: unknown[]) => unknown>;
      type Namespace = { sidePanel?: Api; runtime?: { lastError?: { message: string } } };
      const target = globalThis as typeof globalThis & {
        chrome?: Namespace;
        browser?: Namespace;
        __pilionSidePanelBridge?: { invoke(method: string, options: unknown): Promise<unknown> };
      };
      const bridge = target.__pilionSidePanelBridge;
      delete target.__pilionSidePanelBridge;
      if (
        !bridge ||
        typeof location === 'undefined' ||
        !/^chrome-extension:\/\/[a-p]{32}\//.test(location.href)
      )
        return;
      const namespace = target.chrome ?? (target.chrome = {});
      const api: Api = {};
      for (const method of [
        'setOptions',
        'getOptions',
        'setPanelBehavior',
        'getPanelBehavior',
        'open',
        'close',
      ]) {
        api[method] = (...args: unknown[]) => {
          const callback =
            typeof args.at(-1) === 'function'
              ? (args.pop() as (value?: unknown) => void)
              : undefined;
          const promise = bridge.invoke(method, args[0] ?? {});
          if (!callback) return promise;
          void promise.then(callback, (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const runtime = namespace.runtime;
            const previous = runtime && Object.getOwnPropertyDescriptor(runtime, 'lastError');
            let installed = false;
            try {
              if (runtime) {
                Object.defineProperty(runtime, 'lastError', {
                  configurable: true,
                  value: { message },
                });
                installed = true;
              }
              callback();
            } finally {
              if (runtime && installed) {
                if (previous) Object.defineProperty(runtime, 'lastError', previous);
                else delete runtime.lastError;
              }
            }
          });
          return undefined;
        };
      }
      // Install before electron-chrome-extensions freezes chrome in its next preload.
      Object.defineProperty(namespace, 'sidePanel', {
        value: api,
        enumerable: true,
        configurable: true,
      });
      if (target.browser && target.browser !== namespace)
        Object.defineProperty(target.browser, 'sidePanel', {
          value: api,
          enumerable: true,
          configurable: true,
        });
    },
  });
}
