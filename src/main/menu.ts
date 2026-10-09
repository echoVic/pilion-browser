import { app, Menu, shell, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { acceleratorFor, type AppAction, type ShortcutAction } from '../shared/keybindings.js';

/** 菜单里随状态变化的那部分。主进程只在它变了的时候重建菜单。 */
export interface MenuState {
  closedTabs: readonly { title: string; url: string }[];
  agentConnected: boolean;
  attached: boolean;
  agentDriving: boolean;
  manualTask: boolean;
  agentBusy: boolean;
  recording: boolean;
  /** Agent 正在操作页面或技能在回放：导航与缩放不可用，和界面上的按钮一致。 */
  navigationLocked: boolean;
  canRecord: boolean;
}

export interface MenuHandlers {
  /** origin 是触发菜单时的焦点窗口，设置窗口在前时 ⌘W 关的是它而不是标签页。 */
  run(action: AppAction, origin: BaseWindow | undefined): void;
  openSettings(): void;
  reopenClosedTab(index: number, origin: BaseWindow | undefined): void;
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

export function buildMenu(state: MenuState, handlers: MenuHandlers): Menu {
  const mac = process.platform === 'darwin';
  const item = (
    label: string,
    action: AppAction,
    options: MenuItemConstructorOptions = {},
  ): MenuItemConstructorOptions => ({
    id: action,
    label,
    click: (_item, origin) => handlers.run(action, origin),
    ...options,
  });
  const shortcut = (
    label: string,
    action: ShortcutAction,
    options: MenuItemConstructorOptions = {},
  ): MenuItemConstructorOptions =>
    item(label, action, { accelerator: acceleratorFor(action), ...options });
  const settings: MenuItemConstructorOptions = {
    id: 'settings',
    label: '设置…',
    accelerator: acceleratorFor('settings'),
    click: () => handlers.openSettings(),
  };
  const quit: MenuItemConstructorOptions = { role: 'quit', label: '退出 Pilion' };
  const closedTabs = state.closedTabs
    .map((tab, index) => ({ tab, index }))
    .reverse()
    .map(({ tab, index }) => ({
      label: truncate(tab.title || tab.url),
      click: (_item: unknown, origin: BaseWindow | undefined) =>
        handlers.reopenClosedTab(index, origin),
    }));
  const unlessLocked = { enabled: !state.navigationLocked };

  return Menu.buildFromTemplate([
    ...(mac
      ? [
          {
            label: 'Pilion',
            submenu: [
              { role: 'about', label: '关于 Pilion' },
              separator,
              settings,
              separator,
              { role: 'services', label: '服务' },
              separator,
              { role: 'hide', label: '隐藏 Pilion' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              separator,
              quit,
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: '文件',
      submenu: [
        shortcut('新建标签页', 'newTab'),
        shortcut('打开位置…', 'focusAddress'),
        shortcut('重新打开关闭的标签页', 'reopenClosedTab', {
          enabled: state.closedTabs.length > 0,
        }),
        separator,
        shortcut('关闭标签页', 'closeTab'),
        separator,
        item('新对话', 'newConversation'),
        item('从 Chrome 导入 Cookie…', 'importCookies'),
        ...(mac ? [] : [separator, settings, separator, quit]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        separator,
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
        separator,
        shortcut('查找…', 'find'),
      ],
    },
    {
      label: '显示',
      submenu: [
        item('显示或隐藏侧边栏', 'toggleSidebar'),
        item('显示或隐藏 Agent 面板', 'togglePanel'),
        separator,
        shortcut('刷新', 'reload', unlessLocked),
        item('停止载入', 'stopLoading', unlessLocked),
        separator,
        shortcut('实际大小', 'resetZoom', unlessLocked),
        shortcut('放大', 'zoomIn', unlessLocked),
        shortcut('缩小', 'zoomOut', unlessLocked),
        separator,
        item('对话记录', 'showConversations'),
        item('下载', 'showDownloads'),
        ...(app.isPackaged ? [] : [separator, { role: 'toggleDevTools', label: '开发者工具' }]),
      ] as MenuItemConstructorOptions[],
    },
    {
      label: '历史记录',
      submenu: [
        shortcut('后退', 'back', unlessLocked),
        shortcut('前进', 'forward', unlessLocked),
        separator,
        item('显示全部历史记录', 'showHistory'),
        {
          label: '最近关闭的标签页',
          enabled: closedTabs.length > 0,
          submenu: closedTabs.length ? closedTabs : [{ label: '无', enabled: false }],
        },
      ],
    },
    {
      label: '书签',
      submenu: [
        shortcut('添加或移除书签', 'toggleBookmark'),
        item('显示全部书签', 'showBookmarks'),
      ],
    },
    {
      label: 'Agent',
      submenu: [
        item('管理 Agent 连接…', 'agentConnections'),
        separator,
        state.attached
          ? item('暂停浏览器权限', 'detachAgent', { enabled: state.agentConnected })
          : item('共享浏览器', 'attachAgent', { enabled: state.agentConnected }),
        item('接管浏览器', 'takeOver', { enabled: state.agentDriving }),
        item('停止任务', 'cancelTask', { enabled: state.agentDriving || state.manualTask }),
        item('继续任务', 'resumeTask', { enabled: state.manualTask && !state.agentBusy }),
        separator,
        item('断开 Agent', 'disconnectAgent', {
          enabled: state.agentConnected && !state.agentBusy,
        }),
        separator,
        item(state.recording ? '停止录制…' : '开始录制', 'toggleRecording', {
          enabled: state.canRecord,
        }),
        item('技能库', 'showSkills'),
      ],
    },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(mac ? [separator, { role: 'front', label: '前置全部窗口' }] : []),
      ] as MenuItemConstructorOptions[],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        {
          label: 'Pilion 使用说明',
          click: () => void shell.openExternal('https://github.com/echoVic/pilion-browser#readme'),
        },
        {
          label: '反馈问题',
          click: () => void shell.openExternal('https://github.com/echoVic/pilion-browser/issues'),
        },
        ...(mac ? [] : [separator, { role: 'about', label: '关于 Pilion' }]),
      ] as MenuItemConstructorOptions[],
    },
  ]);
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
