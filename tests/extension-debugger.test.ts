import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('electron', async () => ({
  app: new (await import('node:events')).EventEmitter(),
  webContents: { getAllWebContents: () => [] },
}));
import { ExtensionDebugger } from '../src/main/extension-debugger';
function setup(permission = true) {
  const session = {
    registerPreloadScript: vi.fn(() => 'preload'),
    unregisterPreloadScript: vi.fn(),
    extensions: Object.assign(new EventEmitter(), {
      getExtension: () => ({ manifest: { permissions: permission ? ['debugger'] : [] } }),
    }),
    serviceWorkers: Object.assign(new EventEmitter(), { getAllRunning: () => ({}) }),
  };
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn<
      (method: string, params?: object, sessionId?: string) => Promise<Record<string, unknown>>
    >(async (method) => {
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: 'own-page', type: 'page' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'owned-session' };
      return { result: { value: 'real' } };
    }),
  });
  const page = Object.assign(new EventEmitter(), {
    id: 42,
    session,
    isDestroyed: () => false,
    getURL: (): string => 'https://example.com',
    getTitle: () => 'Example',
    debugger: debuggerApi,
  });
  const send = vi.fn();
  const event = {
    type: 'frame',
    sender: { session },
    senderFrame: {
      url: `chrome-extension://${'a'.repeat(32)}/page.html`,
      send,
      isDestroyed: () => false,
    },
  } as unknown as Electron.IpcMainInvokeEvent;
  const validateUrl = vi.fn(async (url: string) => {
    if (!url.startsWith('https://')) throw Error('blocked URL');
    return url;
  });
  const api = new ExtensionDebugger({
    session: session as unknown as Electron.Session,
    preload: '/tmp/debugger.cjs',
    tabs: () => [page as unknown as Electron.WebContents],
    validateUrl,
  });
  return { api, event, page, send, debuggerApi, validateUrl, session };
}
it('multiplexes actual commands and events without detaching native transport', async () => {
  const { api, event, send, debuggerApi } = setup();
  await api.handle(event, 'subscribe', []);
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  expect(
    await api.handle(event, 'sendCommand', [
      { tabId: 42 },
      'Runtime.evaluate',
      { expression: 'document.title' },
    ]),
  ).toEqual({ result: { value: 'real' } });
  debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' }, 'owned-session');
  expect(send).toHaveBeenCalledWith(
    'pilion:extension-debugger-event',
    'onEvent',
    { tabId: 42 },
    'Runtime.consoleAPICalled',
    { type: 'log' },
  );
  await api.handle(event, 'detach', [{ tabId: 42 }]);
  expect(debuggerApi.detach).not.toHaveBeenCalled();
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42 }, 'DOM.getDocument', {}]),
  ).rejects.toThrow();
  await api.dispose();
});
it('rejects unauthorized callers, shell targets and escape commands', async () => {
  const { api, event } = setup();
  await expect(
    api.handle(
      { ...event, senderFrame: { url: 'https://evil.test' } } as Electron.IpcMainInvokeEvent,
      'getTargets',
      [],
    ),
  ).rejects.toThrow();
  const denied = setup(false);
  await expect(denied.api.handle(denied.event, 'getTargets', [])).rejects.toThrow();
  await expect(api.handle(event, 'attach', [{ tabId: 99 }, '1.3'])).rejects.toThrow();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  for (const method of [
    'Browser.getVersion',
    'Target.getTargets',
    'Target.exposeDevToolsProtocol',
    'Network.getAllCookies',
    'DOM.setFileInputFiles',
  ])
    await expect(api.handle(event, 'sendCommand', [{ tabId: 42 }, method, {}])).rejects.toThrow();
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42, sessionId: 'other' }, 'Runtime.enable', {}]),
  ).rejects.toThrow();
  await expect(
    api.handle(event, 'sendCommand', [
      { tabId: 42 },
      'Page.navigate',
      { url: 'file:///etc/passwd' },
    ]),
  ).rejects.toThrow();
  await api.dispose();
  await denied.api.dispose();
});
it('forces flattened iframe-only auto attach and only accepts observed child sessions', async () => {
  const { api, event, debuggerApi } = setup();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  await api.handle(event, 'sendCommand', [
    { tabId: 42 },
    'Target.setAutoAttach',
    { autoAttach: true, flatten: true },
  ]);
  expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    },
    'owned-session',
  );
  debuggerApi.emit(
    'message',
    {},
    'Target.attachedToTarget',
    { sessionId: 'iframe', targetInfo: { type: 'iframe', url: '' } },
    'owned-session',
  );
  await api.handle(event, 'sendCommand', [
    { tabId: 42, sessionId: 'iframe' },
    'DOM.getDocument',
    {},
  ]);
  debuggerApi.emit(
    'message',
    {},
    'Target.attachedToTarget',
    {
      sessionId: 'worker',
      targetInfo: { type: 'service_worker', url: 'https://child.test/sw.js' },
    },
    'owned-session',
  );
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42, sessionId: 'worker' }, 'Runtime.enable', {}]),
  ).rejects.toThrow();
  await api.dispose();
  expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
    sessionId: 'owned-session',
  });
  expect(debuggerApi.detach).not.toHaveBeenCalled();
});
it('rejects cross-session frames, mismatched worker scopes, and universal isolation overrides', async () => {
  const { api, event, page } = setup();
  await expect(
    api.handle(
      { ...event, sender: { session: {} } } as unknown as Electron.IpcMainInvokeEvent,
      'getTargets',
      [],
    ),
  ).rejects.toThrow();
  await expect(
    api.handle(
      {
        type: 'service-worker',
        session: {},
        serviceWorker: { isDestroyed: () => false },
      } as unknown as Electron.IpcMainServiceWorkerInvokeEvent,
      'getTargets',
      [],
    ),
  ).rejects.toThrow();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  await expect(
    api.handle(event, 'sendCommand', [
      { tabId: 42 },
      'Page.createIsolatedWorld',
      { frameId: 'frame', grantUniveralAccess: true },
    ]),
  ).rejects.toThrow();
  const other = {
    ...event,
    senderFrame: { ...event.senderFrame, url: `chrome-extension://${'b'.repeat(32)}/page.html` },
  } as unknown as Electron.IpcMainInvokeEvent;
  await expect(api.handle(other, 'detach', [{ tabId: 42 }])).rejects.toThrow();
  page.getURL = () => 'chrome-extension://' + 'a'.repeat(32) + '/page.html';
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42 }, 'Runtime.enable', {}]),
  ).rejects.toThrow();
  expect(await api.handle(event, 'getTargets', [])).toEqual([]);
  await api.dispose();
});
it('delivers native detach only to the owning extension', async () => {
  const { api, event, debuggerApi, send } = setup();
  await api.handle(event, 'subscribe', []);
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  debuggerApi.emit('detach', {}, 'target_closed');
  expect(send).toHaveBeenCalledWith(
    'pilion:extension-debugger-event',
    'onDetach',
    { tabId: 42 },
    'target_closed',
  );
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42 }, 'Runtime.enable', {}]),
  ).rejects.toThrow();
  await api.dispose();
});

it('isolates persistent commands and domain disable from the native root, then detaches only its session', async () => {
  const { api, event, debuggerApi } = setup();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  for (const command of [
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.addBinding',
    'Runtime.disable',
    'Page.disable',
  ]) {
    await api.handle(event, 'sendCommand', [
      { tabId: 42 },
      command,
      { source: 'globalThis.persisted=true', name: 'binding' },
    ]);
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith(
      command,
      expect.any(Object),
      'owned-session',
    );
  }
  await api.handle(event, 'detach', [{ tabId: 42 }]);
  expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
    sessionId: 'owned-session',
  });
  expect(debuggerApi.detach).not.toHaveBeenCalled();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  await api.dispose();
  await api.dispose();
});
it('unload releases owned session and permits reattachment; late commands cannot report success', async () => {
  const { api, event, debuggerApi, session } = setup();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  let resolveCommand!: (value: Record<string, unknown>) => void;
  debuggerApi.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
  );
  const pending = api.handle(event, 'sendCommand', [
    { tabId: 42 },
    'Page.addScriptToEvaluateOnNewDocument',
    { source: 'globalThis.persisted=true' },
  ]);
  session.extensions.emit('extension-unloaded', {}, { id: 'a'.repeat(32) });
  resolveCommand({ identifier: 'late-script' });
  await expect(pending).rejects.toThrow();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  expect(debuggerApi.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', {
    sessionId: 'owned-session',
  });
  expect(debuggerApi.detach).not.toHaveBeenCalled();
  await api.dispose();
});
it('unload during async attach cleans the late-created session', async () => {
  const { api, event, debuggerApi, session } = setup();
  let resolveAttach!: (value: Record<string, unknown>) => void;
  debuggerApi.sendCommand.mockImplementation(async (method) => {
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'own-page', type: 'page' } };
    if (method === 'Target.attachToTarget')
      return new Promise((resolve) => {
        resolveAttach = resolve;
      });
    return {};
  });
  const pending = api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  await vi.waitFor(() => expect(resolveAttach).toBeTypeOf('function'));
  session.extensions.emit('extension-unloaded', {}, { id: 'a'.repeat(32) });
  resolveAttach({ sessionId: 'late-session' });
  await expect(pending).rejects.toThrow();
  await vi.waitFor(() =>
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', {
      sessionId: 'late-session',
    }),
  );
  await api.dispose();
});

it('rejects empty session IDs rather than forwarding them to the native root', async () => {
  const { api, event, debuggerApi } = setup();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  const count = debuggerApi.sendCommand.mock.calls.length;
  await expect(
    api.handle(event, 'sendCommand', [{ tabId: 42, sessionId: '' }, 'Runtime.disable', {}]),
  ).rejects.toThrow();
  expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(count);
  await api.dispose();
});
it('does not forward native root events while isolated attachment is pending', async () => {
  const { api, event, debuggerApi, send } = setup();
  await api.handle(event, 'subscribe', []);
  let resolveAttach!: (value: Record<string, unknown>) => void;
  debuggerApi.sendCommand.mockImplementation(async (method) => {
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'own-page', type: 'page' } };
    return new Promise((resolve) => {
      resolveAttach = resolve;
    });
  });
  const pending = api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  await vi.waitFor(() => expect(resolveAttach).toBeTypeOf('function'));
  debuggerApi.emit('message', {}, 'Runtime.bindingCalled', { payload: 'native-secret' });
  expect(send).not.toHaveBeenCalled();
  resolveAttach({ sessionId: 'owned-session' });
  await pending;
  debuggerApi.sendCommand.mockResolvedValue({});
  await api.dispose();
});
it('does not dispatch navigation if unload occurs during URL validation and session cleanup is pending', async () => {
  const { api, event, debuggerApi, session, validateUrl } = setup();
  await api.handle(event, 'attach', [{ tabId: 42 }, '1.3']);
  let resolveUrl!: (value: string) => void;
  let resolveDetach!: (value: Record<string, unknown>) => void;
  validateUrl.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveUrl = resolve;
      }),
  );
  const pending = api.handle(event, 'sendCommand', [
    { tabId: 42 },
    'Page.navigate',
    { url: 'https://example.com/next' },
  ]);
  debuggerApi.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveDetach = resolve;
      }),
  );
  session.extensions.emit('extension-unloaded', {}, { id: 'a'.repeat(32) });
  await vi.waitFor(() => expect(resolveDetach).toBeTypeOf('function'));
  resolveUrl('https://example.com/next');
  await expect(pending).rejects.toThrow();
  expect(debuggerApi.sendCommand.mock.calls.some(([method]) => method === 'Page.navigate')).toBe(
    false,
  );
  resolveDetach({});
  await api.dispose();
});
