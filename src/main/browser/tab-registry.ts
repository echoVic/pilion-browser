import { BrowserError } from './errors.js';
import type { BrowserPagePort, EpochSnapshot, PrincipalId, TabAcl, TabId, TabPermission, TabRole } from './types.js';

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
    return [...this.tabs.values()].filter(tab => this.hasPermission(tab, principalId, 'observe'));
  }

  setAcl(actor: PrincipalId, tabId: TabId, acl: TabAcl): void {
    const tab = this.require(tabId, actor, 'manage');
    if (!acl.entries.some(entry => entry.role === 'owner')) {
      throw new BrowserError('INVALID_ARGUMENT', 'A tab ACL must retain an owner');
    }
    const principals = new Set<string>();
    for (const entry of acl.entries) {
      if (!entry.principalId || principals.has(entry.principalId)) {
        throw new BrowserError('INVALID_ARGUMENT', 'ACL principals must be non-empty and unique');
      }
      principals.add(entry.principalId);
    }
    tab.acl = { entries: acl.entries.map(entry => ({ ...entry })) };
    tab.fencing += 1;
  }

  require(tabId: TabId, principalId: PrincipalId, permission: TabPermission): RegisteredTab {
    const tab = this.get(tabId);
    if (!this.hasPermission(tab, principalId, permission)) {
      throw new BrowserError('PERMISSION_DENIED', `Principal lacks ${permission} permission`);
    }
    return tab;
  }

  hasPermission(tab: RegisteredTab, principalId: PrincipalId, permission: TabPermission): boolean {
    const role = tab.acl.entries.find(entry => entry.principalId === principalId)?.role;
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
