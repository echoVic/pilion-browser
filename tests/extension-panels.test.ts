import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const electron = await vi.hoisted(async () => ({
  app: new (await import('node:events')).EventEmitter(),
  windows: [] as {
    loaded: string;
    options: Electron.BrowserWindowConstructorOptions;
    isDestroyed(): boolean;
  }[],
}));
vi.mock('electron', () => ({
  app: electron.app,
  webContents: { getAllWebContents: () => [] },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    destroyed = false;
    loaded = '';
    constructor(public options: Electron.BrowserWindowConstructorOptions) {
      super();
      electron.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    async loadURL(url: string) {
      this.loaded = url;
    }
    showInactive() {}
    show() {}
    setBounds() {}
    destroy() {
      this.close();
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  },
}));
vi.mock('../src/main/window-focus.js', () => ({ showWindow: vi.fn() }));
import { ExtensionPanels } from '../src/main/extension-panels';
const id = 'a'.repeat(32);
function setup(permission = true) {
  const session = Object.assign(new EventEmitter(), {
    registerPreloadScript: vi.fn(() => 'script'),
    unregisterPreloadScript: vi.fn(),
    extensions: Object.assign(new EventEmitter(), {
      getExtension: (key: string) =>
        key === id
          ? {
              id,
              manifest: {
                permissions: permission ? ['sidePanel'] : [],
                side_panel: { default_path: 'panel.html' },
              },
            }
          : undefined,
    }),
    serviceWorkers: Object.assign(new EventEmitter(), {
      getAllRunning: () => ({}),
      getWorkerFromVersionID: (): Electron.ServiceWorkerMain | undefined => undefined,
    }),
  });
  const parent = Object.assign(new EventEmitter(), {
    id: 7,
    getContentBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
    isDestroyed: () => false,
  });
  const panels = new ExtensionPanels({
    session: session as unknown as Electron.Session,
    parent: () => parent as unknown as Electron.BrowserWindow,
    preload: '/tmp/panel.cjs',
    noFocus: true,
  });
  const event = {
    type: 'frame',
    sender: { session },
    senderFrame: { url: `chrome-extension://${id}/page.html` },
  } as unknown as Electron.IpcMainInvokeEvent;
  return { panels, session, event };
}
beforeEach(() => {
  electron.windows.length = 0;
  electron.app.removeAllListeners();
});
it('inherits manifest defaults and isolates tab options without discarding an existing path', async () => {
  const { panels, event } = setup();
  expect(await panels.handle(event, 'getOptions', {})).toEqual({
    enabled: true,
    path: 'panel.html',
  });
  await panels.handle(event, 'setOptions', { tabId: 42, path: 'tab.html' });
  await panels.handle(event, 'setOptions', { tabId: 42, enabled: false });
  expect(await panels.handle(event, 'getOptions', { tabId: 42 })).toEqual({
    tabId: 42,
    enabled: false,
    path: 'tab.html',
  });
  expect(await panels.handle(event, 'getOptions', {})).toEqual({
    enabled: true,
    path: 'panel.html',
  });
});
it.each([
  'https://evil.test/panel',
  '//evil.test/panel',
  '../panel.html',
  '%2e%2e/panel.html',
  'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/panel.html',
])('rejects escaped panel path %s', async (path) => {
  const { panels, event } = setup();
  await expect(panels.handle(event, 'setOptions', { path })).rejects.toThrow();
});
it('rejects page impostors, another session, and extensions lacking permission', async () => {
  const { panels, event } = setup();
  await expect(
    panels.handle(
      { ...event, senderFrame: { url: 'https://example.com' } as Electron.WebFrameMain },
      'open',
      {},
    ),
  ).rejects.toThrow();
  await expect(
    panels.handle({ ...event, sender: { session: {} } as Electron.WebContents }, 'open', {}),
  ).rejects.toThrow();
  const unprivileged = setup(false);
  await expect(unprivileged.panels.handle(unprivileged.event, 'open', {})).rejects.toThrow();
});
it('opens the real extension URL in an isolated window sharing the extension session, then closes it', async () => {
  const { panels, session } = setup();
  await panels.open(id);
  const window = electron.windows[0];
  expect(window.loaded).toBe(`chrome-extension://${id}/panel.html`);
  expect(window.options.webPreferences).toMatchObject({
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  panels.close(id);
  expect(window.isDestroyed()).toBe(true);
});
it('rejects disabled panels and unsupported requests instead of returning empty success', async () => {
  const { panels, event } = setup();
  await panels.handle(event, 'setOptions', { enabled: false });
  await expect(panels.open(id)).rejects.toThrow();
  await expect(panels.handle(event, 'unknown', {})).rejects.toThrow();
});

it('validates worker identity against the owning session, script origin, and live version', async () => {
  const { panels, session } = setup();
  const worker = {
    isDestroyed: () => false,
    scope: `chrome-extension://${id}/`,
    scriptURL: `chrome-extension://${id}/worker.js`,
  };
  session.serviceWorkers.getWorkerFromVersionID = () =>
    worker as unknown as Electron.ServiceWorkerMain;
  const event = {
    type: 'service-worker',
    session,
    versionId: 5,
    serviceWorker: worker,
  } as unknown as Electron.IpcMainServiceWorkerInvokeEvent;
  expect(await panels.handle(event, 'getPanelBehavior', {})).toEqual({
    openPanelOnActionClick: false,
  });
  await panels.handle(event, 'setPanelBehavior', { openPanelOnActionClick: true });
  expect(panels.opensOnActionClick(id)).toBe(true);
  await expect(
    panels.handle(
      { ...event, serviceWorker: { ...worker } as Electron.ServiceWorkerMain },
      'getOptions',
      {},
    ),
  ).rejects.toThrow();
});

it('defers toolbar clicks to the extension action when its selected-tab panel is disabled', async () => {
  const { panels, event } = setup();
  await panels.handle(event, 'setPanelBehavior', { openPanelOnActionClick: true });
  await panels.handle(event, 'setOptions', { enabled: false });
  expect(panels.opensOnActionClick(id)).toBe(false);
  await panels.handle(event, 'setOptions', { tabId: 42, enabled: true, path: 'panel.html' });
  expect(panels.opensOnActionClick(id, 42)).toBe(true);
  expect(panels.opensOnActionClick(id, 43)).toBe(false);
  await panels.handle(event, 'setOptions', { tabId: 42, enabled: false });
  expect(panels.opensOnActionClick(id, 42)).toBe(false);
});

it('destroys an unloaded owner panel and restores defaults when that extension loads again', async () => {
  const { panels, session, event } = setup();
  await panels.handle(event, 'setOptions', { tabId: 42, path: 'override.html', enabled: true });
  await panels.handle(event, 'setPanelBehavior', { openPanelOnActionClick: true });
  await panels.open(id, 42);
  const window = electron.windows[0];
  session.extensions.emit('extension-unloaded', {}, { id: 'b'.repeat(32) });
  expect(window.isDestroyed()).toBe(false);
  session.extensions.emit('extension-unloaded', {}, { id });
  expect(window.isDestroyed()).toBe(true);
  expect(await panels.handle(event, 'getOptions', { tabId: 42 })).toEqual({
    tabId: 42,
    enabled: true,
    path: 'panel.html',
  });
  expect(await panels.handle(event, 'getPanelBehavior', {})).toEqual({
    openPanelOnActionClick: false,
  });
  await panels.open(id);
  expect(electron.windows[1].loaded).toBe(`chrome-extension://${id}/panel.html`);
  panels.dispose();
  expect(session.extensions.listenerCount('extension-unloaded')).toBe(0);
});
