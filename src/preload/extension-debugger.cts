import { contextBridge, ipcRenderer } from 'electron';

// Service worker preloads lack location in their isolated world; inspect the real
// worker location inside executeInMainWorld before exposing the API there.
if (
  process.type === 'service-worker' ||
  (typeof location !== 'undefined' && /^chrome-extension:\/\/[a-p]{32}\//.test(location.href))
) {
  contextBridge.exposeInMainWorld('__pilionDebuggerBridge', {
    invoke: (method: string, args: unknown[]) =>
      ipcRenderer.invoke('pilion:extension-debugger', method, args),
    listen: (listener: (...args: unknown[]) => void) => {
      ipcRenderer.on('pilion:extension-debugger-event', (_event, ...args: unknown[]) =>
        listener(...args),
      );
    },
  });
  contextBridge.executeInMainWorld({
    func: () => {
      type Listener = (...args: unknown[]) => void;
      type Namespace = {
        debugger?: unknown;
        runtime?: {
          getManifest?(): { permissions?: unknown };
          lastError?: { message: string };
        };
      };
      const target = globalThis as typeof globalThis & {
        chrome?: Namespace;
        browser?: Namespace;
        __pilionDebuggerBridge?: {
          invoke(method: string, args: unknown[]): Promise<unknown>;
          listen(listener: Listener): void;
        };
      };
      const bridge = target.__pilionDebuggerBridge;
      delete target.__pilionDebuggerBridge;
      if (
        !bridge ||
        typeof location === 'undefined' ||
        !/^chrome-extension:\/\/[a-p]{32}\//.test(location.href)
      )
        return;
      const namespace = target.chrome;
      // Match Chrome's namespace visibility before registering listeners or IPC.
      // This is presentation only; main independently authorizes every request.
      try {
        const permissions = namespace?.runtime?.getManifest?.()?.permissions;
        if (!Array.isArray(permissions) || !permissions.includes('debugger')) return;
      } catch {
        return;
      }
      if (!namespace) return;
      const sets = { onEvent: new Set<Listener>(), onDetach: new Set<Listener>() };
      bridge.listen((name, ...args) => {
        const listeners = sets[name as keyof typeof sets];
        if (!listeners) return;
        for (const listener of [...listeners]) {
          try {
            listener(...args);
          } catch (error) {
            console.error('Extension debugger listener failed', error);
          }
        }
      });
      const ready = bridge.invoke('subscribe', []);
      // Listener-only extensions must not cause an unhandled rejection if unprivileged.
      void ready.catch(() => undefined);
      const api: Record<string, unknown> = {};
      for (const name of ['onEvent', 'onDetach'] as const) {
        const listeners = sets[name];
        api[name] = {
          addListener(listener: Listener) {
            if (typeof listener !== 'function') throw TypeError('Listener must be a function.');
            listeners.add(listener);
          },
          removeListener(listener: Listener) {
            listeners.delete(listener);
          },
          hasListener(listener: Listener) {
            return listeners.has(listener);
          },
          hasListeners() {
            return listeners.size > 0;
          },
        };
      }
      for (const method of ['attach', 'detach', 'sendCommand', 'getTargets']) {
        api[method] = (...args: unknown[]) => {
          const callback =
            typeof args.at(-1) === 'function'
              ? (args.pop() as (value?: unknown) => void)
              : undefined;
          const promise = ready.then(() => bridge.invoke(method, args));
          if (!callback) return promise;
          void promise.then(callback, (error: unknown) => {
            const runtime = namespace.runtime;
            const descriptor = runtime && Object.getOwnPropertyDescriptor(runtime, 'lastError');
            let installed = false;
            try {
              if (runtime) {
                Object.defineProperty(runtime, 'lastError', {
                  configurable: true,
                  value: { message: error instanceof Error ? error.message : String(error) },
                });
                installed = true;
              }
              callback();
            } finally {
              if (runtime && installed) {
                if (descriptor) Object.defineProperty(runtime, 'lastError', descriptor);
                else delete runtime.lastError;
              }
            }
          });
          return undefined;
        };
      }
      Object.defineProperty(namespace, 'debugger', {
        value: api,
        enumerable: true,
        configurable: true,
      });
      const browser = target.browser ?? (target.browser = {});
      if (browser !== namespace)
        Object.defineProperty(browser, 'debugger', {
          value: api,
          enumerable: true,
          configurable: true,
        });
    },
  });
}
