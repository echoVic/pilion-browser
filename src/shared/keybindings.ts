/**
 * 快捷键唯一的定义处。主窗口渲染层的 keydown、网页视图的 before-input-event 与原生菜单的
 * accelerator 都从这里取，改一处三处一起变。
 */

export type ShortcutAction =
  | 'focusAddress'
  | 'newTab'
  | 'reopenClosedTab'
  | 'closeTab'
  | 'reload'
  | 'find'
  | 'back'
  | 'forward'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'selectTab1'
  | 'selectTab2'
  | 'selectTab3'
  | 'selectTab4'
  | 'selectTab5'
  | 'selectTab6'
  | 'selectTab7'
  | 'selectTab8'
  | 'selectLastTab'
  | 'toggleBookmark'
  | 'settings';

/** 只有菜单项、没有快捷键的动作。和快捷键一样交给主窗口渲染层执行。 */
export type MenuAction =
  | 'stopLoading'
  | 'newConversation'
  | 'importCookies'
  | 'toggleSidebar'
  | 'togglePanel'
  | 'showBrowser'
  | 'showConversations'
  | 'showHistory'
  | 'showBookmarks'
  | 'showDownloads'
  | 'showSkills'
  | 'agentConnections'
  | 'attachAgent'
  | 'detachAgent'
  | 'takeOver'
  | 'cancelTask'
  | 'resumeTask'
  | 'disconnectAgent'
  | 'toggleRecording';

export type AppAction = ShortcutAction | MenuAction;

export const SHORTCUT_GROUPS = ['标签页', '导航', '页面', '其他'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface Keybinding {
  action: ShortcutAction;
  label: string;
  group: ShortcutGroup;
  /** KeyboardEvent.key 的小写形式。 */
  keys: readonly string[];
  /** 不写表示按没按 Shift 都算；⌘T 与 ⌘⇧T 这类靠它区分。 */
  shift?: boolean;
  accelerator: string;
  /**
   * 渲染层与网页视图自己处理、网页拿不到的快捷键。其余的只挂在菜单上：网页没拦下时
   * 由菜单接住，所以设置窗口里也能用。
   */
  intercepted: boolean;
}

const tab = (index: number): Keybinding => ({
  action: `selectTab${index}` as ShortcutAction,
  label: `切换到第 ${index} 个标签页`,
  group: '标签页',
  keys: [String(index)],
  accelerator: `CmdOrCtrl+${index}`,
  intercepted: true,
});

export const KEYBINDINGS: readonly Keybinding[] = [
  {
    action: 'focusAddress',
    label: '打开位置',
    group: '导航',
    keys: ['l', 'k'],
    accelerator: 'CmdOrCtrl+L',
    intercepted: true,
  },
  {
    action: 'newTab',
    label: '新建标签页',
    group: '标签页',
    keys: ['t'],
    shift: false,
    accelerator: 'CmdOrCtrl+T',
    intercepted: true,
  },
  {
    action: 'reopenClosedTab',
    label: '重新打开关闭的标签页',
    group: '标签页',
    keys: ['t'],
    shift: true,
    accelerator: 'CmdOrCtrl+Shift+T',
    intercepted: true,
  },
  {
    action: 'closeTab',
    label: '关闭标签页',
    group: '标签页',
    keys: ['w'],
    accelerator: 'CmdOrCtrl+W',
    intercepted: true,
  },
  {
    action: 'reload',
    label: '刷新',
    group: '页面',
    keys: ['r'],
    accelerator: 'CmdOrCtrl+R',
    intercepted: true,
  },
  {
    action: 'find',
    label: '查找',
    group: '页面',
    keys: ['f'],
    accelerator: 'CmdOrCtrl+F',
    intercepted: true,
  },
  {
    action: 'back',
    label: '后退',
    group: '导航',
    keys: ['['],
    accelerator: 'CmdOrCtrl+[',
    intercepted: true,
  },
  {
    action: 'forward',
    label: '前进',
    group: '导航',
    keys: [']'],
    accelerator: 'CmdOrCtrl+]',
    intercepted: true,
  },
  {
    action: 'zoomIn',
    label: '放大',
    group: '页面',
    keys: ['=', '+'],
    accelerator: 'CmdOrCtrl+=',
    intercepted: true,
  },
  {
    action: 'zoomOut',
    label: '缩小',
    group: '页面',
    keys: ['-'],
    accelerator: 'CmdOrCtrl+-',
    intercepted: true,
  },
  {
    action: 'resetZoom',
    label: '实际大小',
    group: '页面',
    keys: ['0'],
    accelerator: 'CmdOrCtrl+0',
    intercepted: true,
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(tab),
  {
    action: 'selectLastTab',
    label: '切换到最后一个标签页',
    group: '标签页',
    keys: ['9'],
    accelerator: 'CmdOrCtrl+9',
    intercepted: true,
  },
  {
    action: 'toggleBookmark',
    label: '添加或移除书签',
    group: '页面',
    keys: ['d'],
    accelerator: 'CmdOrCtrl+D',
    intercepted: false,
  },
  {
    action: 'settings',
    label: '设置',
    group: '其他',
    keys: [','],
    accelerator: 'CmdOrCtrl+,',
    intercepted: false,
  },
];

export interface KeyInput {
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
}

/** 渲染层和网页视图要自己接住的快捷键；不是这类的返回 undefined，留给网页和菜单。 */
export function interceptedShortcut(input: KeyInput): ShortcutAction | undefined {
  if (!(input.meta || input.control)) return undefined;
  const key = input.key.toLowerCase();
  const candidates = KEYBINDINGS.filter((item) => item.intercepted && item.keys.includes(key));
  return (
    candidates.find((item) => item.shift === input.shift) ??
    candidates.find((item) => item.shift === undefined)
  )?.action;
}

export function acceleratorFor(action: ShortcutAction): string {
  const binding = KEYBINDINGS.find((item) => item.action === action);
  if (!binding) throw new Error(`没有为 ${action} 定义快捷键`);
  return binding.accelerator;
}

export function labelFor(action: ShortcutAction): string {
  const binding = KEYBINDINGS.find((item) => item.action === action);
  if (!binding) throw new Error(`没有为 ${action} 定义快捷键`);
  return binding.label;
}

export interface ShortcutDisplayRow {
  action: ShortcutAction;
  label: string;
  group: ShortcutGroup;
  keys: readonly string[];
}

export function formatShortcut(key: string, shift: boolean, mac: boolean): string {
  const modifiers = mac ? `⌘${shift ? '⇧' : ''}` : `Ctrl+${shift ? 'Shift+' : ''}`;
  return `${modifiers}${key.toUpperCase()}`;
}

export function shortcutDisplayRows(mac: boolean): ShortcutDisplayRow[] {
  return SHORTCUT_GROUPS.flatMap((group) =>
    KEYBINDINGS.filter((binding) => binding.group === group).flatMap((binding) => {
      const numberedTab = /^selectTab[1-8]$/.test(binding.action);
      if (numberedTab && binding.action !== 'selectTab1') return [];
      return [
        {
          action: binding.action,
          label: numberedTab ? '切换到第 1–8 个标签页' : binding.label,
          group,
          keys: numberedTab
            ? [`${formatShortcut('1', false, mac)}–${formatShortcut('8', false, mac)}`]
            : binding.keys.map((key) => formatShortcut(key, binding.shift === true, mac)),
        },
      ];
    }),
  );
}
