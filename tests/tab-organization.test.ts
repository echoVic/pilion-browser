import { describe, expect, it } from 'vitest';
import { TabOrganization } from '../src/main/browser/tab-organization';
import {
  DEFAULT_SPACE,
  USER_SPACE_LIMIT,
  type AgentBrowserSpace,
} from '../src/shared/tab-organization';

describe('tab organization', () => {
  it('keeps persisted page fields and archive IDs out of runtime tab metadata', () => {
    const organization = new TabOrganization();
    const saved = {
      id: 'archive-id',
      title: 'Saved',
      url: 'https://example.com',
      spaceId: 'default',
      kind: 'today' as const,
      lastActiveAt: 10,
    };
    organization.add('runtime-id', saved);
    expect(organization.get('runtime-id')).toEqual({
      spaceId: 'default',
      kind: 'today',
      lastActiveAt: 10,
    });
  });
  it('protects every occupied tab until all concurrent operations on it have finished', () => {
    const organization = new TabOrganization();
    const hour = 3_600_000;
    for (const id of ['a', 'b'])
      organization.add(id, { spaceId: 'default', kind: 'today', lastActiveAt: 0 });
    const finishA = organization.beginUse('a', 25 * hour);
    const finishSecondA = organization.beginUse('a', 25 * hour);
    const finishB = organization.beginUse('b', 25 * hour);
    expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual([]);
    finishA();
    expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual([]);
    finishSecondA();
    expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual(['a']);
    finishB();
    expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual(['a', 'b']);
    expect(organization.get('a').lastActiveAt).toBe(25 * hour);
  });
  it('keeps favorites in every space and restores the last selected tab for each space', () => {
    const organization = new TabOrganization();
    const second = organization.createSpace('研究', 'blue', 'research');
    organization.add('first', { spaceId: 'default', kind: 'today', lastActiveAt: 100 });
    organization.add('favorite', { spaceId: 'default', kind: 'favorite', lastActiveAt: 100 });
    organization.add('second', { spaceId: second.id, kind: 'pinned', lastActiveAt: 100 });
    organization.activate('first', 200);
    expect(organization.selectSpace(second.id)).toBe('second');
    expect(organization.visibleIds()).toEqual(['favorite', 'second']);
    organization.activate('second', 200);
    expect(organization.selectSpace('default')).toBe('first');
    expect(organization.visibleIds()).toEqual(['favorite', 'first']);
  });

  it('moves and reclassifies tabs without changing their identity or selecting a hidden page', () => {
    const organization = new TabOrganization();
    organization.createSpace('研究', 'blue', 'research');
    organization.add('first', { spaceId: 'default', kind: 'today', lastActiveAt: 100 });
    organization.add('next', { spaceId: 'default', kind: 'today', lastActiveAt: 100 });
    organization.activate('first', 200);
    organization.move('first', 'research');
    expect(organization.visibleIds()).toEqual(['next']);
    organization.activate('first', 300);
    expect(organization.activeSpaceId).toBe('research');
    organization.setKind('first', 'favorite');
    organization.selectSpace('default');
    expect(organization.visibleIds()).toEqual(['first', 'next']);
    expect(organization.remove('first')).toBe('next');
  });

  it('archives only overdue ordinary tabs, respecting activity and every protected tab', () => {
    const organization = new TabOrganization();
    const hour = 3_600_000;
    for (const [id, kind] of [
      ['old', 'today'],
      ['pinned', 'pinned'],
      ['favorite', 'favorite'],
      ['agent', 'today'],
      ['recent', 'today'],
    ] as const)
      organization.add(id, { spaceId: 'default', kind, lastActiveAt: hour });
    organization.activate('recent', 24 * hour);
    expect(organization.archiveCandidates(26 * hour, 24, new Set(['agent']))).toEqual(['old']);
    expect(organization.archiveCandidates(26 * hour, 0, new Set())).toEqual([]);
    expect(organization.archiveCandidates(hour, 24, new Set())).toEqual([]);
  });

  it('deleting a space preserves its pages by moving them to a remaining space', () => {
    const organization = new TabOrganization();
    organization.createSpace('研究', 'blue', 'research');
    organization.add('tab', { spaceId: 'research', kind: 'pinned', lastActiveAt: 100 });
    organization.editSpace({ id: 'research', name: '阅读', color: 'teal' });
    expect(organization.spaces[1].name).toBe('阅读');
    organization.selectSpace('research');
    organization.removeSpace('research');
    expect(organization.activeSpaceId).toBe('default');
    expect(organization.get('tab').spaceId).toBe('default');
    expect(organization.visibleIds()).toEqual(['tab']);
    expect(() => organization.removeSpace('default')).toThrow('至少保留一个空间');
    expect(() => organization.move('tab', 'unknown')).toThrow('空间不存在');
  });
});

const agentSpace: AgentBrowserSpace = {
  id: 'agent-1',
  name: '比价',
  color: 'neutral',
  agent: { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' },
};
const endedAgentSpace: AgentBrowserSpace = {
  id: 'agent-ended',
  name: '旧任务',
  color: 'neutral',
  agent: {
    clientId: 'c1',
    label: '旧任务',
    createdAt: 1,
    state: 'ended',
    endedAt: 2,
    endReason: 'idle',
  },
};

describe('user-space cap', () => {
  it('createSpace counts only user Spaces toward the 20-limit', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    // 19 more user spaces should succeed (total 20 user + 1 agent)
    for (let i = 0; i < 19; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    expect(() => org.createSpace('overflow', 'teal', 'uid-overflow')).toThrow(
      '最多创建 20 个用户空间',
    );
  });
});

describe('agent-space guards', () => {
  it('editSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.editSpace({ ...agentSpace, name: 'new' })).toThrow('Agent 空间');
  });

  it('editSpace rejects ended agent space (rename forbidden)', () => {
    const org = new TabOrganization([DEFAULT_SPACE, endedAgentSpace]);
    expect(() => org.editSpace({ ...endedAgentSpace, name: 'new' })).toThrow('Agent 空间');
  });

  it('removeSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.removeSpace(agentSpace.id)).toThrow('停止或接管');
  });

  it('removeAgentSpace on ended space returns tabs for archiving', () => {
    const org = new TabOrganization([DEFAULT_SPACE, endedAgentSpace]);
    org.add('t1', { spaceId: endedAgentSpace.id, kind: 'today', lastActiveAt: 1 });
    const tabIds = org.removeAgentSpace(endedAgentSpace.id);
    expect(tabIds).toEqual(['t1']);
    expect(org.spaces.find((s) => s.id === endedAgentSpace.id)).toBeUndefined();
  });

  it('removeAgentSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.removeAgentSpace(agentSpace.id)).toThrow('停止或接管');
  });

  it('move rejects tab into active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: DEFAULT_SPACE.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.move('t1', agentSpace.id)).toThrow('Agent 空间');
  });

  it('move rejects tab out of active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: agentSpace.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.move('t1', DEFAULT_SPACE.id)).toThrow('Agent 空间');
  });

  it('setKind rejects pinned/favorite for tabs in active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: agentSpace.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.setKind('t1', 'pinned')).toThrow('Agent 空间');
    expect(() => org.setKind('t1', 'favorite')).toThrow('Agent 空间');
  });
});

describe('addAgentSpace', () => {
  it('adds an agent space without counting toward user cap', () => {
    const org = new TabOrganization();
    for (let i = 1; i < USER_SPACE_LIMIT; i++) {
      org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    }
    // at user cap — adding an agent space must still succeed
    expect(() => org.addAgentSpace(agentSpace)).not.toThrow();
    expect(org.spaces.some((s) => s.id === agentSpace.id)).toBe(true);
  });

  it('counts a temporarily taken-over agent space against the user capacity', () => {
    const org = new TabOrganization();
    for (let i = 1; i < USER_SPACE_LIMIT; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    // 19 个用户空间 + 1 个被接管 = 20，再建用户空间必须拒绝。
    org.addAgentSpace({
      id: 'agent-held',
      name: 'held',
      color: 'neutral',
      agent: {
        clientId: 'c1',
        label: 'held',
        createdAt: 0,
        state: 'ended',
        endReason: 'stopped',
        takenOverAt: 1,
      },
    });
    expect(() => org.createSpace('overflow', 'teal', 'uid-overflow')).toThrow(/20/);
  });
});
