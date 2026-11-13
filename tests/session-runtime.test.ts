import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_SESSIONS,
  SessionRuntimeRegistry,
} from '../src/main/agents/session-runtime';

function setup() {
  return { registry: new SessionRuntimeRegistry() };
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

  it('结束一个会话只摘除它自己，兄弟会话的状态与标签不动', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.setAgentTab('conv-a', 'tab-a');
    registry.setAgentTab('conv-b', 'tab-b');

    registry.end('conv-a');

    expect(registry.agentTab('conv-a')).toBeUndefined();
    expect(registry.list()).toEqual([
      {
        conversationId: 'conv-b',
        principal: 'agent:codex:b',
        agentId: 'codex',
        status: 'running',
        agentTabId: 'tab-b',
      },
    ]);
    expect(registry.runningCount()).toBe(1);
  });

  it('按会话记录 agentTabId，侧栏可区分多个 Agent 标签归属', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.begin('conv-b', 'agent:codex:b', 'codex');
    registry.setAgentTab('conv-a', 'tab-a');
    registry.setAgentTab('conv-b', 'tab-b');
    expect(registry.agentTab('conv-a')).toBe('tab-a');
    expect(registry.agentTab('conv-b')).toBe('tab-b');
  });

  it('end 之后会话从注册表摘除，不再占名额，之后可以重新登记', () => {
    const { registry } = setup();
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    registry.end('conv-a');
    registry.end('conv-a');
    expect(registry.runningCount()).toBe(0);
    expect(registry.begin('conv-a', 'agent:claude:a2', 'claude').principal).toBe('agent:claude:a2');
    expect(registry.runningCount()).toBe(1);
  });

  it('并发上限可以在构造时指定', () => {
    const registry = new SessionRuntimeRegistry({ maxConcurrent: 1 });
    registry.begin('conv-a', 'agent:claude:a', 'claude');
    expect(() => registry.begin('conv-b', 'agent:codex:b', 'codex')).toThrow(/最多同时 1 个/);
  });
});
