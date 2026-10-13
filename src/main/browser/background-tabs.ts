/**
 * Agent 在后台标签里干活时的「临时唤醒」管理器。
 *
 * Agent 新开的标签默认留在后台，不抢用户当前选中的标签。但 click/type/press/select/check/
 * screenshot/snapshot/observe 这类需要真实渲染或要接收输入的操作，必须先把这个后台标签短暂
 * 挂到视图树里（并关掉 backgroundThrottling）才能拿到稳定的坐标、AX 树与像素。最后一次操作
 * 之后静置 30 秒，再把它摘回后台。
 *
 * 本模块只记账与计时，不直接碰 WebContentsView：真正的挂/摘由主进程通过构造时注入的 wake/hide
 * 回调做。计时器与时钟都可注入，方便单测用假定时器精确验证「唤醒→操作→30 秒后隐藏」。
 *
 * 页面引用校验、page epoch、fencing 完全不受影响：唤醒只是让同一个 WebContentsView 重新可见、
 * 可渲染，标签身份、文档 epoch、执行凭证都不变。后台标签绝不调 webContents.focus()——需要输入时
 * 由主进程走 CDP DOM.focus 让目标元素在该 webContents 内获得焦点，不抢整个应用的焦点。
 */

/** 最后一次操作之后，静置多久把后台标签摘回隐藏。 */
export const BACKGROUND_HIDE_AFTER_MS = 30_000;
/** Agent 后台标签总数上限：超出即拒绝新开，避免无上限挂着 WebContentsView 吃内存。 */
export const MAX_BACKGROUND_TABS = 12;

export interface BackgroundTabHooks {
  /** 把后台标签挂进视图树并关闭后台节流，让它能渲染、能接收 CDP 输入。 */
  wake(tabId: string): void;
  /** 把后台标签摘回隐藏（不再渲染），恢复后台节流。 */
  hide(tabId: string): void;
  /**
   * 30 秒回落前最后一道闸：该标签上若还有挂起的审批（等人点「批准」），先别摘它——
   * 摘了视图、审批回来时坐标就对不上了。返回 true 表示还要继续唤醒，本管理器据此再续 30 秒。
   */
  keepWoken?: (tabId: string) => boolean;
}

export interface BackgroundTabOptions {
  now?: () => number;
  hideAfterMs?: number;
  maxBackgroundTabs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface WokenTab {
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class BackgroundTabWakeManager {
  /** 登记过的 Agent 后台标签。 */
  private readonly background = new Set<string>();
  /** 当前被唤醒、正挂在视图树里的标签。 */
  private readonly woken = new Map<string, WokenTab>();
  private readonly now: () => number;
  private readonly hideAfterMs: number;
  private readonly maxBackgroundTabs: number;
  private readonly setTimer: NonNullable<BackgroundTabOptions['setTimer']>;
  private readonly clearTimer: NonNullable<BackgroundTabOptions['clearTimer']>;

  constructor(
    private readonly hooks: BackgroundTabHooks,
    options: BackgroundTabOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.hideAfterMs = options.hideAfterMs ?? BACKGROUND_HIDE_AFTER_MS;
    this.maxBackgroundTabs = options.maxBackgroundTabs ?? MAX_BACKGROUND_TABS;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Agent 新开标签时登记为后台标签；此时不唤醒、不抢焦点。超出总数上限抛错。 */
  register(tabId: string): void {
    if (this.background.has(tabId)) return;
    if (this.background.size >= this.maxBackgroundTabs)
      throw new Error(`后台标签最多 ${this.maxBackgroundTabs} 个，请先结束一些 Agent 任务`);
    this.background.add(tabId);
  }

  isBackground(tabId: string): boolean {
    return this.background.has(tabId);
  }

  isWoken(tabId: string): boolean {
    return this.woken.has(tabId);
  }

  backgroundCount(): number {
    return this.background.size;
  }

  /**
   * 一次需要渲染/输入的工具调用落到某个标签：确保它被唤醒，并把 30 秒隐藏计时往后推。
   * 连续调用会不断续期，只有「最后一次调用之后」才开始倒计时。
   */
  touch(tabId: string): void {
    let tab = this.woken.get(tabId);
    if (!tab) {
      tab = { lastActivity: this.now(), timer: undefined };
      this.woken.set(tabId, tab);
      this.hooks.wake(tabId);
    }
    this.scheduleHide(tabId, tab);
  }

  /** 立刻把某标签摘回隐藏（标签被关、用户显式切走、会话结束等）。 */
  hideNow(tabId: string): void {
    const tab = this.woken.get(tabId);
    if (!tab) return;
    if (tab.timer !== undefined) this.clearTimer(tab.timer);
    this.woken.delete(tabId);
    this.hooks.hide(tabId);
  }

  /** 标签被彻底关闭：从后台与唤醒名单一起摘掉，不再回调 hide。 */
  forget(tabId: string): void {
    const tab = this.woken.get(tabId);
    if (tab?.timer !== undefined) this.clearTimer(tab.timer);
    this.woken.delete(tabId);
    this.background.delete(tabId);
  }

  /** 应用退出 / 关窗：摘掉所有被唤醒的标签并清掉计时器。 */
  dispose(): void {
    for (const [tabId, tab] of this.woken) {
      if (tab.timer !== undefined) this.clearTimer(tab.timer);
      this.hooks.hide(tabId);
    }
    this.woken.clear();
  }

  private scheduleHide(tabId: string, tab: WokenTab): void {
    tab.lastActivity = this.now();
    if (tab.timer !== undefined) this.clearTimer(tab.timer);
    const deadline = tab.lastActivity + this.hideAfterMs;
    const delay = Math.max(0, deadline - this.now());
    tab.timer = this.setTimer(() => {
      // 定时器触发时再确认一次：这段时间里如果又有 touch，timer 已经被换成新的了。
      if (this.woken.get(tabId)?.timer !== tab.timer) return;
      // 回落前最后一道闸：这个标签上还挂着审批就先别摘，再续 30 秒等人决策。
      if (this.hooks.keepWoken?.(tabId)) {
        this.touch(tabId);
        return;
      }
      this.hideNow(tabId);
    }, delay);
  }
}
