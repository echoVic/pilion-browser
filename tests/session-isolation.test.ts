import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_SESSIONS,
  SessionRuntimeRegistry,
} from '../src/main/agents/session-runtime';

describe('会话隔离：投影不过期与互斥拦截', () => {
  it('后台会话运行时切换会话，各会话状态独立不过期', () => {
    const interrupts: { conversationId: string; mode: 'manual' | 'stopped' }[] = [];
    const registry = new SessionRuntimeRegistry(
      { interrupt: (conversationId, mode) => interrupts.push({ conversationId, mode }) },
      { now: () => Date.now(), userPrincipal: 'local-user' },
    );
    // A 在后台运行，B 是用户当前活跃会话
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.setAgentTab('conv-a', 'tab-a');

    // 用户切到 B：A 的运行状态不受影响
    expect(registry.get('conv-a')?.status).toBe('running');
    expect(registry.get('conv-b')?.status).toBe('running');
    expect(registry.agentTab('conv-a')).toBe('tab-a');

    // 停止 A 不影响 B
    registry.interrupt('conv-a', 'stopped');
    expect(interrupts).toEqual([{ conversationId: 'conv-a', mode: 'stopped' }]);
    expect(registry.get('conv-a')?.status).toBe('stopped');
    expect(registry.get('conv-b')?.status).toBe('running');
    expect(registry.agentTab('conv-b')).toBeUndefined();
  });

  it('后台会话执行工具时，录制和回放按标签拦截', () => {
    const registry = new SessionRuntimeRegistry(
      { interrupt: () => {} },
      { now: () => Date.now(), userPrincipal: 'local-user' },
    );
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');

    // A 的 Agent 操作自己的标签放行
    expect(registry.canOperateTab('agent:claude:a', 'agent:claude:a')).toBe(true);
    // A 的 Agent 想动 B 的标签 → 拒（跨会话 ACL）
    expect(registry.canOperateTab('agent:claude:a', 'agent:codex:b')).toBe(false);
    expect(registry.canOperateTab('agent:codex:b', 'agent:claude:a')).toBe(false);
    // 人工永远放行
    expect(registry.canOperateTab('local-user', 'agent:claude:a')).toBe(true);
  });

  it('并发上限 4，超限明确报错', () => {
    const registry = new SessionRuntimeRegistry(
      { interrupt: () => {} },
      { now: () => Date.now(), userPrincipal: 'local-user' },
    );
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.begin('conv-c', 'agent:gemini:c', 'gemini');
    registry.begin('conv-d', 'agent:pi:d', 'pi');
    expect(registry.runningCount()).toBe(MAX_CONCURRENT_SESSIONS);
    expect(() => registry.begin('conv-e', 'agent:grok:e', 'grok')).toThrow(/最多同时/);
  });
});
