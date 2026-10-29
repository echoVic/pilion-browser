import {
  DEFAULT_SPACE,
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
    if (this.spaces.length >= 20) throw new Error('最多创建 20 个空间');
    if (this.spaces.some((space) => space.id === id)) throw new Error('空间已存在');
    const space = { name, color, id };
    this.spaces.push(space);
    return space;
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
    this.requireSpace(spaceId);
    this.get(id).spaceId = spaceId;
  }

  setKind(id: string, kind: TabKind): void {
    this.get(id).kind = kind;
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
    Object.assign(this.requireSpace(space.id), space);
  }

  removeSpace(id: string): void {
    this.requireSpace(id);
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
