import { describe, expect, it } from 'vitest';
import { TabRegistry } from '../src/main/browser/tab-registry';
import type { BrowserPagePort } from '../src/main/browser/types';

const page = {} as BrowserPagePort;

describe('TabRegistry.removePrincipalFromAcls 多会话按 principal 撤权', () => {
  it('只移除指定 Agent principal 的 entry，保留用户与其它会话的权限', () => {
    const registry = new TabRegistry();
    registry.add('tab-1', page, 'local-user');
    // 会话 A 的 Agent 与会话 B 的 Agent 都在这一页上有 operator 权限
    registry.setAcl('local-user', 'tab-1', {
      entries: [
        { principalId: 'local-user', role: 'owner' },
        { principalId: 'agent:claude:aaaa1111', role: 'operator' },
        { principalId: 'agent:codex:bbbb2222', role: 'operator' },
      ],
    });

    registry.removePrincipalFromAcls('agent:claude:aaaa1111');

    const tab = registry.get('tab-1');
    expect(tab.acl.entries.map((entry) => entry.principalId)).toEqual([
      'local-user',
      'agent:codex:bbbb2222',
    ]);
    // A 的 Agent 不能再观察这一页，B 的 Agent 仍可以
    expect(() => registry.require('tab-1', 'agent:claude:aaaa1111', 'observe')).toThrow();
    expect(() => registry.require('tab-1', 'agent:codex:bbbb2222', 'observe')).not.toThrow();
  });

  it('撤权时 fencing 递增，进行中的旧操作随之失效', () => {
    const registry = new TabRegistry();
    registry.add('tab-1', page, 'local-user');
    registry.setAcl('local-user', 'tab-1', {
      entries: [
        { principalId: 'local-user', role: 'owner' },
        { principalId: 'agent:claude:aaaa1111', role: 'operator' },
      ],
    });
    const before = registry.get('tab-1').fencing;
    registry.removePrincipalFromAcls('agent:claude:aaaa1111');
    expect(registry.get('tab-1').fencing).toBeGreaterThan(before);
  });

  it('被撤的是 owner 且会导致没有 owner 时跳过该标签，不破坏 ACL 约束', () => {
    const registry = new TabRegistry();
    registry.add('tab-1', page, 'local-user');
    registry.removePrincipalFromAcls('local-user');
    expect(registry.get('tab-1').acl.entries.map((entry) => entry.principalId)).toEqual([
      'local-user',
    ]);
  });
});
