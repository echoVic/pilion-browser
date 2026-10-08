/**
 * Unified keybinding definitions for Pilion.
 *
 * This is the single source of truth for all keyboard shortcuts across:
 * - Menu accelerators (main process)
 * - Global shortcuts captured from browser views (main process)
 * - Renderer-side keyboard event handlers
 * - Settings UI (read-only display)
 */

export type KeybindingAction =
  | 'addressBar'
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
  | 'switchTab1'
  | 'switchTab2'
  | 'switchTab3'
  | 'switchTab4'
  | 'switchTab5'
  | 'switchTab6'
  | 'switchTab7'
  | 'switchTab8'
  | 'switchLastTab'
  | 'settings';

export interface Keybinding {
  action: KeybindingAction;
  key: string;
  /** macOS accelerator string for Menu.buildFromTemplate */
  mac: string;
  /** Renderer-side key identifier from KeyboardEvent */
  eventKey: string;
  /** Human-readable label */
  label: string;
  /** Optional shift modifier */
  shift?: boolean;
  /** Optional ctrl modifier (for non-Mac platforms) */
  ctrl?: boolean;
}

/**
 * All keyboard shortcuts in Pilion.
 *
 * The `key` field is the shortcut identifier sent via IPC (main -> renderer).
 * The `mac` field is the Electron accelerator for native menus.
 * The `eventKey` field is what renderer's keydown listener sees.
 */
export const KEYBINDINGS: readonly Keybinding[] = [
  {
    action: 'addressBar',
    key: 'l',
    mac: 'CmdOrCtrl+L',
    eventKey: 'l',
    label: '跳转到地址栏',
  },
  {
    action: 'newTab',
    key: 't',
    mac: 'CmdOrCtrl+T',
    eventKey: 't',
    label: '新建标签页',
  },
  {
    action: 'reopenClosedTab',
    key: 'shift+t',
    mac: 'CmdOrCtrl+Shift+T',
    eventKey: 't',
    shift: true,
    label: '重新打开关闭的标签页',
  },
  {
    action: 'closeTab',
    key: 'w',
    mac: 'CmdOrCtrl+W',
    eventKey: 'w',
    label: '关闭标签页',
  },
  {
    action: 'reload',
    key: 'r',
    mac: 'CmdOrCtrl+R',
    eventKey: 'r',
    label: '刷新',
  },
  {
    action: 'find',
    key: 'f',
    mac: 'CmdOrCtrl+F',
    eventKey: 'f',
    label: '查找',
  },
  {
    action: 'back',
    key: '[',
    mac: 'CmdOrCtrl+[',
    eventKey: '[',
    label: '后退',
  },
  {
    action: 'forward',
    key: ']',
    mac: 'CmdOrCtrl+]',
    eventKey: ']',
    label: '前进',
  },
  {
    action: 'zoomIn',
    key: '=',
    mac: 'CmdOrCtrl+=',
    eventKey: '=',
    label: '放大',
  },
  {
    action: 'zoomOut',
    key: '-',
    mac: 'CmdOrCtrl+-',
    eventKey: '-',
    label: '缩小',
  },
  {
    action: 'resetZoom',
    key: '0',
    mac: 'CmdOrCtrl+0',
    eventKey: '0',
    label: '实际大小',
  },
  {
    action: 'switchTab1',
    key: '1',
    mac: 'CmdOrCtrl+1',
    eventKey: '1',
    label: '切换到第 1 个标签页',
  },
  {
    action: 'switchTab2',
    key: '2',
    mac: 'CmdOrCtrl+2',
    eventKey: '2',
    label: '切换到第 2 个标签页',
  },
  {
    action: 'switchTab3',
    key: '3',
    mac: 'CmdOrCtrl+3',
    eventKey: '3',
    label: '切换到第 3 个标签页',
  },
  {
    action: 'switchTab4',
    key: '4',
    mac: 'CmdOrCtrl+4',
    eventKey: '4',
    label: '切换到第 4 个标签页',
  },
  {
    action: 'switchTab5',
    key: '5',
    mac: 'CmdOrCtrl+5',
    eventKey: '5',
    label: '切换到第 5 个标签页',
  },
  {
    action: 'switchTab6',
    key: '6',
    mac: 'CmdOrCtrl+6',
    eventKey: '6',
    label: '切换到第 6 个标签页',
  },
  {
    action: 'switchTab7',
    key: '7',
    mac: 'CmdOrCtrl+7',
    eventKey: '7',
    label: '切换到第 7 个标签页',
  },
  {
    action: 'switchTab8',
    key: '8',
    mac: 'CmdOrCtrl+8',
    eventKey: '8',
    label: '切换到第 8 个标签页',
  },
  {
    action: 'switchLastTab',
    key: '9',
    mac: 'CmdOrCtrl+9',
    eventKey: '9',
    label: '切换到最后一个标签页',
  },
  {
    action: 'settings',
    key: ',',
    mac: 'CmdOrCtrl+,',
    eventKey: ',',
    label: '设置',
  },
] as const;

/**
 * Get keybinding by action.
 */
export function getKeybinding(action: KeybindingAction): Keybinding | undefined {
  return KEYBINDINGS.find((kb) => kb.action === action);
}

/**
 * Get keybinding by key identifier (for IPC routing).
 */
export function getKeybindingByKey(key: string): Keybinding | undefined {
  return KEYBINDINGS.find((kb) => kb.key === key);
}
