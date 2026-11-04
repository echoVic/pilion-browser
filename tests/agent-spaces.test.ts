import { describe, expect, it, vi } from 'vitest';
import { TabOrganization } from '../src/main/browser/tab-organization.js';
import { AgentSpaces, type AgentSpaceEffects } from '../src/main/external/spaces.js';

function makeEffects(
  org: TabOrganization,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): { effects: AgentSpaceEffects; archiveCalls: string[][] } {
  const archiveCalls: string[][] = [];
  const effects: AgentSpaceEffects = {
    clock: () => 0,
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
    await spaces.create('c1', 't');
    await expect(spaces.admit('c2', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    await expect(spaces.admit('c1', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
  });

  it('touch resets the idle timer', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    expect(() => spaces.touch(spaceId)).not.toThrow();
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

  it('takeOver removes the agent field and refuses at 20 user spaces', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.takeOver(spaceId);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toBeUndefined();
    // now at 1 user space (default); fill to 20 and try again
    for (let i = 1; i < 19; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    const { spaceId: s2 } = await spaces.create('c1', 't2');
    await expect(spaces.takeOver(s2)).rejects.toMatchObject({ code: 'SPACE_LIMIT' });
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
    for (let i = 0; i < 9; i++) {
      const { spaceId } = await spaces.create('c1', `t${i}`);
      await spaces.end(spaceId, 'idle');
      effects.clock = () => i * 1000;
    }
    // 9 ended > 8 → oldest evicted
    expect(archiveCalls.length).toBeGreaterThanOrEqual(1);
    expect(effects.audit).toHaveBeenCalledWith('external.space.evicted', expect.any(Object));
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
});
