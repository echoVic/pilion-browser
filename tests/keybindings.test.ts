import { describe, expect, it } from 'vitest';
import * as keybindings from '../src/shared/keybindings';
import {
  acceleratorFor,
  interceptedShortcut,
  KEYBINDINGS,
  type KeyInput,
  type ShortcutAction,
} from '../src/shared/keybindings';

const press = (key: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key,
  meta: true,
  control: false,
  shift: false,
  ...modifiers,
});

describe('shortcut display', () => {
  it('groups rows in display order, collapses tabs 1–8 and keeps the last tab separate', () => {
    expect(keybindings).toHaveProperty('shortcutDisplayRows');
    expect(keybindings.shortcutDisplayRows(true)).toEqual([
      { action: 'newTab', label: '新建标签页', group: '标签页', keys: ['⌘T'] },
      { action: 'reopenClosedTab', label: '重新打开关闭的标签页', group: '标签页', keys: ['⌘⇧T'] },
      { action: 'closeTab', label: '关闭标签页', group: '标签页', keys: ['⌘W'] },
      { action: 'selectTab1', label: '切换到第 1–8 个标签页', group: '标签页', keys: ['⌘1–⌘8'] },
      { action: 'selectLastTab', label: '切换到最后一个标签页', group: '标签页', keys: ['⌘9'] },
      { action: 'focusAddress', label: '打开位置', group: '导航', keys: ['⌘L', '⌘K'] },
      { action: 'back', label: '后退', group: '导航', keys: ['⌘['] },
      { action: 'forward', label: '前进', group: '导航', keys: ['⌘]'] },
      { action: 'copyUrl', label: '复制当前网址', group: '导航', keys: ['⌘⇧C'] },
      { action: 'reload', label: '刷新', group: '页面', keys: ['⌘R'] },
      { action: 'find', label: '查找', group: '页面', keys: ['⌘F'] },
      { action: 'zoomIn', label: '放大', group: '页面', keys: ['⌘=', '⌘+'] },
      { action: 'zoomOut', label: '缩小', group: '页面', keys: ['⌘-'] },
      { action: 'resetZoom', label: '实际大小', group: '页面', keys: ['⌘0'] },
      { action: 'toggleBookmark', label: '添加或移除书签', group: '页面', keys: ['⌘D'] },
      { action: 'settings', label: '设置', group: '其他', keys: ['⌘,'] },
    ]);
  });

  it.each([
    ['t', false, '⌘T', 'Ctrl+T'],
    ['t', true, '⌘⇧T', 'Ctrl+Shift+T'],
    ['=', false, '⌘=', 'Ctrl+='],
    ['+', false, '⌘+', 'Ctrl++'],
    ['[', false, '⌘[', 'Ctrl+['],
    [']', false, '⌘]', 'Ctrl+]'],
    [',', false, '⌘,', 'Ctrl+,'],
  ])('formats %s with Shift=%s for macOS and other platforms', (key, shift, mac, other) => {
    expect(keybindings).toHaveProperty('formatShortcut');
    expect(keybindings.formatShortcut(key, shift, true)).toBe(mac);
    expect(keybindings.formatShortcut(key, shift, false)).toBe(other);
  });

  it('formats the collapsed range and all alternative keys for Windows and Linux', () => {
    expect(keybindings).toHaveProperty('shortcutDisplayRows');
    const rows = keybindings.shortcutDisplayRows(false);
    expect(rows.find((row) => row.action === 'selectTab1')?.keys).toEqual(['Ctrl+1–Ctrl+8']);
    expect(rows.find((row) => row.action === 'selectLastTab')?.keys).toEqual(['Ctrl+9']);
    expect(rows.find((row) => row.action === 'focusAddress')?.keys).toEqual(['Ctrl+L', 'Ctrl+K']);
    expect(rows.find((row) => row.action === 'reopenClosedTab')?.keys).toEqual(['Ctrl+Shift+T']);
  });
});

describe('keyboard shortcuts', () => {
  it('gives every shortcut action a Chinese label and a display group', () => {
    const expected = {
      focusAddress: ['打开位置', '导航'],
      newTab: ['新建标签页', '标签页'],
      reopenClosedTab: ['重新打开关闭的标签页', '标签页'],
      closeTab: ['关闭标签页', '标签页'],
      reload: ['刷新', '页面'],
      find: ['查找', '页面'],
      back: ['后退', '导航'],
      forward: ['前进', '导航'],
      zoomIn: ['放大', '页面'],
      zoomOut: ['缩小', '页面'],
      resetZoom: ['实际大小', '页面'],
      selectTab1: ['切换到第 1 个标签页', '标签页'],
      selectTab2: ['切换到第 2 个标签页', '标签页'],
      selectTab3: ['切换到第 3 个标签页', '标签页'],
      selectTab4: ['切换到第 4 个标签页', '标签页'],
      selectTab5: ['切换到第 5 个标签页', '标签页'],
      selectTab6: ['切换到第 6 个标签页', '标签页'],
      selectTab7: ['切换到第 7 个标签页', '标签页'],
      selectTab8: ['切换到第 8 个标签页', '标签页'],
      selectLastTab: ['切换到最后一个标签页', '标签页'],
      toggleBookmark: ['添加或移除书签', '页面'],
      copyUrl: ['复制当前网址', '导航'],
      settings: ['设置', '其他'],
    } satisfies Record<ShortcutAction, [string, string]>;
    expect(
      Object.fromEntries(KEYBINDINGS.map((item) => [item.action, [item.label, item.group]])),
    ).toEqual(expected);
  });

  it('maps the browser shortcuts the shell and the page views both intercept', () => {
    expect(interceptedShortcut(press('t'))).toBe('newTab');
    expect(interceptedShortcut(press('T', { shift: true }))).toBe('reopenClosedTab');
    expect(interceptedShortcut(press('w'))).toBe('closeTab');
    expect(interceptedShortcut(press('l'))).toBe('focusAddress');
    expect(interceptedShortcut(press('k'))).toBe('focusAddress');
    expect(interceptedShortcut(press('c', { shift: true }))).toBe('copyUrl');
    expect(interceptedShortcut(press('+', { shift: true }))).toBe('zoomIn');
    expect(interceptedShortcut(press('='))).toBe('zoomIn');
    expect(interceptedShortcut(press('3'))).toBe('selectTab3');
    expect(interceptedShortcut(press('9'))).toBe('selectLastTab');
    expect(interceptedShortcut(press('r', { meta: false, control: true }))).toBe('reload');
  });

  it('ignores Shift where it does not choose between two bindings', () => {
    expect(interceptedShortcut(press('R', { shift: true }))).toBe('reload');
    expect(interceptedShortcut(press('[', { shift: true }))).toBe('back');
  });

  it('leaves plain keys and menu-only shortcuts to the page and the menu', () => {
    expect(interceptedShortcut(press('t', { meta: false }))).toBeUndefined();
    expect(interceptedShortcut(press(','))).toBeUndefined();
    expect(interceptedShortcut(press('d'))).toBeUndefined();
    expect(interceptedShortcut(press('c'))).toBeUndefined();
  });

  it('gives every binding its own menu accelerator', () => {
    const accelerators = KEYBINDINGS.map((item) => item.accelerator);
    expect(new Set(accelerators).size).toBe(accelerators.length);
    expect(acceleratorFor('settings')).toBe('CmdOrCtrl+,');
    expect(acceleratorFor('reopenClosedTab')).toBe('CmdOrCtrl+Shift+T');
  });
});
