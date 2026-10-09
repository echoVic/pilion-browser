import { describe, expect, it } from 'vitest';
import {
  acceleratorFor,
  interceptedShortcut,
  KEYBINDINGS,
  type KeyInput,
} from '../src/shared/keybindings';

const press = (key: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key,
  meta: true,
  control: false,
  shift: false,
  ...modifiers,
});

describe('keyboard shortcuts', () => {
  it('maps the browser shortcuts the shell and the page views both intercept', () => {
    expect(interceptedShortcut(press('t'))).toBe('newTab');
    expect(interceptedShortcut(press('T', { shift: true }))).toBe('reopenClosedTab');
    expect(interceptedShortcut(press('w'))).toBe('closeTab');
    expect(interceptedShortcut(press('l'))).toBe('focusAddress');
    expect(interceptedShortcut(press('k'))).toBe('focusAddress');
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
