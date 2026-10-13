import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_HIDE_AFTER_MS,
  BackgroundTabWakeManager,
} from '../src/main/browser/background-tabs';

function setup() {
  const wakes: string[] = [];
  const hides: string[] = [];
  const manager = new BackgroundTabWakeManager(
    { wake: (tabId) => wakes.push(tabId), hide: (tabId) => hides.push(tabId) },
    { hideAfterMs: BACKGROUND_HIDE_AFTER_MS },
  );
  return { manager, wakes, hides };
}

describe('BackgroundTabWakeManager 后台标签唤醒与 30 秒隐藏', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('登记为后台标签时不唤醒、不抢焦点', () => {
    const { manager, wakes } = setup();
    manager.register('tab-agent');
    expect(manager.isBackground('tab-agent')).toBe(true);
    expect(manager.isWoken('tab-agent')).toBe(false);
    expect(wakes).toEqual([]);
  });

  it('需要渲染的操作第一次 touch 唤醒标签', () => {
    const { manager, wakes } = setup();
    manager.register('tab-agent');
    manager.touch('tab-agent');
    expect(wakes).toEqual(['tab-agent']);
    expect(manager.isWoken('tab-agent')).toBe(true);
  });

  it('最后一次操作 30 秒后才隐藏，之前静置不摘', () => {
    const { manager, wakes, hides } = setup();
    manager.register('tab-agent');
    manager.touch('tab-agent');
    wakes.length = 0;

    vi.advanceTimersByTime(BACKGROUND_HIDE_AFTER_MS - 1);
    expect(hides).toEqual([]);
    expect(manager.isWoken('tab-agent')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(hides).toEqual(['tab-agent']);
    expect(manager.isWoken('tab-agent')).toBe(false);
  });

  it('连续操作不断续期：只有最后一次调用之后才开始 30 秒倒计时', () => {
    const { manager, wakes, hides } = setup();
    manager.register('tab-agent');
    manager.touch('tab-agent');
    wakes.length = 0;

    // 第 10、第 25 秒各来一次操作
    vi.advanceTimersByTime(10_000);
    manager.touch('tab-agent');
    vi.advanceTimersByTime(15_000);
    manager.touch('tab-agent');

    // 距最后一次操作才 10 秒，还不该隐藏
    vi.advanceTimersByTime(20_000);
    expect(hides).toEqual([]);
    expect(manager.isWoken('tab-agent')).toBe(true);

    // 距最后一次操作满 30 秒
    vi.advanceTimersByTime(10_000);
    expect(hides).toEqual(['tab-agent']);
  });

  it('hideNow 立即隐藏并取消后续定时', () => {
    const { manager, hides } = setup();
    manager.register('tab-agent');
    manager.touch('tab-agent');
    manager.hideNow('tab-agent');
    expect(hides).toEqual(['tab-agent']);
    vi.advanceTimersByTime(BACKGROUND_HIDE_AFTER_MS);
    // 定时器已被取消，不会重复 hide
    expect(hides).toEqual(['tab-agent']);
  });

  it('forget 关闭标签时不再回调 hide', () => {
    const { manager, hides } = setup();
    manager.register('tab-agent');
    manager.touch('tab-agent');
    manager.forget('tab-agent');
    vi.advanceTimersByTime(BACKGROUND_HIDE_AFTER_MS);
    expect(hides).toEqual([]);
    expect(manager.isBackground('tab-agent')).toBe(false);
  });

  it('多个后台标签各自独立计时，互不影响', () => {
    const { manager, wakes, hides } = setup();
    manager.register('tab-a');
    manager.register('tab-b');
    manager.touch('tab-a');
    vi.advanceTimersByTime(10_000);
    manager.touch('tab-b');

    // tab-a 在第 30 秒（从 touch 算起）隐藏，tab-b 还要 20 秒
    vi.advanceTimersByTime(20_000);
    expect(hides).toEqual(['tab-a']);
    expect(manager.isWoken('tab-b')).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(hides).toEqual(['tab-a', 'tab-b']);
    expect(wakes).toEqual(['tab-a', 'tab-b']);
  });

  it('后台标签总数超过上限时拒绝新开', () => {
    const manager = new BackgroundTabWakeManager(
      { wake: () => {}, hide: () => {} },
      {
        maxBackgroundTabs: 2,
      },
    );
    manager.register('a');
    manager.register('b');
    expect(() => manager.register('c')).toThrow(/后台标签最多/);
    // 已登记的重复登记不算占额
    expect(() => manager.register('a')).not.toThrow();
  });

  it('30 秒回落前标签上还挂着审批，则继续唤醒而不是隐藏', () => {
    let approvalPending = true;
    const hides: string[] = [];
    const manager = new BackgroundTabWakeManager(
      { wake: () => {}, hide: (tabId) => hides.push(tabId), keepWoken: () => approvalPending },
      { hideAfterMs: BACKGROUND_HIDE_AFTER_MS },
    );
    manager.register('tab-x');
    manager.touch('tab-x');
    vi.advanceTimersByTime(BACKGROUND_HIDE_AFTER_MS);
    // 审批还挂着：不摘，且计时被续上
    expect(hides).toEqual([]);
    expect(manager.isWoken('tab-x')).toBe(true);
    // 审批决策后，再过 30 秒才真的摘回
    approvalPending = false;
    vi.advanceTimersByTime(BACKGROUND_HIDE_AFTER_MS);
    expect(hides).toEqual(['tab-x']);
  });
});
