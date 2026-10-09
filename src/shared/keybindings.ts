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

export interface Keybinding {
  action: ShortcutAction;
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
  keys: [String(index)],
  accelerator: `CmdOrCtrl+${index}`,
  intercepted: true,
});

export const KEYBINDINGS: readonly Keybinding[] = [
  { action: 'focusAddress', keys: ['l', 'k'], accelerator: 'CmdOrCtrl+L', intercepted: true },
  { action: 'newTab', keys: ['t'], shift: false, accelerator: 'CmdOrCtrl+T', intercepted: true },
  {
    action: 'reopenClosedTab',
    keys: ['t'],
    shift: true,
    accelerator: 'CmdOrCtrl+Shift+T',
    intercepted: true,
  },
  { action: 'closeTab', keys: ['w'], accelerator: 'CmdOrCtrl+W', intercepted: true },
  { action: 'reload', keys: ['r'], accelerator: 'CmdOrCtrl+R', intercepted: true },
  { action: 'find', keys: ['f'], accelerator: 'CmdOrCtrl+F', intercepted: true },
  { action: 'back', keys: ['['], accelerator: 'CmdOrCtrl+[', intercepted: true },
  { action: 'forward', keys: [']'], accelerator: 'CmdOrCtrl+]', intercepted: true },
  { action: 'zoomIn', keys: ['=', '+'], accelerator: 'CmdOrCtrl+=', intercepted: true },
  { action: 'zoomOut', keys: ['-'], accelerator: 'CmdOrCtrl+-', intercepted: true },
  { action: 'resetZoom', keys: ['0'], accelerator: 'CmdOrCtrl+0', intercepted: true },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(tab),
  { action: 'selectLastTab', keys: ['9'], accelerator: 'CmdOrCtrl+9', intercepted: true },
  { action: 'toggleBookmark', keys: ['d'], accelerator: 'CmdOrCtrl+D', intercepted: false },
  { action: 'settings', keys: [','], accelerator: 'CmdOrCtrl+,', intercepted: false },
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
