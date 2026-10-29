import type { Rectangle } from 'electron';

/**
 * 后台标签「挂到用户选中标签后面渲染」的视图树操作。
 *
 * 纯函数 + 窄接口：主进程注入真实的 WebContentsView / contentView，单测注入 mock，
 * 从而在不启动 Electron 的情况下验证 z 序、回落、焦点不被抢、focus emulation 开关。
 *
 * 硬约束：唤醒/回落路径绝不调用 `webContents.focus()` 或 `BrowserWindow.focus()`。
 * 后台页要接收输入时，只走固定的 CDP `Emulation.setFocusEmulationEnabled`，让页面自认为
 * 有键盘焦点（contenteditable / CodeMirror / Monaco 这类自绘编辑器依赖 focus 事件），
 * 不把整个应用或窗口拉到前台。
 */

/** 一个网页 WebContentsView 暴露给唤醒/回落逻辑的最小表面。 */
export interface BackgroundViewHandle {
  setBounds(bounds: Rectangle): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  /** 关掉后台节流：否则被唤醒的页会被 Chromium 冻住，截图/坐标退化成占位。 */
  setBackgroundThrottling(throttled: boolean): void;
  /** 固定 CDP 开关：让页面自认为有焦点。实现方不得用它执行任意 JS。 */
  setFocusEmulation(enabled: boolean): void;
}

/** 窗口 contentView 的最小表面。 */
export interface BackgroundViewTree {
  /** 把 view 放到视图树；若它已在树中，重复 add 会把它抬到最上层。 */
  addChildView(view: BackgroundViewHandle): void;
  removeChildView(view: BackgroundViewHandle): void;
}

export interface WakeBackgroundViewOptions {
  /** 对后台 view 做 setBounds / setVisible / 节流 / focus emulation 的窄句柄。 */
  handle: BackgroundViewHandle;
  /**
   * 真正要 addChildView 进视图树的原生节点。必须是 WebContentsView 本身——
   * 不能把上面的句柄对象传给 addChildView，否则 Electron 会抛
   * 「Error processing argument at index 0, conversion failure」。
   */
  treeView: unknown;
  tree: BackgroundViewTree;
  /** 与网页视口一致的边界。 */
  bounds: Rectangle;
  /**
   * 用户当前选中的标签原生节点。唤醒后把它重新 addChildView 抬到被唤醒的后台 view 之上，
   * 于是后台页真实渲染、却被用户正在看的这一页盖住。没有活动标签时传 undefined。
   */
  activeTreeView?: unknown;
}

/**
 * 唤醒一个后台标签：按视口尺寸摆好、置为可见（真正渲染）、关掉后台节流、打开 focus emulation，
 * 最后把用户的活动标签抬到它上面。蒙层由调用方在更高层自行抬到最顶。
 */
export function wakeBackgroundView(options: WakeBackgroundViewOptions): void {
  const { handle, treeView, tree, bounds, activeTreeView } = options;
  handle.setBounds(bounds);
  handle.setBackgroundThrottling(false);
  handle.setFocusEmulation(true);
  handle.setVisible(true);
  // 确保它在视图树里（若已在树中，add 会把它挪到末尾）；再把用户活动标签抬到它之上。
  tree.addChildView(treeView as BackgroundViewHandle);
  if (activeTreeView && activeTreeView !== treeView)
    tree.addChildView(activeTreeView as BackgroundViewHandle);
}

export interface HideBackgroundViewOptions {
  view: BackgroundViewHandle;
}

/**
 * 回落：置为不可见、恢复后台节流、关掉 focus emulation。view 仍留在视图树里（不可见），
 * 标签身份、文档 epoch 与执行凭证都不变。
 */
export function hideBackgroundView(options: HideBackgroundViewOptions): void {
  const { view } = options;
  view.setVisible(false);
  view.setBackgroundThrottling(true);
  view.setFocusEmulation(false);
}
