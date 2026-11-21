import { contextBridge, ipcRenderer } from 'electron';

// Register this script before and after the extension library's preload. The first pass
// installs tabGroups; the second decorates the replacement tabs object after chrome freezes.
if (
  process.type === 'service-worker' ||
  (typeof location !== 'undefined' && /^chrome-extension:\/\/[a-p]{32}\//.test(location.href))
) {
  const attached = contextBridge.executeInMainWorld({
    func: () => {
      const target = globalThis as typeof globalThis & {
        chrome?: { tabGroups?: { __pilionAttachTabs?: () => void } };
      };
      const attach = target.chrome?.tabGroups?.__pilionAttachTabs;
      if (!attach) return false;
      attach();
      return true;
    },
  });
  if (!attached) {
    contextBridge.exposeInMainWorld('__pilionTabGroupsBridge', {
      invoke: (method: string, args: unknown[]) =>
        ipcRenderer.invoke('pilion:extension-tab-groups', method, args),
      listen: (listener: (name: string, group: unknown) => void) => {
        ipcRenderer.on(
          'pilion:extension-tab-groups:event',
          (_event, name: unknown, group: unknown) => {
            if (typeof name === 'string') listener(name, group);
          },
        );
      },
    });
    contextBridge.executeInMainWorld({
      func: () => {
        type Listener = (...args: unknown[]) => void;
        type Api = Record<string, unknown>;
        type Namespace = {
          tabGroups?: Api;
          tabs?: Api;
          windows?: Api;
          contextMenus?: Api;
          commands?: Api;
          action?: Api;
          downloads?: Api;
          webNavigation?: Api;
          runtime?: { lastError?: { message: string } };
        };
        const target = globalThis as typeof globalThis & {
          chrome?: Namespace;
          browser?: Namespace;
          __pilionTabGroupsBridge?: {
            invoke(method: string, args: unknown[]): Promise<unknown>;
            listen(listener: (name: string, group: unknown) => void): void;
          };
        };
        const bridge = target.__pilionTabGroupsBridge;
        delete target.__pilionTabGroupsBridge;
        if (
          !bridge ||
          typeof location === 'undefined' ||
          !/^chrome-extension:\/\/[a-p]{32}\//.test(location.href)
        )
          return;
        const chrome = target.chrome ?? (target.chrome = {});
        const invoke =
          (method: string) =>
          (...values: unknown[]) => {
            const callback =
              typeof values.at(-1) === 'function'
                ? (values.pop() as (value?: unknown) => void)
                : undefined;
            const promise = bridge.invoke(method, values);
            if (!callback) return promise;
            void promise.then(callback, (error: unknown) => {
              const runtime = chrome.runtime;
              const previous = runtime && Object.getOwnPropertyDescriptor(runtime, 'lastError');
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
                  if (previous) Object.defineProperty(runtime, 'lastError', previous);
                  else delete runtime.lastError;
                }
              }
            });
            return undefined;
          };
        const api: Api = { TAB_GROUP_ID_NONE: -1 };
        for (const method of ['get', 'query', 'update', 'move']) api[method] = invoke(method);
        const listeners = new Map<string, Set<Listener>>();
        let subscribed = false;
        for (const name of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
          const values = new Set<Listener>();
          listeners.set(name, values);
          api[name] = {
            addListener(listener: Listener) {
              if (typeof listener !== 'function')
                throw new TypeError('Expected a listener function.');
              values.add(listener);
              if (!subscribed) {
                subscribed = true;
                void bridge.invoke('subscribe', []).catch(() => {
                  subscribed = false;
                });
              }
            },
            removeListener: (listener: Listener) => {
              values.delete(listener);
            },
            hasListener: (listener: Listener) => values.has(listener),
            hasListeners: () => values.size > 0,
          };
        }
        const menuListeners = new Set<Listener>();
        const contextMenus: Api = {
          create: (details: Record<string, unknown>, callback?: Listener) => {
            const id = details.id ?? crypto.randomUUID();
            const call = invoke('contextMenus.create');
            if (callback) call({ ...details, id }, callback);
            else void (call({ ...details, id }) as Promise<unknown>).catch(console.error);
            return id;
          },
          removeAll: invoke('contextMenus.removeAll'),
          remove: invoke('contextMenus.remove'),
          update: invoke('contextMenus.update'),
          onClicked: {
            addListener(listener: Listener) {
              if (typeof listener !== 'function')
                throw new TypeError('Expected a listener function.');
              menuListeners.add(listener);
              void bridge.invoke('contextMenus.subscribe', []).catch(console.error);
            },
            removeListener: (listener: Listener) => menuListeners.delete(listener),
            hasListener: (listener: Listener) => menuListeners.has(listener),
            hasListeners: () => menuListeners.size > 0,
          },
        };
        const commandListeners = new Set<Listener>();
        const commands = {
          onCommand: {
            addListener(listener: Listener) {
              if (typeof listener !== 'function')
                throw new TypeError('Expected a listener function.');
              commandListeners.add(listener);
              void bridge.invoke('commands.subscribe', []).catch(console.error);
            },
            removeListener: (listener: Listener) => commandListeners.delete(listener),
            hasListener: (listener: Listener) => commandListeners.has(listener),
            hasListeners: () => commandListeners.size > 0,
          },
        };
        const browserEventListeners = new Map<string, Set<Listener>>();
        const browserEvent = (name: string) => {
          const attached = new Set<Listener>();
          browserEventListeners.set(name, attached);
          return {
            addListener(listener: Listener) {
              if (typeof listener !== 'function')
                throw new TypeError('Expected a listener function.');
              attached.add(listener);
              void bridge.invoke(`${name.split('.')[0]}.subscribe`, []).catch(console.error);
            },
            removeListener: (listener: Listener) => attached.delete(listener),
            hasListener: (listener: Listener) => attached.has(listener),
            hasListeners: () => attached.size > 0,
          };
        };
        const downloads = {
          onCreated: browserEvent('downloads.onCreated'),
          onChanged: browserEvent('downloads.onChanged'),
        };
        const webNavigation = {
          onCreatedNavigationTarget: browserEvent('webNavigation.onCreatedNavigationTarget'),
          onCompleted: browserEvent('webNavigation.onCompleted'),
        };
        const tabUpdated = browserEvent('tabs.onUpdated');
        const actionClick = browserEvent('action.onClicked');
        const windows = { getCurrent: invoke('windows.getCurrent') };
        for (const namespace of new Set([chrome, target.browser])) {
          if (!namespace) continue;
          for (const [key, api] of Object.entries({ downloads, webNavigation })) {
            const name = key as 'downloads' | 'webNavigation';
            if (!namespace[name])
              Object.defineProperty(namespace, name, { value: api, enumerable: true });
            else
              for (const [event, listener] of Object.entries(api))
                if (!(event in namespace[name]!)) namespace[name]![event] = listener;
          }
          if (namespace.action)
            Object.defineProperty(namespace.action, 'onClicked', {
              value: actionClick,
              enumerable: true,
              configurable: true,
            });
          if (!namespace.windows)
            Object.defineProperty(namespace, 'windows', { value: windows, enumerable: true });
          if (!namespace.commands)
            Object.defineProperty(namespace, 'commands', { value: commands, enumerable: true });
          if (!namespace.contextMenus)
            Object.defineProperty(namespace, 'contextMenus', {
              value: contextMenus,
              enumerable: true,
            });
        }
        bridge.listen((name, group) => {
          const callbacks =
            name === 'commands.onCommand'
              ? commandListeners
              : name === 'contextMenus.onClicked'
                ? menuListeners
                : (browserEventListeners.get(name) ?? listeners.get(name));
          for (const listener of [...(callbacks ?? [])]) {
            try {
              if (name === 'tabs.onUpdated' && Array.isArray(group)) listener(...group);
              else listener(group);
            } catch (error) {
              console.error('tabGroups event listener failed', error);
            }
          }
        });
        const patchedTabs = new WeakSet<Api>();
        const attachTabs = () => {
          for (const namespace of [
            chrome,
            ...(target.browser && target.browser !== chrome ? [target.browser] : []),
          ]) {
            const tabs = namespace.tabs;
            if (!tabs || patchedTabs.has(tabs)) continue;
            patchedTabs.add(tabs);
            const metadata = (tab: Record<string, unknown>) =>
              !tab || typeof tab.id !== 'number'
                ? Promise.resolve(tab)
                : bridge.invoke('tabs.getUiMetadata', [tab.id]).then(
                    (data) => ({ ...tab, ...(data as Record<string, unknown>) }),
                    () => tab,
                  );
            const get = tabs.get;
            if (typeof get === 'function') {
              tabs.get = (id: number, callback?: Listener) => {
                if (callback) {
                  return get.call(tabs, id, (tab: Record<string, unknown>) => {
                    if (chrome.runtime?.lastError) callback(tab);
                    else void metadata(tab).then(callback);
                  });
                }
                return Promise.resolve(get.call(tabs, id)).then(metadata);
              };
            }
            const query = tabs.query;
            if (typeof query === 'function') {
              const annotate = (results: Record<string, unknown>[]) =>
                Promise.all(results.map(metadata));
              tabs.query = (details: Record<string, unknown>, callback?: Listener) => {
                if (callback)
                  return query.call(tabs, details, (results: Record<string, unknown>[]) => {
                    if (chrome.runtime?.lastError || !Array.isArray(results)) callback(results);
                    else void annotate(results).then(callback);
                  });
                const response = query.call(tabs, details);
                // Electron returns a promise, but another embedder may return a list directly.
                if (!response || typeof response.then !== 'function') return response;
                return response.then(annotate);
              };
            }
            Object.defineProperty(tabs, 'onUpdated', {
              value: tabUpdated,
              enumerable: true,
              configurable: true,
            });
            tabs.group = invoke('tabs.group');
            tabs.ungroup = invoke('tabs.ungroup');
            const create = tabs.create;
            const createWeb = invoke('tabs.createWeb');
            tabs.create = (details: Record<string, unknown>, callback?: Listener) => {
              if (typeof details?.url === 'string' && /^https?:/i.test(details.url))
                return callback ? createWeb(details, callback) : createWeb(details);
              if (typeof create === 'function')
                return callback ? create.call(tabs, details, callback) : create.call(tabs, details);
              return Promise.reject(
                new Error('This runtime cannot open extension pages through tabs.create.'),
              );
            };
            if (!tabs.remove) tabs.remove = invoke('tabs.removeOwned');
          }
        };
        Object.defineProperty(api, '__pilionAttachTabs', { value: attachTabs });
        Object.defineProperty(chrome, 'tabGroups', {
          value: api,
          enumerable: true,
          configurable: true,
        });
        if (target.browser && target.browser !== chrome)
          Object.defineProperty(target.browser, 'tabGroups', {
            value: api,
            enumerable: true,
            configurable: true,
          });
        attachTabs();
      },
    });
  }
}
