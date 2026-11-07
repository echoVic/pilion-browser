import {
  DEFAULT_SPACE,
  isAgentSpace,
  USER_SPACE_LIMIT,
  userCustodyCount,
  type AgentBrowserSpace,
  type BrowserSpace,
  type SpaceColor,
  type TabKind,
  type TabMetadata,
} from '../../shared/tab-organization.js';

/** 标签组织不负责页面、权限或 I/O；主进程按运行时 ID 装配它。 */
export class TabOrganization {
  readonly spaces: BrowserSpace[];
  activeSpaceId: string;
  private readonly tabs = new Map<string, TabMetadata>();
  private readonly selected = new Map<string, string>();
  private readonly occupied = new Map<string, number>();

  constructor(spaces: BrowserSpace[] = [{ ...DEFAULT_SPACE }], activeSpaceId = 'default') {
    this.spaces = spaces.map((space) => ({ ...space }));
    if (
      !this.spaces.length ||
      new Set(this.spaces.map((space) => space.id)).size !== this.spaces.length
    )
      throw new Error('空间列表不合法');
    this.activeSpaceId = this.spaces.some((space) => space.id === activeSpaceId)
      ? activeSpaceId
      : this.spaces[0].id;
  }

  createSpace(name: string, color: SpaceColor, id: string): BrowserSpace {
    // 临时接管的 Agent 空间也占用户容量，否则两条路径各算一套会把 spaces 数组撑破 schema。
    if (userCustodyCount(this.spaces) >= USER_SPACE_LIMIT)
      throw new Error('最多创建 20 个用户空间');
    if (this.spaces.some((space) => space.id === id)) throw new Error('空间已存在');
    const space: BrowserSpace = { name, color, id };
    this.spaces.push(space);
    return space;
  }

  /** 由 spaces.ts 调用：在 spaces 数组里登记一个新的 Agent Space，不受用户 Space 上限约束。 */
  addAgentSpace(space: AgentBrowserSpace): void {
    if (this.spaces.some((s) => s.id === space.id)) throw new Error('空间已存在');
    this.spaces.push(space);
  }

  /** 更新 Agent Space 的 agent 元数据（state/endedAt/endReason）。 */
  updateAgentSpace(id: string, patch: Partial<AgentBrowserSpace['agent']>): void {
    const space = this.requireSpace(id);
    if (!isAgentSpace(space)) throw new Error('不是 Agent 空间');
    Object.assign(space.agent, patch);
  }

  /** 删除已结束的 Agent Space；返回它的所有标签 id（调用方负责归档）。 */
  removeAgentSpace(id: string): string[] {
    const existing = this.requireSpace(id);
    if (!isAgentSpace(existing)) throw new Error('不是 Agent 空间');
    if (existing.agent.state === 'active') {
      throw new Error('无法删除正在运行的 Agent 空间：请先停止或接管');
    }
    const tabIds = [...this.tabs].filter(([, meta]) => meta.spaceId === id).map(([tabId]) => tabId);
    for (const tabId of tabIds) this.tabs.delete(tabId);
    const idx = this.spaces.findIndex((s) => s.id === id);
    this.spaces.splice(idx, 1);
    this.selected.delete(id);
    if (this.activeSpaceId === id) this.activeSpaceId = this.spaces[0]!.id;
    return tabIds;
  }

  add(id: string, metadata: TabMetadata): void {
    this.requireSpace(metadata.spaceId);
    this.tabs.set(id, {
      spaceId: metadata.spaceId,
      kind: metadata.kind,
      lastActiveAt: metadata.lastActiveAt,
    });
  }

  get(id: string): TabMetadata {
    const metadata = this.tabs.get(id);
    if (!metadata) throw new Error('标签页不存在');
    return metadata;
  }

  activate(id: string, now: number): void {
    const metadata = this.get(id);
    if (metadata.kind !== 'favorite') this.activeSpaceId = metadata.spaceId;
    metadata.lastActiveAt = now;
    this.selected.set(this.activeSpaceId, id);
  }

  selectSpace(id: string): string | undefined {
    this.requireSpace(id);
    this.activeSpaceId = id;
    const visible = this.visibleIds();
    const selected = this.selected.get(id);
    if (selected && visible.includes(selected)) return selected;
    return visible.find((tabId) => this.get(tabId).kind !== 'favorite') ?? visible[0];
  }

  visibleIds(): string[] {
    return ['favorite', 'pinned', 'today'].flatMap((kind) =>
      [...this.tabs]
        .filter(
          ([, tab]) =>
            tab.kind === kind && (kind === 'favorite' || tab.spaceId === this.activeSpaceId),
        )
        .map(([id]) => id),
    );
  }

  move(id: string, spaceId: string): void {
    const target = this.requireSpace(spaceId);
    if (isAgentSpace(target) && target.agent.state === 'active') {
      throw new Error('不能把标签移入正在运行的 Agent 空间');
    }
    const meta = this.get(id);
    const source = this.spaces.find((s) => s.id === meta.spaceId);
    if (source && isAgentSpace(source) && source.agent.state === 'active') {
      throw new Error('不能把标签从正在运行的 Agent 空间移走');
    }
    meta.spaceId = spaceId;
  }

  setKind(id: string, kind: TabKind): void {
    const meta = this.get(id);
    const space = this.spaces.find((s) => s.id === meta.spaceId);
    if (space && isAgentSpace(space) && space.agent.state === 'active' && kind !== 'today') {
      throw new Error('Agent 空间里的标签不能设为固定或常用');
    }
    meta.kind = kind;
  }

  remove(id: string): string | undefined {
    const visible = this.visibleIds();
    const index = visible.indexOf(id);
    this.tabs.delete(id);
    return visible[index + 1] ?? visible[index - 1];
  }

  archiveCandidates(now: number, hours: number, protectedIds: ReadonlySet<string>): string[] {
    if (!hours) return [];
    return [...this.tabs]
      .filter(
        ([id, tab]) =>
          tab.kind === 'today' &&
          !this.occupied.has(id) &&
          !protectedIds.has(id) &&
          now - tab.lastActiveAt >= hours * 3_600_000,
      )
      .map(([id]) => id);
  }

  beginUse(id: string, now: number): () => void {
    this.get(id).lastActiveAt = now;
    this.occupied.set(id, (this.occupied.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.occupied.get(id) ?? 0) - 1;
      if (count <= 0) this.occupied.delete(id);
      else this.occupied.set(id, count);
    };
  }

  isInUse(id: string): boolean {
    return this.occupied.has(id);
  }

  editSpace(space: BrowserSpace): void {
    const existing = this.requireSpace(space.id);
    if (isAgentSpace(existing))
      throw new Error('Agent 空间的名称和颜色由 Agent 管理，无法直接编辑');
    Object.assign(existing, space);
  }

  removeSpace(id: string): void {
    const existing = this.requireSpace(id);
    if (isAgentSpace(existing) && existing.agent.state === 'active') {
      throw new Error('无法删除正在运行的 Agent 空间：请先停止或接管');
    }
    if (this.spaces.length === 1) throw new Error('至少保留一个空间');
    const index = this.spaces.findIndex((space) => space.id === id);
    this.spaces.splice(index, 1);
    const destination = this.spaces[0].id;
    for (const tab of this.tabs.values()) if (tab.spaceId === id) tab.spaceId = destination;
    this.selected.delete(id);
    if (this.activeSpaceId === id) this.activeSpaceId = destination;
  }

  private requireSpace(id: string): BrowserSpace {
    const space = this.spaces.find((item) => item.id === id);
    if (!space) throw new Error('空间不存在');
    return space;
  }
}
