import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';
import {
  hideBackgroundView,
  wakeBackgroundView,
  type BackgroundViewHandle,
  type BackgroundViewTree,
} from '../src/main/browser/background-views.js';

/** 一个带 focus() 的 mock view：用来自证唤醒/回落路径绝不调用 webContents.focus()。 */
function mockView(): BackgroundViewHandle & { focus: ReturnType<typeof vi.fn> } {
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    getVisible: vi.fn(() => true),
    setBackgroundThrottling: vi.fn(),
    setFocusEmulation: vi.fn(),
    focus: vi.fn(),
  };
}

class MockTree implements BackgroundViewTree {
  readonly children: BackgroundViewHandle[] = [];
  addChildView(view: BackgroundViewHandle): void {
    const index = this.children.indexOf(view);
    if (index >= 0) this.children.splice(index, 1);
    this.children.push(view);
  }
  removeChildView(view: BackgroundViewHandle): void {
    const index = this.children.indexOf(view);
    if (index >= 0) this.children.splice(index, 1);
  }
}

const bounds: Rectangle = { x: 0, y: 0, width: 1280, height: 720 };

describe('background view wake/hide', () => {
  let tree: MockTree;
  beforeEach(() => {
    tree = new MockTree();
  });

  it('wakes a background tab at viewport bounds without throttling and with focus emulation on', () => {
    const view = mockView();
    wakeBackgroundView({ handle: view, treeView: view, tree, bounds });
    expect(view.setBounds).toHaveBeenCalledWith(bounds);
    expect(view.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(view.setFocusEmulation).toHaveBeenCalledWith(true);
    expect(view.setVisible).toHaveBeenCalledWith(true);
  });

  it('never steals focus: webContents.focus() is not called on wake or hide', () => {
    const view = mockView();
    const active = mockView();
    wakeBackgroundView({ handle: view, treeView: view, activeTreeView: active, tree, bounds });
    hideBackgroundView({ view });
    expect(view.focus).not.toHaveBeenCalled();
    expect(active.focus).not.toHaveBeenCalled();
  });

  it('renders the woken view BELOW the user active tab (z-order)', () => {
    const bg = mockView();
    const active = mockView();
    // 模拟既有顺序：bg 与 active 已在树中，bg 因后建位于上层。
    tree.addChildView(active);
    tree.addChildView(bg);
    wakeBackgroundView({ handle: bg, treeView: bg, activeTreeView: active, tree, bounds });
    // 唤醒后 active 必须在 bg 之上。
    expect(tree.children.indexOf(active)).toBeGreaterThan(tree.children.indexOf(bg));
  });

  it('does not re-add active on top of itself when it is the very tab being woken', () => {
    const view = mockView();
    tree.addChildView(view);
    wakeBackgroundView({ handle: view, treeView: view, activeTreeView: view, tree, bounds });
    expect(tree.children).toEqual([view]);
  });

  it('falls back: hidden, throttling restored, focus emulation off', () => {
    const view = mockView();
    hideBackgroundView({ view });
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(view.setBackgroundThrottling).toHaveBeenCalledWith(true);
    expect(view.setFocusEmulation).toHaveBeenCalledWith(false);
  });
});
