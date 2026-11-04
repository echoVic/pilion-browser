import { randomUUID } from 'node:crypto';
import {
  ACTIVE_AGENT_SPACE_LIMIT,
  ENDED_AGENT_SPACE_LIMIT,
  USER_SPACE_LIMIT,
  type AgentBrowserSpace,
  type AgentSpaceEndReason,
  isAgentSpace,
} from '../../shared/tab-organization.js';
import { TabOrganization } from '../browser/tab-organization.js';
import {
  AgentSpaceError,
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
  /** 用户 Space 当前数量（接管时检查 20 上限）。 */
  userSpaceCount(): number;
  /** 列出某 Space 下所有标签及其 ownerPrincipal（恢复时用）。 */
  tabsForSpace?(spaceId: string): Array<{ id: string; ownerPrincipal: string }>;
}

export class AgentSpaces implements ExternalSpaceControl {
  readonly #org: TabOrganization;
  readonly #fx: AgentSpaceEffects;

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
    this.#fx.audit('external.space.created', { clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return { spaceId };
  }

  async admit(clientId: string, spaceId: string): Promise<SpaceAdmission> {
    const space = this.#findOwned(clientId, spaceId);
    if (space.agent.state === 'active') return 'ok';
    // only idle and restart are resumable
    if (space.agent.endReason !== 'idle' && space.agent.endReason !== 'restart') {
      throw new AgentSpaceError('SPACE_ENDED');
    }
    const active = this.#org.spaces.filter((s) => isAgentSpace(s) && s.agent.state === 'active');
    if (active.length >= ACTIVE_AGENT_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    // re-activate
    this.#org.updateAgentSpace(spaceId, { state: 'active', endedAt: undefined, endReason: undefined });
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

  /** 用户从侧栏「接管」。 */
  async takeOver(spaceId: string): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'active') {
      await this.end(spaceId, 'stopped');
    }
    if (this.#fx.userSpaceCount() >= USER_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    // strip the agent field → becomes an ordinary user Space
    const idx = this.#org.spaces.findIndex((s) => s.id === spaceId);
    this.#org.spaces[idx] = { id: space.id, name: space.name, color: space.color };
    this.#fx.audit('external.space.taken_over', { clientId: space.agent.clientId, spaceId });
    this.#fx.saveAndBroadcast();
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
    if (!space || !isAgentSpace(space) || space.agent.state !== 'active') {
      throw new AgentSpaceError('SPACE_NOT_FOUND');
    }
  }

  /** 启动时：所有 active Agent Space → restart（没有在线客户端）。 */
  onStartup(): void {
    for (const space of this.#org.spaces) {
      if (isAgentSpace(space) && space.agent.state === 'active') {
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

  #findOwned(clientId: string, spaceId: string): AgentBrowserSpace {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space) || space.agent.clientId !== clientId) {
      throw new AgentSpaceError('SPACE_NOT_FOUND');
    }
    return space;
  }

  #evictIfNeeded(): void {
    const ended = this.#org.spaces
      .filter((s): s is AgentBrowserSpace => isAgentSpace(s) && s.agent.state === 'ended')
      .sort((a, b) => (a.agent.endedAt ?? 0) - (b.agent.endedAt ?? 0));
    if (ended.length <= ENDED_AGENT_SPACE_LIMIT) return;
    const evict = ended[0]!;
    const tabIds = this.#org.removeAgentSpace(evict.id);
    this.#fx.archiveTabs(tabIds);
    this.#fx.audit('external.space.evicted', {
      clientId: evict.agent.clientId,
      spaceId: evict.id,
    });
  }
}
