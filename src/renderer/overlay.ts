/**
 * 主窗口里盖在网页上的浮层，同一时刻最多一个：命令栏、任务总览、扩展与浏览器数据。
 * 打开一个就替换掉另一个，关掉的只能是自己。
 */
export type Overlay = 'none' | 'command' | 'overview' | 'browser-data';

/** 关掉指定的浮层；此刻打开的若已换成别的，就不动它。 */
export function closeOverlay(current: Overlay, which: Exclude<Overlay, 'none'>): Overlay {
  return current === which ? 'none' : current;
}

/**
 * 原生网页 view 画在渲染层 DOM 之上，任一浮层打开时都得藏起来。commandBarOpen 告诉主进程
 * 此刻有浮层在用：别把后台唤醒的页面挂出来盖住它，也别把焦点抢回网页。
 */
export function overlayViewport(
  overlay: Overlay,
  pageShown: boolean,
): { commandBarOpen: boolean; visible: boolean } {
  const covered = overlay !== 'none';
  return { commandBarOpen: covered, visible: pageShown && !covered };
}
