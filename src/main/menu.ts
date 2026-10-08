import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type WebPreferences,
} from 'electron';
import { join } from 'node:path';
import type { AppState } from '../shared/contracts.js';
import type { SettingsStore } from './settings-store.js';
import { KEYBINDINGS } from '../shared/keybindings.js';

// IPC channels specific to settings window
export const SETTINGS_IPC = Object.freeze({
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  appCommand: 'app:command',
});

type MenuCallbacks = {
  openTab(): void;
  reopenClosedTab(): void;
  closeActiveTab(): void;
  newConversation(): void;
  importCookies(): void;
  reload(): void;
  stopLoad(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  back(): void;
  forward(): void;
  showBookmarks(): void;
  toggleBookmark(): void;
  showHistory(): void;
  clearHistory(): void;
  showDownloads(): void;
  agentAttach(): void;
  agentDetach(): void;
  agentCancel(): void;
  agentResume(): void;
  recordingStart(): void;
  recordingStop(): void;
  showSkills(): void;
  openSettings(): void;
  getClosedTabs(): { url: string; title: string }[];
  reopenTabByUrl(url: string): void;
};

function kb(action: string): string {
  const found = KEYBINDINGS.find((kb) => kb.action === action);
  return found?.mac ?? '';
}

export function buildMenu(
  callbacks: MenuCallbacks,
  state: Pick<AppState, 'agentStatus' | 'attachmentStatus'>,
): Menu {
  const agentRunning = state.agentStatus === 'running';
  const agentBusy = ['starting', 'stopping', 'running'].includes(state.agentStatus);
  const attached = state.attachmentStatus === 'attached';

  const closedTabs = callbacks.getClosedTabs();

  return Menu.buildFromTemplate([
    {
      label: 'Pilion',
      submenu: [
        {
          label: '关于 Pilion',
          role: 'about',
        },
        {
          label: '设置…',
          accelerator: kb('settings'),
          click: () => callbacks.openSettings(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建标签页',
          accelerator: kb('newTab'),
          click: () => callbacks.openTab(),
        },
        {
          label: '重新打开关闭的标签页',
          accelerator: kb('reopenClosedTab'),
          click: () => callbacks.reopenClosedTab(),
        },
        {
          label: '关闭标签页',
          accelerator: kb('closeTab'),
          click: () => callbacks.closeActiveTab(),
        },
        { type: 'separator' },
        {
          label: '新建对话',
          click: () => callbacks.newConversation(),
        },
        { type: 'separator' },
        {
          label: '导入 Chrome Cookie…',
          click: () => callbacks.importCookies(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        {
          label: '刷新',
          accelerator: kb('reload'),
          click: () => callbacks.reload(),
        },
        {
          label: '停止',
          click: () => callbacks.stopLoad(),
        },
        { type: 'separator' },
        {
          label: '放大',
          accelerator: kb('zoomIn'),
          click: () => callbacks.zoomIn(),
        },
        {
          label: '缩小',
          accelerator: kb('zoomOut'),
          click: () => callbacks.zoomOut(),
        },
        {
          label: '实际大小',
          accelerator: kb('resetZoom'),
          click: () => callbacks.resetZoom(),
        },
        { type: 'separator' },
        {
          label: '查找',
          accelerator: kb('find'),
          click: () => callbacks.reload(), // routed through app:command below
        },
        {
          label: '显示/隐藏侧边栏',
          click: () => undefined, // routed through app:command
        },
        {
          label: '显示/隐藏 Agent 面板',
          click: () => undefined, // routed through app:command
        },
      ],
    },
    {
      label: '历史记录',
      submenu: [
        {
          label: '后退',
          accelerator: kb('back'),
          click: () => callbacks.back(),
        },
        {
          label: '前进',
          accelerator: kb('forward'),
          click: () => callbacks.forward(),
        },
        { type: 'separator' },
        ...(closedTabs.length > 0
          ? [
              {
                label: '最近关闭的标签页',
                submenu: closedTabs.slice(0, 20).map((tab) => ({
                  label: tab.title || tab.url,
                  click: () => callbacks.reopenTabByUrl(tab.url),
                })),
              },
              { type: 'separator' as const },
            ]
          : []),
        {
          label: '显示全部历史',
          click: () => undefined, // routed through app:command
        },
        {
          label: '清除历史',
          click: () => callbacks.clearHistory(),
        },
      ],
    },
    {
      label: '书签',
      submenu: [
        {
          label: '添加/移除当前页',
          accelerator: 'CmdOrCtrl+D',
          click: () => callbacks.toggleBookmark(),
        },
        {
          label: '显示书签',
          click: () => callbacks.showBookmarks(),
        },
      ],
    },
    {
      label: '下载',
      submenu: [
        {
          label: '显示下载',
          click: () => callbacks.showDownloads(),
        },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: '接管浏览器',
          enabled: !attached && !agentBusy,
          click: () => callbacks.agentAttach(),
        },
        {
          label: '归还浏览器',
          enabled: attached,
          click: () => callbacks.agentDetach(),
        },
        { type: 'separator' },
        {
          label: '停止任务',
          enabled: agentRunning,
          click: () => callbacks.agentCancel(),
        },
        {
          label: '继续任务',
          enabled: !agentBusy && !agentRunning,
          click: () => callbacks.agentResume(),
        },
        { type: 'separator' },
        {
          label: '开始录制',
          click: () => callbacks.recordingStart(),
        },
        {
          label: '停止录制',
          click: () => callbacks.recordingStop(),
        },
        {
          label: '技能库',
          click: () => callbacks.showSkills(),
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'README',
          click: () =>
            void shell.openExternal('https://github.com/echoVic/pilion-browser#readme'),
        },
        {
          label: '反馈',
          click: () =>
            void shell.openExternal('https://github.com/echoVic/pilion-browser/issues'),
        },
      ],
    },
  ]);
}

/** Create and cache the settings window; subsequent calls show/focus it. */
export function openSettingsWindow(
  mainWindow: BrowserWindow,
  settingsStore: SettingsStore,
  __appDirname: string,
  existingWindow?: BrowserWindow,
): BrowserWindow {
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.show();
    existingWindow.focus();
    return existingWindow;
  }

  const preload = join(__appDirname, '../preload/entry.cjs');
  const webPreferences: WebPreferences = {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  };

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 480,
    title: 'Pilion 设置',
    parent: mainWindow,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences,
  });

  win.on('close', (event) => {
    // Hide instead of destroy so it can be re-shown quickly
    event.preventDefault();
    win.hide();
  });

  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    void win.loadURL(`${dev}?window=preferences`);
  } else {
    void win.loadFile(join(app.getAppPath(), 'dist-renderer/index.html'), {
      query: { window: 'preferences' },
    });
  }

  return win;
}

/** Register settings IPC handlers. Call once during init. */
export function registerSettingsIpc(settingsStore: SettingsStore): void {
  ipcMain.handle(SETTINGS_IPC.settingsGet, () => settingsStore.data);
  ipcMain.handle(SETTINGS_IPC.settingsSave, async (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('无效的设置数据');
    settingsStore.update(patch as Parameters<typeof settingsStore.update>[0]);
    await settingsStore.save();
    return settingsStore.data;
  });
}
