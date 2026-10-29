import { describe, expect, it } from 'vitest';
import { TabOrganization } from '../src/main/browser/tab-organization';

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
