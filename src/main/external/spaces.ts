import { randomUUID } from 'node:crypto';
import {
  ACTIVE_AGENT_SPACE_LIMIT,
  AGENT_SPACE_IDLE_MS,
  ENDED_AGENT_SPACE_LIMIT,
  USER_SPACE_LIMIT,
  type AgentBrowserSpace,
  type AgentSpaceEndReason,
  isAgentSpace,
} from '../../shared/tab-organization.js';
import { TabOrganization } from '../browser/tab-organization.js';
import {
  AgentSpaceError,
  externalSpacePrincipal,
  type AgentSpaceSummary,
  type ExternalSpaceControl,
  type SpaceAdmission,
} from './space-protocol.js';

export type AgentSpaceTimer = ReturnType<typeof setTimeout>;

/** Agent Space 的副作用端口：main.ts 实现注入，spaces.ts 只定义接口。 */
export interface AgentSpaceEffects {
  clock(): number;
  setTimer(key: string, delay: number, cb: () => void): AgentSpaceTimer;
  clearTimer(timer: AgentSpaceTimer): void;
  /** 解析 clientId 到展示名（已吊销返回「已吊销的客户端」）。 */
  resolveClientName(clientId: string): string;
  audit(eventType: string, payload: Record<string, unknown>): void;
  /** 归档一组标签（淘汰时调用）。 */
  archiveTabs(tabIds: string[]): void;
  /** 结束时：撤销子 principal 的标签 ACL。 */
  revokeAcl(principal: string): void;
  /** 结束时：中止子 principal 的在途操作。 */
  invalidatePrincipal(principal: string): void;
  /** 结束时：拒绝等待该子 principal 的审批。 */
  rejectApprovals(principal: string): void;
  /** 结束时：关闭该子 principal 的所有在线连接。 */
  closeConnections(principal: string): void;
  /** 结束/创建后：保存工作区并广播 state。 */
  saveAndBroadcast(): void;
  /** 恢复时：给指定标签授 ACL（只限 ownerPrincipal 匹配的）。 */
  grantTabAcl(spaceId: string, tabId: string): void;
  /** 人手里的空间当前数量（普通用户空间 + 临时接管，接管时检查 20 上限）。 */
  userSpaceCount(): number;
  /** 客户端是否已吊销/删除：吊销后交还也没有意义，直接拒绝。 */
  clientRevoked(clientId: string): boolean;
  /** 列出某 Space 下所有标签及其 ownerPrincipal（恢复时用）。 */
  tabsForSpace?(spaceId: string): Array<{ id: string; ownerPrincipal: string }>;
}

export class AgentSpaces implements ExternalSpaceControl {
  readonly #org: TabOrganization;
  readonly #fx: AgentSpaceEffects;
  readonly #idleTimers = new Map<string, AgentSpaceTimer>();

  constructor(org: TabOrganization, effects: AgentSpaceEffects) {
    this.#org = org;
    this.#fx = effects;
  }

  /** 同步快照：list 控制帧与 UI 用。 */
  listSync(clientId: string): AgentSpaceSummary[] {
    return this.#org.spaces
      .filter(isAgentSpace)
      .filter((s) => s.agent.clientId === clientId)
      .map((s) => ({
        spaceId: s.id,
        label: s.agent.label,
        state: s.agent.state,
        custody: s.agent.takenOverAt === undefined ? ('agent' as const) : ('user' as const),
        handBackable: s.agent.takenOverAt !== undefined,
        ...(s.agent.endReason ? { endReason: s.agent.endReason } : {}),
      }));
  }

  async create(clientId: string, label: string): Promise<{ spaceId: string }> {
    const active = this.#org.spaces.filter((s) => isAgentSpace(s) && s.agent.state === 'active');
    if (active.length >= ACTIVE_AGENT_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    const spaceId = `agent-${randomUUID()}`;
    const space: AgentBrowserSpace = {
      id: spaceId,
      name: label,
      color: 'neutral',
      agent: { clientId, label, createdAt: this.#fx.clock(), state: 'active' },
    };
    this.#org.addAgentSpace(space);
    this.touch(spaceId);
    this.#fx.audit('external.space.created', { clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return { spaceId };
  }

  async admit(clientId: string, spaceId: string): Promise<SpaceAdmission> {
    const space = this.#findOwned(clientId, spaceId);
    if (space.agent.takenOverAt !== undefined) throw new AgentSpaceError('SPACE_TAKEN_OVER');
    if (space.agent.state === 'active') return 'ok';
    // idle / restart / handed_back 都可以恢复；closed 与 stopped 不行。
    if (
      space.agent.endReason !== 'idle' &&
      space.agent.endReason !== 'restart' &&
      space.agent.endReason !== 'handed_back'
    ) {
      throw new AgentSpaceError('SPACE_ENDED');
    }
    const active = this.#org.spaces.filter((s) => isAgentSpace(s) && s.agent.state === 'active');
    if (active.length >= ACTIVE_AGENT_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    // re-activate
    this.#org.updateAgentSpace(spaceId, {
      state: 'active',
      endedAt: undefined,
      endReason: undefined,
    });
    this.touch(spaceId);
    // re-grant ACL only for tabs whose ownerPrincipal matches this sub-principal
    const sub = `external:${clientId}:${spaceId}`;
    const tabs = this.#fx.tabsForSpace?.(spaceId) ?? [];
    for (const tab of tabs) {
      if (tab.ownerPrincipal === sub) this.#fx.grantTabAcl(spaceId, tab.id);
    }
    this.#fx.audit('external.space.resumed', { clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return 'resumed';
  }

  async list(clientId: string): Promise<AgentSpaceSummary[]> {
    return this.listSync(clientId);
  }

  async close(clientId: string, spaceId: string): Promise<void> {
    const space = this.#findOwned(clientId, spaceId);
    if (space.agent.state === 'ended') return;
    await this.end(spaceId, 'closed');
  }

  /** 用户从侧栏「停止」。 */
  async stop(spaceId: string): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'ended') return;
    await this.end(spaceId, 'stopped');
  }

  /**
   * 用户从侧栏「接管」。
   * - temporary（默认）：只把 custody 转给人，保留 agent 字段与标签来源，之后可以 handBack；
   * - permanent：删掉 agent 字段，空间变成普通用户空间（不可逆，旧版行为）。
   */
  async takeOver(spaceId: string, mode: 'temporary' | 'permanent' = 'temporary'): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (this.#fx.userSpaceCount() >= USER_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    if (mode === 'temporary') {
      // Agent 自己声明结束（closed）的空间不复活：交还等于让它在陈旧上下文上继续动作。
      if (space.agent.state === 'ended' && space.agent.endReason === 'closed')
        throw new AgentSpaceError('SPACE_NOT_HAND_BACKABLE');
      if (space.agent.state === 'active') await this.end(spaceId, 'stopped');
      this.#org.updateAgentSpace(spaceId, { takenOverAt: this.#fx.clock() });
      this.#fx.audit('external.space.taken_over', {
        clientId: space.agent.clientId,
        spaceId,
        mode: 'temporary',
      });
      this.#fx.saveAndBroadcast();
      return;
    }
    if (space.agent.state === 'active') {
      await this.end(spaceId, 'stopped');
    }
    // strip the agent field → becomes an ordinary user Space
    const idx = this.#org.spaces.findIndex((s) => s.id === spaceId);
    this.#org.spaces[idx] = { id: space.id, name: space.name, color: space.color };
    this.#fx.audit('external.space.taken_over', {
      clientId: space.agent.clientId,
      spaceId,
      mode: 'permanent',
    });
    this.#fx.saveAndBroadcast();
  }

  /**
   * 用户从侧栏「交还」：把临时接管的空间还给原客户端。
   * 只重授 ownerPrincipal 等于本空间子 principal 的标签；用户接管期间新开的标签一律不给。
   */
  async handBack(spaceId: string): Promise<{ grantedTabIds: string[]; alreadyHandedBack?: true }> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.takenOverAt === undefined) {
      if (space.agent.endReason === 'handed_back')
        return { grantedTabIds: [], alreadyHandedBack: true };
      throw new AgentSpaceError('SPACE_NOT_HAND_BACKABLE');
    }
    if (this.#fx.clientRevoked(space.agent.clientId))
      throw new AgentSpaceError('SPACE_CLIENT_REVOKED');
    const clientId = space.agent.clientId;
    const sub = externalSpacePrincipal(clientId, spaceId);
    this.#org.updateAgentSpace(spaceId, {
      state: 'ended',
      endedAt: this.#fx.clock(),
      endReason: 'handed_back',
      takenOverAt: undefined,
    });
    const grantedTabIds: string[] = [];
    const skippedTabIds: string[] = [];
    for (const tab of this.#fx.tabsForSpace?.(spaceId) ?? []) {
      if (tab.ownerPrincipal === sub) {
        this.#fx.grantTabAcl(spaceId, tab.id);
        grantedTabIds.push(tab.id);
      } else skippedTabIds.push(tab.id);
    }
    this.#fx.audit('external.space.handed_back', {
      clientId,
      spaceId,
      grantedTabIds,
      skippedTabIds,
    });
    this.#fx.saveAndBroadcast();
    return { grantedTabIds };
  }

  /** 吊销/删除客户端时停止它所有 active 的 Space。 */
  async stopClient(clientId: string): Promise<void> {
    const owned = this.#org.spaces.filter(
      (s) => isAgentSpace(s) && s.agent.clientId === clientId && s.agent.state === 'active',
    );
    for (const s of owned) await this.end(s.id, 'stopped');
  }

  /** 每次工具请求调用，刷新空闲计时。 */
  touch(spaceId: string): void {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.takenOverAt !== undefined) throw new AgentSpaceError('SPACE_TAKEN_OVER');
    if (space.agent.state !== 'active') throw new AgentSpaceError('SPACE_ENDED');
    this.#clearIdleTimer(spaceId);
    const timer = this.#fx.setTimer(spaceId, AGENT_SPACE_IDLE_MS, () => {
      // A cleared callback may already be queued; only the current timer may end the Space.
      if (this.#idleTimers.get(spaceId) !== timer) return;
      void this.end(spaceId, 'idle');
    });
    this.#idleTimers.set(spaceId, timer);
  }

  /** 启动时：所有 active Agent Space → restart（没有在线客户端）。 */
  onStartup(): void {
    for (const space of this.#org.spaces) {
      if (isAgentSpace(space) && space.agent.state === 'active') {
        this.#clearIdleTimer(space.id);
        this.#org.updateAgentSpace(space.id, {
          state: 'ended',
          endedAt: this.#fx.clock(),
          endReason: 'restart',
        });
      }
    }
    this.#evictIfNeeded();
  }

  /** 删除已结束的 Agent Space（用户「删除」按钮），标签进归档。 */
  removeEnded(spaceId: string): string[] {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'active') throw new AgentSpaceError('SPACE_ENDED');
    const tabIds = this.#org.removeAgentSpace(spaceId);
    this.#fx.archiveTabs(tabIds);
    this.#fx.audit('external.space.removed', { clientId: space.agent.clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return tabIds;
  }

  /**
   * 公开的结束方法（测试直接调用；main.ts 也可以用）。
   * 执行副作用顺序：invalidate → reject → revoke → close → updateAgentSpace → audit → evict → save
   */
  async end(spaceId: string, reason: AgentSpaceEndReason): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    this.#clearIdleTimer(spaceId);
    const clientId = space.agent.clientId;
    const sub = `external:${clientId}:${spaceId}`;
    this.#fx.invalidatePrincipal(sub);
    this.#fx.rejectApprovals(sub);
    this.#fx.revokeAcl(sub);
    this.#fx.closeConnections(sub);
    this.#org.updateAgentSpace(spaceId, {
      state: 'ended',
      endedAt: this.#fx.clock(),
      endReason: reason,
    });
    const eventSuffix = reason === 'closed' ? 'closed' : reason === 'stopped' ? 'stopped' : 'idle';
    this.#fx.audit(`external.space.${eventSuffix}`, { clientId, spaceId });
    this.#evictIfNeeded();
    this.#fx.saveAndBroadcast();
  }

  #clearIdleTimer(spaceId: string): void {
    const timer = this.#idleTimers.get(spaceId);
    if (timer === undefined) return;
    this.#idleTimers.delete(spaceId);
    this.#fx.clearTimer(timer);
  }

  #findOwned(clientId: string, spaceId: string): AgentBrowserSpace {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space) || space.agent.clientId !== clientId) {
      throw new AgentSpaceError('SPACE_NOT_FOUND');
    }
    return space;
  }

  #evictIfNeeded(): void {
    const ended = this.#org.spaces
      .filter(
        (s): s is AgentBrowserSpace =>
          isAgentSpace(s) && s.agent.state === 'ended' && s.agent.takenOverAt === undefined,
      )
      .sort((a, b) => (a.agent.endedAt ?? 0) - (b.agent.endedAt ?? 0));
    for (const evict of ended.slice(0, Math.max(0, ended.length - ENDED_AGENT_SPACE_LIMIT))) {
      const tabIds = this.#org.removeAgentSpace(evict.id);
      this.#fx.archiveTabs(tabIds);
      this.#fx.audit('external.space.evicted', {
        clientId: evict.agent.clientId,
        spaceId: evict.id,
      });
    }
  }
}
