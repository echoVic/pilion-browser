import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabOrganization } from '../src/main/browser/tab-organization.js';
import { AgentSpaces, type AgentSpaceEffects } from '../src/main/external/spaces.js';

function makeEffects(
  org: TabOrganization,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): { effects: AgentSpaceEffects; archiveCalls: string[][] } {
  const archiveCalls: string[][] = [];
  const effects: AgentSpaceEffects = {
    clock: () => Date.now(),
    setTimer: (key, delay, cb) => {
      const t = setTimeout(cb, delay);
      timers.set(key, t);
      return t;
    },
    clearTimer: (t) => {
      clearTimeout(t);
    },
    resolveClientName: () => '本机 Agent（CLI）',
    audit: vi.fn(),
    archiveTabs: (tabIds) => archiveCalls.push([...tabIds]),
    revokeAcl: vi.fn(),
    invalidatePrincipal: vi.fn(),
    rejectApprovals: vi.fn(),
    closeConnections: vi.fn(),
    saveAndBroadcast: vi.fn(),
    grantTabAcl: vi.fn(),
    userSpaceCount: () => org.spaces.filter((s) => !('agent' in s && s.agent)).length,
  };
  return { effects, archiveCalls };
}

describe('AgentSpaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('creates a space and returns its id', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const result = await spaces.create('c1', '比价');
    expect(result.spaceId).toMatch(/^agent-/);
    expect(spaces.listSync('c1')).toHaveLength(1);
  });

  it('refuses the 9th active space with SPACE_LIMIT', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    for (let i = 0; i < 8; i++) await spaces.create('c1', `t${i}`);
    await expect(spaces.create('c1', 'overflow')).rejects.toMatchObject({ code: 'SPACE_LIMIT' });
  });

  it('admit returns ok for an active space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    expect(await spaces.admit('c1', spaceId)).toBe('ok');
  });

  it('admit resumes an idle space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    effects.clock = () => 1000;
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.end(spaceId, 'idle');
    effects.grantTabAcl = vi.fn();
    const admission = await spaces.admit('c1', spaceId);
    expect(admission).toBe('resumed');
  });

  it('admit rejects a stopped space with SPACE_ENDED', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.stop(spaceId);
    await expect(spaces.admit('c1', spaceId)).rejects.toMatchObject({ code: 'SPACE_ENDED' });
  });

  it('admit rejects unknown/foreign space with SPACE_NOT_FOUND', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await expect(spaces.admit('c2', spaceId)).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    await expect(spaces.admit('c1', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
  });

  it('ends an untouched space at exactly 60 minutes and revokes its sub-principal', async () => {
    const org = new TabOrganization();
    const { effects } = makeEffects(org, new Map());
    const order: string[] = [];
    effects.invalidatePrincipal = (principal) => order.push(`invalidate:${principal}`);
    effects.rejectApprovals = (principal) => order.push(`reject:${principal}`);
    effects.revokeAcl = (principal) => order.push(`revoke:${principal}`);
    effects.closeConnections = (principal) => order.push(`close:${principal}`);
    effects.saveAndBroadcast = () => order.push('save');
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    org.add('tab-mine', { spaceId, kind: 'today', lastActiveAt: 0 });
    order.length = 0;

    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(spaces.listSync('c1')[0]!.state).toBe('active');
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toMatchObject({
      state: 'ended',
      endedAt: 3_600_000,
      endReason: 'idle',
    });
    const sub = `external:c1:${spaceId}`;
    expect(order).toEqual([
      `invalidate:${sub}`,
      `reject:${sub}`,
      `revoke:${sub}`,
      `close:${sub}`,
      'save',
    ]);
    expect(effects.audit).toHaveBeenCalledWith('external.space.idle', { clientId: 'c1', spaceId });
    expect(org.get('tab-mine').spaceId).toBe(spaceId);
    expect(org.activeSpaceId).toBe('default');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('touch resets the idle timer to 60 minutes after the last accepted request', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await vi.advanceTimersByTimeAsync(1_800_000);
    spaces.touch(spaceId);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(spaces.listSync('c1')[0]!.state).toBe('active');
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(spaces.listSync('c1')[0]!.state).toBe('active');
    await vi.advanceTimersByTimeAsync(1);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toMatchObject({
      state: 'ended',
      endedAt: 5_400_000,
      endReason: 'idle',
    });
    expect(effects.audit).toHaveBeenCalledWith('external.space.idle', { clientId: 'c1', spaceId });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('touching one space does not extend another space of the same client', async () => {
    const org = new TabOrganization();
    const { effects } = makeEffects(org, new Map());
    const spaces = new AgentSpaces(org, effects);
    const { spaceId: a } = await spaces.create('c1', 'a');
    const { spaceId: b } = await spaces.create('c1', 'b');
    await vi.advanceTimersByTimeAsync(1_800_000);
    spaces.touch(a);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(spaces.listSync('c1')).toEqual([
      { spaceId: a, label: 'a', state: 'active' },
      { spaceId: b, label: 'b', state: 'ended', endReason: 'idle' },
    ]);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(spaces.listSync('c1')[0]!.endReason).toBe('idle');
  });

  it('an active hello admission does not refresh idle time without a tool request', async () => {
    const org = new TabOrganization();
    const { effects } = makeEffects(org, new Map());
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(await spaces.admit('c1', spaceId)).toBe('ok');
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(spaces.listSync('c1')[0]!.endReason).toBe('idle');
  });

  it('touch refuses missing, ended and taken over spaces without scheduling a timer', async () => {
    const org = new TabOrganization();
    const { effects } = makeEffects(org, new Map());
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.stop(spaceId);
    for (const id of ['missing', spaceId]) {
      expect(() => spaces.touch(id)).toThrow(expect.objectContaining({ code: 'SPACE_NOT_FOUND' }));
    }
    await spaces.takeOver(spaceId);
    expect(() => spaces.touch(spaceId)).toThrow(
      expect.objectContaining({ code: 'SPACE_NOT_FOUND' }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toBeUndefined();
  });

  it.each(['idle', 'restart'] as const)(
    'starts a fresh idle period after resuming %s',
    async (reason) => {
      const org = new TabOrganization();
      const { effects } = makeEffects(org, new Map());
      const spaces = new AgentSpaces(org, effects);
      const { spaceId } = await spaces.create('c1', 't');
      if (reason === 'idle') {
        await vi.advanceTimersByTimeAsync(3_600_000);
      } else {
        await vi.advanceTimersByTimeAsync(1_800_000);
        spaces.onStartup();
      }
      expect(spaces.listSync('c1')[0]!.endReason).toBe(reason);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await spaces.admit('c1', spaceId)).toBe('resumed');
      effects.audit = vi.fn();
      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(spaces.listSync('c1')[0]!.state).toBe('active');
      await vi.advanceTimersByTimeAsync(1);
      expect(spaces.listSync('c1')[0]!.endReason).toBe('idle');
      expect(effects.audit).toHaveBeenCalledExactlyOnceWith('external.space.idle', {
        clientId: 'c1',
        spaceId,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['close', 'stop', 'stopClient', 'takeOver', 'onStartup'] as const)(
    '%s clears the pending idle timer without a later idle transition',
    async (action) => {
      const org = new TabOrganization();
      const { effects } = makeEffects(org, new Map());
      const spaces = new AgentSpaces(org, effects);
      const { spaceId } = await spaces.create('c1', 't');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_800_000);
      if (action === 'close') await spaces.close('c1', spaceId);
      else if (action === 'stopClient') await spaces.stopClient('c1');
      else if (action === 'onStartup') spaces.onStartup();
      else await spaces[action](spaceId);
      const endedSpace = structuredClone(org.spaces.find((s) => s.id === spaceId));
      expect(vi.getTimerCount()).toBe(0);
      effects.audit = vi.fn();
      await vi.advanceTimersByTimeAsync(7_200_000);
      expect(org.spaces.find((s) => s.id === spaceId)).toEqual(endedSpace);
      expect(effects.audit).not.toHaveBeenCalled();
    },
  );

  it('ignores a stale idle callback after touch or takeover', async () => {
    const org = new TabOrganization();
    const { effects } = makeEffects(org, new Map());
    const callbacks: Array<() => void> = [];
    const schedule = effects.setTimer;
    effects.setTimer = (key, delay, cb) => {
      callbacks.push(cb);
      return schedule(key, delay, cb);
    };
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    expect(callbacks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_800_000);
    spaces.touch(spaceId);
    callbacks[0]!();
    expect(spaces.listSync('c1')[0]!.state).toBe('active');
    await spaces.takeOver(spaceId);
    effects.audit = vi.fn();
    callbacks[1]!();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toBeUndefined();
    expect(effects.audit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close ends a space with reason closed', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.close('c1', spaceId);
    const s = spaces.listSync('c1')[0]!;
    expect(s.state).toBe('ended');
    expect(s.endReason).toBe('closed');
  });

  it('close on foreign space throws SPACE_NOT_FOUND', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    await expect(spaces.close('c2', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
  });

  it('stop ends with reason stopped and runs side effects in order', async () => {
    const org = new TabOrganization();
    const order: string[] = [];
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    effects.invalidatePrincipal = () => order.push('invalidate');
    effects.rejectApprovals = () => order.push('reject');
    effects.revokeAcl = () => order.push('revoke');
    effects.closeConnections = () => order.push('close');
    effects.saveAndBroadcast = () => order.push('save');
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    order.length = 0; // discard save from create; only capture stop's side effects
    await spaces.stop(spaceId);
    expect(order).toEqual(['invalidate', 'reject', 'revoke', 'close', 'save']);
    expect(spaces.listSync('c1')[0]!.endReason).toBe('stopped');
  });

  it('takeOver removes the agent field when user space capacity is available', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.takeOver(spaceId);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toBeUndefined();
  });

  it('rejected takeover at capacity preserves active metadata, idle deadline and all effects', async () => {
    const org = new TabOrganization();
    for (let i = 1; i < 20; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    const { effects, archiveCalls } = makeEffects(org, new Map());
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    org.add('mine', { spaceId, kind: 'today', lastActiveAt: 0 });
    await vi.advanceTimersByTimeAsync(1_800_000);
    const originalSpace = structuredClone(org.spaces.find((s) => s.id === spaceId));
    const originalTab = structuredClone(org.get('mine'));
    effects.setTimer = vi.fn(effects.setTimer);
    effects.clearTimer = vi.fn(effects.clearTimer);
    vi.mocked(effects.audit).mockClear();
    vi.mocked(effects.saveAndBroadcast).mockClear();

    await expect(spaces.takeOver(spaceId)).rejects.toMatchObject({ code: 'SPACE_LIMIT' });
    expect.soft(spaces.listSync('c1')[0]!.state).toBe('active');
    expect.soft(org.spaces.find((s) => s.id === spaceId)).toEqual(originalSpace);
    expect.soft(org.get('mine')).toEqual(originalTab);
    expect.soft(org.activeSpaceId).toBe('default');
    expect.soft(vi.getTimerCount()).toBe(1);
    expect.soft(archiveCalls).toEqual([]);
    for (const effect of [
      effects.setTimer,
      effects.clearTimer,
      effects.invalidatePrincipal,
      effects.rejectApprovals,
      effects.revokeAcl,
      effects.closeConnections,
      effects.audit,
      effects.saveAndBroadcast,
      effects.grantTabAcl,
    ])
      expect.soft(effect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_799_999);
    expect.soft(spaces.listSync('c1')[0]!.state).toBe('active');
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(org.spaces.find((s) => s.id === spaceId)!.agent).toMatchObject({
      state: 'ended',
      endReason: 'idle',
      endedAt: 3_600_000,
    });
    expect.soft(vi.getTimerCount()).toBe(0);
  });

  it('stopClient ends all of a client active spaces', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    await spaces.create('c1', 't1');
    await spaces.create('c1', 't2');
    await spaces.create('c2', 't3');
    await spaces.stopClient('c1');
    const c1 = spaces.listSync('c1');
    expect(c1.every((s) => s.state === 'ended' && s.endReason === 'stopped')).toBe(true);
    expect(spaces.listSync('c2')[0]!.state).toBe('active');
  });

  it('evicts oldest ended space past the limit and archives its tabs', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects, archiveCalls } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      vi.setSystemTime(i * 1000);
      const { spaceId } = await spaces.create('c1', `t${i}`);
      ids.push(spaceId);
      org.add(`tab-${i}`, { spaceId, kind: 'today', lastActiveAt: i * 1000 });
      await spaces.end(spaceId, 'idle');
    }
    // 9 ended > 8 → oldest evicted
    expect(archiveCalls).toEqual([['tab-0']]);
    expect(spaces.listSync('c1').map((s) => s.spaceId)).toEqual(ids.slice(1));
    expect(() => org.get('tab-0')).toThrow('标签页不存在');
    expect(org.get('tab-1').spaceId).toBe(ids[1]);
    expect(effects.audit).toHaveBeenCalledWith('external.space.evicted', {
      clientId: 'c1',
      spaceId: ids[0],
    });
  });

  it('resume re-grants only tabs owned by the sub-principal', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const granted: string[] = [];
    effects.grantTabAcl = (_spaceId, tabId) => granted.push(tabId);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    // simulate tabs owned by this sub-principal and another
    const sub = `external:c1:${spaceId}`;
    const other = 'external:c1:agent-other';
    effects.tabsForSpace = () => [
      { id: 'mine', ownerPrincipal: sub },
      { id: 'theirs', ownerPrincipal: other },
    ];
    await spaces.end(spaceId, 'idle');
    granted.length = 0;
    await spaces.admit('c1', spaceId);
    expect(granted).toEqual(['mine']);
  });

  it('startup marks active spaces as restart', () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    // simulate a pre-existing active space persisted in tabState
    org.addAgentSpace({
      id: 'agent-old',
      name: 'old',
      color: 'neutral',
      agent: { clientId: 'c1', label: 'old', createdAt: 0, state: 'active' },
    });
    spaces.onStartup();
    expect(org.spaces.find((s) => s.id === 'agent-old')!.agent!.state).toBe('ended');
    expect(org.spaces.find((s) => s.id === 'agent-old')!.agent!.endReason).toBe('restart');
  });

  it('cannot resume a closed space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.close('c1', spaceId);
    await expect(spaces.admit('c1', spaceId)).rejects.toMatchObject({ code: 'SPACE_ENDED' });
  });

  it('startup evicts all eight oldest ended spaces after eight active spaces become restart', () => {
    const org = new TabOrganization();
    const { effects, archiveCalls } = makeEffects(org, new Map());
    // Deliberately insert old spaces out of endedAt order so eviction must use timestamps.
    for (const i of [7, 0, 6, 1, 5, 2, 4, 3]) {
      org.addAgentSpace({
        id: `ended-${i}`,
        name: `old-${i}`,
        color: 'neutral',
        agent: {
          clientId: 'c1',
          label: `old-${i}`,
          createdAt: 0,
          state: 'ended',
          endedAt: i + 1,
          endReason: 'idle',
        },
      });
      org.add(`old-tab-${i}`, { spaceId: `ended-${i}`, kind: 'today', lastActiveAt: 0 });
    }
    for (let i = 0; i < 8; i++) {
      org.addAgentSpace({
        id: `active-${i}`,
        name: `new-${i}`,
        color: 'neutral',
        agent: { clientId: 'c2', label: `new-${i}`, createdAt: 10, state: 'active' },
      });
      org.add(`new-tab-${i}`, { spaceId: `active-${i}`, kind: 'today', lastActiveAt: 10 });
    }
    vi.setSystemTime(1000);
    const spaces = new AgentSpaces(org, effects);
    spaces.onStartup();
    expect(org.spaces).toHaveLength(9); // default user Space + 8 ended Agent Spaces
    expect(spaces.listSync('c1')).toEqual([]);
    expect(spaces.listSync('c2')).toHaveLength(8);
    expect(archiveCalls).toEqual([
      ['old-tab-0'],
      ['old-tab-1'],
      ['old-tab-2'],
      ['old-tab-3'],
      ['old-tab-4'],
      ['old-tab-5'],
      ['old-tab-6'],
      ['old-tab-7'],
    ]);
    for (let i = 0; i < 8; i++) {
      expect(() => org.get(`old-tab-${i}`)).toThrow('标签页不存在');
      expect(org.get(`new-tab-${i}`).spaceId).toBe(`active-${i}`);
      expect(org.spaces.find((s) => s.id === `active-${i}`)!.agent).toMatchObject({
        state: 'ended',
        endedAt: 1000,
        endReason: 'restart',
      });
      expect(effects.audit).toHaveBeenCalledWith('external.space.evicted', {
        clientId: 'c1',
        spaceId: `ended-${i}`,
      });
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
