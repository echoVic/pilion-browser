import type { AppAction } from '../shared/keybindings';

/**
 * Agent 操作页面或技能回放时，这些动作对应的按钮是灰的；快捷键和菜单走同一条规则，
 * 免得打断正在跑的那一步。查找也在其中：页面挡在遮罩后面，查找栏打开了也用不上。
 */
export const LOCKED_WHILE_DRIVING: ReadonlySet<AppAction> = new Set<AppAction>([
  'reload',
  'stopLoading',
  'back',
  'forward',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'find',
]);

interface ShellActionContext {
  /** Agent 正在操作当前页面，或技能正在回放。 */
  readonly driving: boolean;
  /** 当前是新标签页（或还没有标签页）：没有可查找的网页。 */
  readonly home: boolean;
}

/**
 * 这个动作此刻该不该被吞掉（按键已消费，但什么也不做）。与工具栏上对应按钮的禁用条件一致。
 */
export function actionBlocked(action: AppAction, context: ShellActionContext): boolean {
  if (context.driving && LOCKED_WHILE_DRIVING.has(action)) return true;
  return action === 'find' && context.home;
}
