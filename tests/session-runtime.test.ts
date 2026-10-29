import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONCURRENT_SESSIONS,
  SessionRuntimeRegistry,
} from '../src/main/agents/session-runtime';

const start = new Date('2026-01-01T00:00:00.000Z');
const minute = 60_000;

function setup() {
  const interrupts: { conversationId: string; mode: 'manual' | 'stopped' }[] = [];
  const registry = new SessionRuntimeRegistry(
    { interrupt: (conversationId, mode) => interrupts.push({ conversationId, mode }) },
    { now: () => Date.now(), userPrincipal: 'local-user' },
  );
  return { registry, interrupts };
}

describe('SessionRuntimeRegistry 多会话隔离', () => {
  it('按会话登记独立运行时，并发上限为 4', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.begin('conv-c', 'agent:gemini:c', 'gemini');
    registry.begin('conv-d', 'agent:pi:d', 'pi');
    expect(registry.runningCount()).toBe(MAX_CONCURRENT_SESSIONS);
    expect(() => registry.begin('conv-e', 'agent:grok:e', 'grok')).toThrow(/最多同时/);
    // 已满时重复登记同一会话不占新名额
    expect(() => registry.begin('conv-a', 'agent:claude:a', 'claude')).not.toThrow();
  });

  it('停止 / 接管只作用于本会话，兄弟会话不受影响', () => {
    const { registry, interrupts } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.setAgentTab('conv-a', 'tab-a');

    registry.interrupt('conv-a', 'manual');

    // 只中断了 A
    expect(interrupts).toEqual([{ conversationId: 'conv-a', mode: 'manual' }]);
    expect(registry.get('conv-a')?.status).toBe('manual');
    expect(registry.get('conv-a')?.agentTabId).toBeUndefined();
    // B 仍是 running，标签还在
    expect(registry.get('conv-b')?.status).toBe('running');
    expect(registry.runningCount()).toBe(1);
  });

  it('沉默检测只对仍在 running 的会话触发，已交接的不再打扰', () => {
    const { registry, interrupts } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.interrupt('conv-b', 'manual');
    interrupts.length = 0;

    registry.onSilent('conv-a');
    registry.onSilent('conv-b');

    expect(interrupts).toEqual([{ conversationId: 'conv-a', mode: 'manual' }]);
  });

  it('lease 各会话独立计时：A 持续活动不过期，B 静置到期', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const { registry } = setup();
      registry.begin('conv-a', 'agent:claude:a', 'claude');
      registry.begin('conv-b', 'agent:codex:b', 'codex');
      // 两个回合都跑完、保持 attachment 挂着但进入空闲。
      registry.settleBusy('conv-a', false);
      registry.settleBusy('conv-b', false);

      // 走到接近 60 分钟时 A 仍在活动，把自己续到 119 分钟；B 一直静置在 60 分钟。
      vi.advanceTimersByTime(59 * minute);
      registry.touch('conv-a');
      registry.settleBusy('conv-a', false);
      vi.advanceTimersByTime(59 * minute);

      // t=118 分钟：B(60) 已过期，A(119) 还差一分钟
      const expired = registry.expiredSessions(Date.now());
      expect(expired.map((s) => s.conversationId)).toEqual(['conv-b']);

      // 又过 1 分钟，A 的续期也到期：B 早已过期，A 现在才加入过期名单
      vi.advanceTimersByTime(1 * minute);
      expect(
        registry
          .expiredSessions(Date.now())
          .map((s) => s.conversationId)
          .sort(),
      ).toEqual(['conv-a', 'conv-b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('忙碌中的会话即使跨过旧 deadline 也不进过期名单', () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const { registry } = setup();
      registry.begin('conv-a', 'agent:claude:a', 'claude');
      vi.advanceTimersByTime(90 * minute);
      // busy 仍为 true（prompt 在飞）
      expect(registry.expiredSessions(Date.now())).toHaveLength(0);
      registry.settleBusy('conv-a', false);
      expect(registry.expiredSessions(Date.now())).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('跨会话标签 ACL：一个会话的 Agent 不能操作另一个会话的标签', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    const ownerA = 'agent:claude:a';
    const ownerB = 'agent:codex:b';

    // A 的 Agent 操作自己的标签放行
    expect(registry.canOperateTab(ownerA, ownerA)).toBe(true);
    // A 的 Agent 想动 B 的标签 → 拒
    expect(registry.canOperateTab(ownerA, ownerB)).toBe(false);
    expect(registry.canOperateTab(ownerB, ownerA)).toBe(false);
    // 人工（本地 principal）永远放行
    expect(registry.canOperateTab('local-user', ownerA)).toBe(true);
    expect(registry.canOperateTab('local-user', ownerB)).toBe(true);
  });

  it('按会话记录 agentTabId，侧栏可区分多个 Agent 标签归属', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.setAgentTab('conv-a', 'tab-a');
    registry.setAgentTab('conv-b', 'tab-b');
    expect(registry.agentTab('conv-a')).toBe('tab-a');
    expect(registry.agentTab('conv-b')).toBe('tab-b');
    expect(registry.conversationOfPrincipal('agent:codex:b')?.conversationId).toBe('conv-b');
  });

  it('end 之后会话从注册表摘除，不再占名额也不再可中断', () => {
    const { registry, interrupts } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.end('conv-a');
    registry.interrupt('conv-a', 'stopped');
    expect(registry.runningCount()).toBe(0);
    expect(interrupts).toEqual([]);
  });
});
