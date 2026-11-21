import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ app: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('electron', () => ({ ...electron, webContents: { getAllWebContents: () => [] } }));
import { ExtensionTabGroups } from '../src/main/extension-tab-groups';
const id = 'a'.repeat(32);
function setup(
  permissions = ['tabGroups'],
  commands = {},
  changes?: {
    open: (url: string, active: boolean) => Promise<{ id: number; windowId: number }>;
    close: (id: number) => Promise<void>;
  },
) {
  const session = {
    registerPreloadScript: vi.fn(() => 'preload'),
    unregisterPreloadScript: vi.fn(),
    extensions: {
      getExtension: (key: string) =>
        key === id ? { manifest: { permissions, commands } } : undefined,
      getAllExtensions: () => [{ id, manifest: { permissions, commands } }],
    },
    serviceWorkers: Object.assign(new EventEmitter(), {
      getAllRunning: () => ({}),
      getWorkerFromVersionID: vi.fn(),
    }),
  };
  const tabs = [1, 2, 3].map((tabId) =>
    Object.assign(new EventEmitter(), {
      id: tabId,
      session,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
    }),
  );
  const groups = new ExtensionTabGroups({
    session: session as unknown as Electron.Session,
    parent: () => ({ id: 7 }) as Electron.BrowserWindow,
    tabs: () => tabs as unknown as Electron.WebContents[],
    preload: '/tmp/groups.cjs',
    openWebTab: changes?.open,
    closeWebTab: changes?.close,
  });
  const frame = { url: `chrome-extension://${id}/options.html`, send: vi.fn() };
  const event = {
    type: 'frame',
    sender: { session },
    senderFrame: frame,
  } as unknown as Electron.IpcMainInvokeEvent;
  return { groups, tabs, session, event, frame };
}
beforeEach(() => vi.clearAllMocks());
it('groups actual native tabs and updates shared metadata; removes only when final member closes', async () => {
  const { groups, tabs, event, frame } = setup();
  await groups.handle(event, 'subscribe', []);
  const groupId = await groups.handle(event, 'tabs.group', [{ tabIds: [1, 2] }]);
  expect(groups.groupIdFor(1)).toBe(groupId);
  expect(groups.groupIdFor(3)).toBe(-1);
  await groups.handle(event, 'update', [
    groupId,
    { title: '内容发布', color: 'blue', collapsed: false },
  ]);
  expect(await groups.handle(event, 'query', [{ title: '内容*' }])).toEqual([
    expect.objectContaining({ id: groupId, title: '内容发布', color: 'blue', windowId: 7 }),
  ]);
  tabs[0].destroyed = true;
  tabs[0].emit('destroyed');
  expect(await groups.handle(event, 'get', [groupId])).toMatchObject({ id: groupId });
  tabs[1].destroyed = true;
  tabs[1].emit('destroyed');
  await expect(groups.handle(event, 'get', [groupId])).rejects.toThrow();
  expect(frame.send.mock.calls.map((args) => args[1])).toEqual([
    'onCreated',
    'onUpdated',
    'onRemoved',
  ]);
  groups.dispose();
});
it('rejects invalid tabs atomically, page IPC, foreign sessions, missing metadata permission', async () => {
  const { groups, event } = setup();
  await expect(groups.handle(event, 'tabs.group', [{ tabIds: [1, 999] }])).rejects.toThrow();
  expect(groups.groupIdFor(1)).toBe(-1);
  await expect(
    groups.handle(
      { ...event, senderFrame: { url: 'https://example.com' } } as Electron.IpcMainInvokeEvent,
      'tabs.group',
      [{ tabIds: 1 }],
    ),
  ).rejects.toThrow();
  await expect(
    groups.handle({ ...event, sender: { session: {} } } as Electron.IpcMainInvokeEvent, 'query', [
      {},
    ]),
  ).rejects.toThrow();
  const unprivileged = setup([]);
  expect(
    await unprivileged.groups.handle(unprivileged.event, 'tabs.group', [{ tabIds: 1 }]),
  ).toBeTypeOf('number');
  await expect(unprivileged.groups.handle(unprivileged.event, 'query', [{}])).rejects.toThrow();
  groups.dispose();
  unprivileged.groups.dispose();
});
it('ungroups/reassigns members without changing other tabs and rejects invalid updates/moves', async () => {
  const { groups, event } = setup();
  const first = await groups.handle(event, 'tabs.group', [{ tabIds: [1, 2] }]);
  const second = await groups.handle(event, 'tabs.group', [{ tabIds: 3 }]);
  await groups.handle(event, 'tabs.group', [{ tabIds: 1, groupId: second }]);
  expect(groups.groupIdFor(2)).toBe(first);
  await groups.handle(event, 'tabs.ungroup', [[1, 3]]);
  await expect(groups.handle(event, 'get', [second])).rejects.toThrow();
  await expect(groups.handle(event, 'update', [first, { color: 'bogus' }])).rejects.toThrow();
  await expect(groups.handle(event, 'move', [first, { index: 0 }])).rejects.toThrow('reordering');
  groups.dispose();
});
it('rejects forged/stale/foreign worker identity and validates the extension worker scope', async () => {
  const { groups, session } = setup();
  const worker = {
    isDestroyed: () => false,
    scriptURL: `chrome-extension://${id}/worker.js`,
    scope: `chrome-extension://${id}/`,
    send: vi.fn(),
  };
  session.serviceWorkers.getWorkerFromVersionID.mockReturnValue(worker);
  const event = {
    type: 'service-worker',
    session,
    serviceWorker: worker,
    versionId: 4,
  } as unknown as Electron.IpcMainServiceWorkerInvokeEvent;
  expect(await groups.handle(event, 'query', [{}])).toEqual([]);
  await expect(
    groups.handle(
      {
        ...event,
        serviceWorker: { ...worker },
      } as unknown as Electron.IpcMainServiceWorkerInvokeEvent,
      'query',
      [{}],
    ),
  ).rejects.toThrow();
  await expect(
    groups.handle({ ...event, session: {} } as Electron.IpcMainServiceWorkerInvokeEvent, 'query', [
      {},
    ]),
  ).rejects.toThrow();
  worker.scope = 'https://example.com/';
  await expect(groups.handle(event, 'query', [{}])).rejects.toThrow();
  groups.dispose();
});
it('does not send group events to a subscribed extension frame after it navigates to a web page', async () => {
  const { groups, event, frame } = setup();
  await groups.handle(event, 'subscribe', []);
  frame.url = 'https://example.com';
  const caller = {
    ...event,
    senderFrame: { url: `chrome-extension://${id}/other.html` },
  } as Electron.IpcMainInvokeEvent;
  await groups.handle(caller, 'tabs.group', [{ tabIds: 1 }]);
  expect(frame.send).not.toHaveBeenCalled();
  groups.dispose();
});

it('returns the host browser window to a same-session extension', async () => {
  const { groups, event } = setup([]);
  await expect(groups.handle(event, 'windows.getCurrent', [])).resolves.toMatchObject({
    id: 7,
    type: 'normal',
    incognito: false,
  });
  await expect(
    groups.handle(
      { ...event, senderFrame: { url: 'https://example.test/' } as Electron.WebFrameMain },
      'windows.getCurrent',
      [],
    ),
  ).rejects.toThrow();
});

it('groups context menu items under their registered parent and delivers only the clicked item', async () => {
  const { groups, event, frame, tabs } = setup(['contextMenus']);
  await groups.handle(event, 'contextMenus.subscribe', []);
  await groups.handle(event, 'contextMenus.create', [
    { id: 'parent', title: 'Published tools', contexts: ['all'] },
  ]);
  await groups.handle(event, 'contextMenus.create', [
    { id: 'child', parentId: 'parent', title: 'Inspect page', contexts: ['all'] },
  ]);
  const items = groups.contextMenuItems(
    tabs[0] as unknown as Electron.WebContents,
    { pageURL: 'https://example.test/' } as Electron.ContextMenuParams,
  );
  expect(items[0]).toMatchObject({
    label: 'Published tools',
    submenu: [{ label: 'Inspect page' }],
  });
  const submenu = items[0].submenu as Electron.MenuItemConstructorOptions[];
  await submenu[0].click!(null!, null!, null!);
  expect(frame.send).toHaveBeenCalledWith(
    'pilion:extension-tab-groups:event',
    'contextMenus.onClicked',
    { menuItemId: 'child', pageUrl: 'https://example.test/' },
  );
  await groups.handle(event, 'contextMenus.removeAll', []);
  expect(
    groups.contextMenuItems(
      tabs[0] as unknown as Electron.WebContents,
      { pageURL: 'https://example.test/' } as Electron.ContextMenuParams,
    ),
  ).toEqual([]);
  const unprivileged = setup([]);
  await expect(
    unprivileged.groups.handle(unprivileged.event, 'contextMenus.create', [
      { id: 'test', title: 'Disallowed' },
    ]),
  ).rejects.toThrow(/permission/);
});

it('emits a command for an active native tab only when the extension declares the shortcut', async () => {
  const { groups, event, frame, tabs } = setup([], {
    'test-command': { suggested_key: { default: 'Alt+S' } },
  });
  await groups.handle(event, 'commands.subscribe', []);
  const active = tabs[0] as unknown as Electron.WebContents;
  const input = { type: 'keyDown', key: 's', code: 'KeyS', alt: true } as Electron.Input;
  expect(groups.dispatchCommand(active, input)).toBe(true);
  expect(frame.send).toHaveBeenCalledWith(
    'pilion:extension-tab-groups:event',
    'commands.onCommand',
    'test-command',
  );
  expect(groups.dispatchCommand(active, { ...input, code: 'KeyX' })).toBe(false);
});

it('routes download and navigation events only to a subscribed extension with that permission', async () => {
  const { groups, event, frame } = setup(['downloads']);
  await groups.handle(event, 'downloads.subscribe', []);
  await expect(groups.handle(event, 'webNavigation.subscribe', [])).rejects.toThrow(/permission/);
  groups.emitBrowserEvent('downloads.onCreated', { id: 19 });
  groups.emitBrowserEvent('webNavigation.onCreatedNavigationTarget', { tabId: 51 });
  expect(frame.send.mock.calls).toEqual([
    ['pilion:extension-tab-groups:event', 'downloads.onCreated', { id: 19 }],
  ]);
});

it('opens only browser URLs and lets an extension close only its own created tabs', async () => {
  const open = vi.fn(async () => ({ id: 1, windowId: 7 }));
  const close = vi.fn(async () => undefined);
  const { groups, event } = setup(['tabs'], {}, { open, close });
  await expect(
    groups.handle(event, 'tabs.createWeb', [{ url: 'file:///tmp/private' }]),
  ).rejects.toThrow(/web URL/);
  await expect(
    groups.handle(event, 'tabs.createWeb', [{ url: 'https://example.test/a', active: false }]),
  ).resolves.toEqual({ id: 1, windowId: 7 });
  expect(open).toHaveBeenCalledWith('https://example.test/a', false);
  await expect(groups.handle(event, 'tabs.removeOwned', [[1, 2]])).rejects.toThrow(/own/);
  expect(close).not.toHaveBeenCalled();
  await groups.handle(event, 'tabs.removeOwned', [1]);
  expect(close).toHaveBeenCalledWith(1);
});

it('reports actual group membership for a tracked tab and delivers its finished load', async () => {
  const { groups, event, frame, tabs } = setup(['tabs', 'tabGroups']);
  const id = await groups.handle(event, 'tabs.group', [{ tabIds: [1] }]);
  await expect(groups.handle(event, 'tabs.getUiMetadata', [1])).resolves.toEqual({
    windowId: 7,
    groupId: id,
  });
  await expect(groups.handle(event, 'tabs.getUiMetadata', [999])).rejects.toThrow();
  await groups.handle(event, 'tabs.subscribe', []);
  groups.tabCompleted(1, 'https://example.test/', 'Example');
  expect(frame.send).toHaveBeenCalledWith('pilion:extension-tab-groups:event', 'tabs.onUpdated', [
    1,
    { status: 'complete' },
    {
      id: 1,
      url: 'https://example.test/',
      title: 'Example',
      status: 'complete',
      windowId: 7,
      groupId: id,
    },
  ]);
  expect(tabs[0].id).toBe(1);
});
