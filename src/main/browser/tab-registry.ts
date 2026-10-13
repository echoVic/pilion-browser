import { BrowserError } from './errors.js';
import type {
  BrowserPagePort,
  EpochSnapshot,
  PrincipalId,
  TabAcl,
  TabId,
  TabPermission,
  TabRole,
} from './types.js';

const ROLE_PERMISSIONS: Readonly<Record<TabRole, ReadonlySet<TabPermission>>> = {
  owner: new Set(['observe', 'navigate', 'effect', 'manage']),
  operator: new Set(['observe', 'navigate', 'effect']),
  observer: new Set(['observe']),
};

export interface RegisteredTab {
  readonly id: TabId;
  readonly page: BrowserPagePort;
  acl: TabAcl;
  documentEpoch: number;
  readonly frameEpochs: Map<string, number>;
  fencing: number;
}

export class TabRegistry {
  private readonly tabs = new Map<TabId, RegisteredTab>();

  add(id: TabId, page: BrowserPagePort, owner: PrincipalId): RegisteredTab {
    if (this.tabs.has(id)) throw new BrowserError('INVALID_ARGUMENT', 'Tab already exists');
    const tab: RegisteredTab = {
      id,
      page,
      acl: { entries: [{ principalId: owner, role: 'owner' }] },
      documentEpoch: 0,
      frameEpochs: new Map([['main', 0]]),
      fencing: 0,
    };
    this.tabs.set(id, tab);
    return tab;
  }

  has(id: TabId): boolean {
    return this.tabs.has(id);
  }

  get(id: TabId): RegisteredTab {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserError('TAB_NOT_FOUND', 'Tab does not exist');
    return tab;
  }

  remove(id: TabId): RegisteredTab {
    const tab = this.get(id);
    this.tabs.delete(id);
    return tab;
  }

  listFor(principalId: PrincipalId): ReadonlyArray<RegisteredTab> {
    return [...this.tabs.values()].filter((tab) => this.hasPermission(tab, principalId, 'observe'));
  }

  setAcl(actor: PrincipalId, tabId: TabId, acl: TabAcl): void {
    const tab = this.require(tabId, actor, 'manage');
    if (!acl.entries.some((entry) => entry.role === 'owner')) {
      throw new BrowserError('INVALID_ARGUMENT', 'A tab ACL must retain an owner');
    }
    const principals = new Set<string>();
    for (const entry of acl.entries) {
      if (!entry.principalId || principals.has(entry.principalId)) {
        throw new BrowserError('INVALID_ARGUMENT', 'ACL principals must be non-empty and unique');
      }
      principals.add(entry.principalId);
    }
    tab.acl = { entries: acl.entries.map((entry) => ({ ...entry })) };
    tab.fencing += 1;
  }

  require(tabId: TabId, principalId: PrincipalId, permission: TabPermission): RegisteredTab {
    const tab = this.get(tabId);
    if (!this.hasPermission(tab, principalId, permission)) {
      throw new BrowserError('PERMISSION_DENIED', `Principal lacks ${permission} permission`);
    }
    return tab;
  }

  /**
   * 某个 Agent 断开 / 接管时，只把它自己这个 principal 从所有标签的 ACL 里摘掉。
   * 多会话下不能整表重写 ACL——那会顺手删掉其它会话 Agent 的 operator 权限。fencing 照常递增，
   * 让正在进行中的旧操作失效。若摘完会没有 owner（不应发生，owner 永远是用户），则跳过该标签。
   */
  removePrincipalFromAcls(principalId: PrincipalId): void {
    for (const tab of this.tabs.values()) {
      const kept = tab.acl.entries.filter((entry) => entry.principalId !== principalId);
      if (kept.length === tab.acl.entries.length) continue;
      if (!kept.some((entry) => entry.role === 'owner')) continue;
      tab.acl = { entries: kept.map((entry) => ({ ...entry })) };
      tab.fencing += 1;
    }
  }

  hasPermission(tab: RegisteredTab, principalId: PrincipalId, permission: TabPermission): boolean {
    const role = tab.acl.entries.find((entry) => entry.principalId === principalId)?.role;
    return role !== undefined && ROLE_PERMISSIONS[role].has(permission);
  }

  commitDocument(tabId: TabId): EpochSnapshot {
    const tab = this.get(tabId);
    tab.documentEpoch += 1;
    tab.frameEpochs.clear();
    tab.frameEpochs.set('main', 0);
    tab.fencing += 1;
    return this.epochs(tab);
  }

  commitFrame(tabId: TabId, frameId: string): EpochSnapshot {
    const tab = this.get(tabId);
    tab.frameEpochs.set(frameId, (tab.frameEpochs.get(frameId) ?? 0) + 1);
    tab.fencing += 1;
    return this.epochs(tab);
  }

  epochs(tab: RegisteredTab): EpochSnapshot {
    return { documentEpoch: tab.documentEpoch, frameEpochs: Object.fromEntries(tab.frameEpochs) };
  }
}
