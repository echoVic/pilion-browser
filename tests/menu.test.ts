import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { buildMenu, type MenuState } from '../src/main/menu';
import * as keybindings from '../src/shared/keybindings';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template },
  shell: {},
}));

afterEach(() => vi.restoreAllMocks());

function shortcutItems() {
  const state: MenuState = {
    closedTabs: [],
    agentConnected: false,
    attached: false,
    agentDriving: false,
    manualTask: false,
    agentBusy: false,
    recording: false,
    navigationLocked: false,
    canRecord: false,
  };
  const menu = buildMenu(state, {
    run() {},
    openSettings() {},
    checkForUpdates() {},
    reopenClosedTab() {},
  }) as unknown as MenuItemConstructorOptions[];
  return menu
    .flatMap((item) => item.submenu as MenuItemConstructorOptions[])
    .filter((item) => item.accelerator);
}

it('preserves the visible labels and accelerators of shortcut menu items', () => {
  expect(
    Object.fromEntries(shortcutItems().map((item) => [item.id, [item.label, item.accelerator]])),
  ).toEqual({
    settings: ['设置…', 'CmdOrCtrl+,'],
    newTab: ['新建标签页', 'CmdOrCtrl+T'],
    focusAddress: ['打开位置…', 'CmdOrCtrl+L'],
    reopenClosedTab: ['重新打开关闭的标签页', 'CmdOrCtrl+Shift+T'],
    closeTab: ['关闭标签页', 'CmdOrCtrl+W'],
    find: ['查找…', 'CmdOrCtrl+F'],
    reload: ['刷新', 'CmdOrCtrl+R'],
    resetZoom: ['实际大小', 'CmdOrCtrl+0'],
    zoomIn: ['放大', 'CmdOrCtrl+='],
    zoomOut: ['缩小', 'CmdOrCtrl+-'],
    back: ['后退', 'CmdOrCtrl+['],
    forward: ['前进', 'CmdOrCtrl+]'],
    toggleBookmark: ['添加或移除书签', 'CmdOrCtrl+D'],
  });
});

it('reads every shortcut menu label from the shared definition and restores menu ellipses', () => {
  expect(keybindings).toHaveProperty('labelFor');
  vi.spyOn(keybindings, 'labelFor').mockImplementation((action) => `共享名称 ${action}`);
  const ellipses = ['focusAddress', 'find', 'settings'];
  for (const item of shortcutItems()) {
    expect(item.label).toBe(`共享名称 ${item.id}${ellipses.includes(item.id!) ? '…' : ''}`);
  }
});
