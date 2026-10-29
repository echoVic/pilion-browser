import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserService } from '../src/main/browser/browser-service';
import { TabOrganization } from '../src/main/browser/tab-organization';
import { TabRegistry } from '../src/main/browser/tab-registry';
import type { BrowserPagePort } from '../src/main/browser/types';
import * as host from '../src/main/host';
import { ToolRequestSchema, UrlInputSchema } from '../src/shared/contracts';
import {
  DEFAULT_SPACE,
  SavedBrowserTabSchema,
  TabStateSchema,
  type ArchivedTab,
  type SavedBrowserTab,
} from '../src/shared/tab-organization';

const USER = 'local-user';
const source = ts.createSourceFile(
  'main.ts',
  process.env.PILION_TAB_PROVENANCE_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:src/main/main.ts'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      })
    : readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  'conversationById',
  'connBySessionId',
  'isLiveConnection',
  'requireLiveActor',
  'authorizeBrowserPrincipal',
  'grantAgentTabAcl',
  'revokeAgentAcls',
  'tabOwnerPrincipal',
  'bindPage',
  'openTab',
  'openAgentTab',
  'rememberTabs',
  'closeTab',
  'activateTab',
  'requireActiveTab',
  'duplicateActiveTab',
  'reopenClosedTab',
  'protectedArchiveTabs',
  'archiveTab',
  'restoreArchivedTab',
  'conversationIdForActor',
  'sessionAgentTabForActor',
  'performTool',
];
const functions = source.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name !== undefined && names.includes(node.name.text),
);
const copyBaseline =
  process.env.PILION_TAB_COPY_BASELINE === '1'
    ? ts.createSourceFile(
        'main.ts',
        execFileSync('git', ['show', 'HEAD:src/main/main.ts'], {
          cwd: new URL('..', import.meta.url),
          encoding: 'utf8',
        }),
        ts.ScriptTarget.Latest,
        true,
      )
    : undefined;
const copyFunctions = ['duplicateActiveTab', 'closeTab', 'reopenClosedTab'];
const init = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'init',
)!;
const startup = init.body!.statements;
function declares(node: ts.Statement, name: string): boolean {
  return (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((entry) => entry.name.getText(source) === name)
  );
}
const start = startup.findIndex((node) => declares(node, 'restore'));
const end = startup.findIndex((node) => declares(node, 'restored'));
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);
const startupRestore = startup
  .slice(start, end)
  .map((node) => node.getText(source))
  .join('\n');
const code = ts.transpileModule(
  functions
    .map((fn) => {
      if (copyBaseline && copyFunctions.includes(fn.name!.text)) {
        const baseline = copyBaseline.statements.find(
          (node) => ts.isFunctionDeclaration(node) && node.name?.text === fn.name!.text,
        )!;
        return baseline.getText(copyBaseline);
      }
      return fn.getText(source);
    })
    .join('\n') +
    `\nasync function restoreStartupTabs() { ${startupRestore} }\n` +
    '({ openTab, openAgentTab, rememberTabs, archiveTab, restoreArchivedTab, ' +
    'restoreStartupTabs, grantAgentTabAcl, revokeAgentAcls, requireLiveActor, performTool, ' +
    'duplicateActiveTab, closeTab, reopenClosedTab })',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

interface Actor {
  principal: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
}
interface Connection extends Actor {
  conversationId: string;
  config: { id: string };
  transport: { state: string };
  promptCancelled: boolean;
  agentTabId?: string;
}
interface PageItem {
  model: { id: string; title: string; url: string; loading: boolean };
  view: { webContents: Contents };
  pendingUrl?: string;
}
class Contents extends EventEmitter {
  openHandler?: (input: { url: string }) => { action: string };
  setWindowOpenHandler(handler: Contents['openHandler']): void {
    this.openHandler = handler;
  }
  isCurrentlyAudible(): boolean {
    return false;
  }
}
interface Api {
  openTab(url?: string, saved?: SavedBrowserTab): Promise<string>;
  openAgentTab(principal: string, url: string, actor?: Actor): Promise<string>;
  rememberTabs(): void;
  duplicateActiveTab(): Promise<string>;
  closeTab(id: string, principal?: string, rememberClosed?: boolean): Promise<void>;
  reopenClosedTab(index?: number): Promise<string | undefined>;
  archiveTab(id: string): Promise<void>;
  restoreArchivedTab(id: string): Promise<string>;
  restoreStartupTabs(): Promise<void>;
  grantAgentTabAcl(id: string, principal?: string): void;
  revokeAgentAcls(principal: string): void;
  requireLiveActor(actor: Actor): void;
  performTool(
    request: ReturnType<typeof ToolRequestSchema.parse>,
    principal: string,
    tabId: string | undefined,
    actor: Actor,
  ): Promise<{ tabId: string }>;
}
const stores: host.DurableHostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function runtime() {
  const store = new host.DurableHostStore({ path: ':memory:' });
  stores.push(store);
  const sessions = new Map<string, Connection>();
  const externalAttachments = new Map<string, Actor>();
  const pages = new Map<string, PageItem>();
  const pageFactory = {
    pages: [] as (BrowserPagePort & { view: { webContents: Contents } })[],
    pointer: { hide() {} },
  };
  const workspace = {
    data: {
      conversations: ['a', 'b'].map((id) => ({ id })),
      activeConversationId: 'b',
      tabs: [] as string[],
      activeTabIndex: 0,
      tabState: undefined as ReturnType<typeof TabStateSchema.parse> | undefined,
    },
  };
  const context = {
    ...host,
    store,
    randomUUID,
    HOME: 'about:blank',
    USER_PRINCIPAL: USER,
    DEFAULT_SPACE,
    workspace,
    sessions,
    externalAttachments,
    approvals: new Map(),
    pages,
    pageFactory,
    agentOwnedTabs: new Map<string, string>(),
    tabOrganization: new TabOrganization(),
    connection: undefined as Connection | undefined,
    activeTabId: undefined as string | undefined,
    tabSelectionVersion: 0,
    archivedTabs: [] as ArchivedTab[],
    closedTabs: [] as { title: string; url: string; ownerPrincipal: string }[],
    savedTabState: undefined as ReturnType<typeof TabStateSchema.parse> | undefined,
    settings: { data: { startupBehavior: 'restore' } },
    recordingSession: { tabId: (): string | undefined => undefined },
    backgroundTabs: { register() {}, forget() {}, isWoken: () => false },
    sessionRuntimes: { list: () => [], setAgentTab() {}, agentTab: () => undefined },
    agentShield: undefined,
    activeFind: undefined,
    findResult: undefined,
    lastError: undefined as string | undefined,
    draining: false,
    replayRunning: () => false,
    leaveRecordingTab() {},
    stopReplay() {},
    sync() {},
    layout() {},
    emit() {},
    log() {},
    readable: (error: Error) => error.message,
    browser: undefined as unknown as BrowserService,
  };
  const api = runInNewContext(code, context) as Api;
  let sequence = 0;
  let beforeCreate: (() => Promise<void>) | undefined;
  let onRegistered: (() => void) | undefined;
  const authorized: string[] = [];
  const registry = new TabRegistry();
  const browser = new BrowserService({
    registry,
    pageFactory: {
      async create(url) {
        await beforeCreate?.();
        const page: BrowserPagePort & { view: { webContents: Contents } } = {
          view: { webContents: new Contents() },
          snapshot: async () => ({ url, title: 'Example', loading: false }),
          screenshot: async () => ({ mimeType: 'image/png', data: '' }),
          navigate: async () => {},
          observeElements: async () => [],
          elementFingerprint: async () => undefined,
          applyEffect: async () => {},
          setLifecycleListener() {
            onRegistered?.();
          },
          close() {},
        };
        pageFactory.pages.push(page);
        return page;
      },
    },
    authorizePrincipal(principal) {
      authorized.push(principal);
      (
        context as unknown as { authorizeBrowserPrincipal(id: string): void }
      ).authorizeBrowserPrincipal(principal);
    },
    grantVerifier: {
      verify: async () => {
        throw new Error('No effects executed');
      },
    },
    resolver: { resolve: async () => ['93.184.216.34'] },
    idFactory: () => `tab-${++sequence}`,
  });
  context.browser = browser;
  function actor(principal: string): Actor {
    const value = {
      principal,
      sessionId: randomUUID(),
      attachmentId: randomUUID(),
      connectionEpoch: 1,
      capabilitySnapshotHash: 'test-capabilities',
    };
    store.createSession({
      ...value,
      profileId: 'test-profile',
      agentId: principal,
    });
    store.createAttachment({
      ...value,
      agentId: principal,
      role: 'owner',
      leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return value;
  }
  function connect(id: string): Connection {
    const value: Connection = {
      ...actor(`agent:shared-config:${host.sha256(id).slice(0, 8)}`),
      conversationId: id,
      config: { id: 'shared-config' },
      transport: { state: 'ready' },
      promptCancelled: false,
    };
    sessions.set(id, value);
    return value;
  }
  const a = connect('a');
  const b = connect('b');
  const external = actor('external:client-a');
  externalAttachments.set(external.attachmentId, external);
  context.connection = b;
  function revoke(owner: Actor): void {
    api.revokeAgentAcls(owner.principal);
    store.transitionAttachment(owner.attachmentId, 'detached');
    if (owner === external) externalAttachments.delete(owner.attachmentId);
    else sessions.delete(owner === a ? 'a' : 'b');
  }
  async function popup(parent: string): Promise<string> {
    const before = new Set(registry.all().map((tab) => tab.id));
    expect(
      pages.get(parent)!.view.webContents.openHandler!({
        url: 'https://example.com/private-popup',
      }),
    ).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(pages.size).toBeGreaterThan(before.size));
    expect(context.lastError).toBeUndefined();
    return registry.all().find((tab) => !before.has(tab.id))!.id;
  }
  function privateTab(id: string, owner: string): void {
    for (const permission of ['observe', 'navigate', 'effect', 'manage'] as const)
      expect(() => registry.require(id, b.principal, permission)).toThrow('Principal lacks');
    expect(registry.require(id, USER, 'manage').id).toBe(id);
    expect(context.agentOwnedTabs.get(id)).toBe(owner);
    expect(registry.get(id).acl.entries).toContainEqual({ principalId: USER, role: 'owner' });
  }
  return {
    api,
    context,
    browser,
    registry,
    pages,
    a,
    b,
    external,
    revoke,
    popup,
    privateTab,
    authorized,
    delayCreate: (callback: () => Promise<void>) => {
      beforeCreate = callback;
    },
    atRegistration: (callback: () => void) => {
      onRegistered = callback;
    },
  };
}

it.each(['agent', 'external'] as const)(
  '%s parent popups inherit the actual owner, not selected conversation B',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    r.privateTab(parent, owner.principal);
    r.context.agentOwnedTabs.delete(parent);
    const child = await r.popup(parent);
    r.api.grantAgentTabAcl(child, r.b.principal);
    r.privateTab(child, owner.principal);
    expect(r.registry.get(child).acl.entries).toContainEqual({
      principalId: owner.principal,
      role: 'owner',
    });
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: child }),
    ).resolves.toMatchObject({ tabId: child });
    await expect(r.browser.observe({ principalId: r.b.principal, tabId: child })).rejects.toThrow(
      'Principal lacks',
    );
  },
);

it.each(['agent', 'external'] as const)(
  '%s provenance is recorded before ACL changes, grants, or page publication',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const setAcl = r.browser.setTabAcl.bind(r.browser);
    const aclChanges = vi.spyOn(r.browser, 'setTabAcl').mockImplementation((actor, id, acl) => {
      expect(r.context.agentOwnedTabs.get(id)).toBe(owner.principal);
      expect(r.pages.has(id)).toBe(false);
      r.api.grantAgentTabAcl(id, r.b.principal);
      expect(() => r.registry.require(id, r.b.principal, 'observe')).toThrow('Principal lacks');
      setAcl(actor, id, acl);
    });
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    const child = await r.popup(parent);
    r.api.rememberTabs();
    const saved = r.context.workspace.data.tabState!.tabs.find((tab) => tab.url.includes('popup'))!;
    const restored = await r.api.openTab(saved.url, saved);
    expect(aclChanges).toHaveBeenCalledTimes(3);
    r.privateTab(child, owner.principal);
    r.privateTab(restored, owner.principal);
  },
);

it.each(['agent', 'external'] as const)(
  'a popup from an already revoked %s owner remains private',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    r.revoke(owner);
    const child = await r.popup(parent);
    r.api.grantAgentTabAcl(child, r.b.principal);
    r.privateTab(child, owner.principal);
  },
);

it('saved restore captures its original owner before asynchronous creation', async () => {
  const r = runtime();
  const id = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  r.api.rememberTabs();
  const saved = SavedBrowserTabSchema.parse(r.context.workspace.data.tabState!.tabs[0]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = vi.fn();
  r.delayCreate(async () => {
    entered();
    await waiting;
  });
  const restoring = r.api.openTab(saved.url, saved);
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  Object.assign(saved, { ownerPrincipal: r.b.principal });
  r.revoke(r.a);
  r.api.grantAgentTabAcl(id, r.b.principal);
  release();
  r.privateTab(await restoring, r.a.principal);
});

it('an Agent revoked at creation settlement leaves no unowned or published tab', async () => {
  const r = runtime();
  r.atRegistration(() => r.revoke(r.a));
  await expect(r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a)).rejects.toThrow();
  expect(r.registry.all()).toHaveLength(0);
  expect(r.pages.size).toBe(0);
  expect(r.context.agentOwnedTabs.size).toBe(0);
});

it('normal user popups and local-user tool tabs remain shareable without duplicate owners', async () => {
  const r = runtime();
  const parent = await r.api.openTab('https://example.com/user');
  const child = await r.popup(parent);
  expect(r.registry.require(child, r.b.principal, 'effect').id).toBe(child);
  expect(r.context.agentOwnedTabs.has(child)).toBe(false);
  const local = await r.api.openAgentTab(USER, 'https://example.com/local');
  expect(r.registry.get(local).acl.entries).toEqual([{ principalId: USER, role: 'owner' }]);
  r.api.grantAgentTabAcl(local, r.b.principal);
  expect(r.registry.require(local, r.b.principal, 'effect').id).toBe(local);
});

it('persistence tolerates a removed registry entry without losing known private provenance', async () => {
  const r = runtime();
  const user = await r.api.openTab('https://example.com/user');
  const owned = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  r.registry.remove(user);
  r.registry.remove(owned);
  r.api.rememberTabs();
  expect(r.context.workspace.data.tabState!.tabs).toEqual([
    expect.objectContaining({ ownerPrincipal: USER }),
    expect.objectContaining({ ownerPrincipal: r.a.principal }),
  ]);
});

it.each(['agent', 'external'] as const)(
  '%s provenance survives revoke while popup creation is awaiting',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    r.delayCreate(async () => {
      entered();
      await waiting;
    });
    r.authorized.length = 0;
    const child = r.popup(parent);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    r.revoke(owner);
    r.api.grantAgentTabAcl(parent, r.b.principal);
    r.privateTab(parent, owner.principal);
    release();
    const id = await child;
    r.api.grantAgentTabAcl(id, r.b.principal);
    r.privateTab(id, owner.principal);
    expect(r.authorized).not.toContain(owner.principal);
    await expect(r.browser.observe({ principalId: owner.principal, tabId: id })).rejects.toThrow();
  },
);

it.each(['agent', 'external'] as const)(
  '%s archived tabs keep original provenance through revoke and restore',
  async (kind) => {
    const r = runtime();
    await r.api.openTab();
    const owner = kind === 'agent' ? r.a : r.external;
    const id = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    r.pages.get(id)!.model.loading = false;
    r.a.agentTabId = undefined;
    r.revoke(owner);
    await r.api.archiveTab(id);
    const persisted = TabStateSchema.parse(
      JSON.parse(JSON.stringify(r.context.workspace.data.tabState)),
    );
    expect(persisted.archivedTabs[0]).toMatchObject({ ownerPrincipal: owner.principal });
    r.context.archivedTabs = persisted.archivedTabs;
    const restored = await r.api.restoreArchivedTab(persisted.archivedTabs[0].id);
    r.api.grantAgentTabAcl(restored, r.b.principal);
    r.privateTab(restored, owner.principal);
    expect(r.context.archivedTabs).toHaveLength(0);
    r.api.rememberTabs();
    expect(
      r.context.workspace.data.tabState!.tabs.find((tab) => tab.url.includes('/a')),
    ).toMatchObject({ ownerPrincipal: owner.principal });
  },
);

it.each(['restore', 'new'])(
  'actual startup %s path retains saved private owners without their live connections',
  async (behavior) => {
    const previous = runtime();
    for (const owner of [previous.a, previous.external]) {
      await previous.api.openAgentTab(
        owner.principal,
        'https://example.com/' + owner.principal,
        owner,
      );
      previous.revoke(owner);
    }
    await previous.api.openTab('https://example.com/user');
    previous.api.rememberTabs();
    const saved = TabStateSchema.parse(
      JSON.parse(JSON.stringify(previous.context.workspace.data.tabState)),
    );
    expect(saved.tabs.slice(0, 2).map((tab) => SavedBrowserTabSchema.parse(tab))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerPrincipal: previous.a.principal }),
        expect.objectContaining({ ownerPrincipal: previous.external.principal }),
      ]),
    );
    saved.tabs.forEach((tab) => {
      tab.kind = 'pinned';
    });
    const next = runtime();
    next.revoke(next.a);
    next.revoke(next.external);
    next.context.savedTabState = saved;
    next.context.settings.data.startupBehavior = behavior;
    await next.api.restoreStartupTabs();
    expect(next.registry.all()).toHaveLength(saved.tabs.length);
    for (const [index, tab] of [...next.registry.all()].entries()) {
      const owner = saved.tabs[index].ownerPrincipal!;
      next.api.grantAgentTabAcl(tab.id, next.b.principal);
      if (owner !== USER) next.privateTab(tab.id, owner);
      else expect(next.registry.require(tab.id, next.b.principal, 'effect').id).toBe(tab.id);
    }
  },
);

it.each(['tabState', 'legacyUrls'] as const)(
  'legacy human %s restoration remains shareable with B',
  async (format) => {
    const r = runtime();
    const saved = SavedBrowserTabSchema.parse({
      title: 'Legacy user tab',
      url: 'https://example.com/legacy',
      spaceId: 'default',
      kind: 'today',
      lastActiveAt: 0,
    });
    if (format === 'tabState')
      r.context.savedTabState = TabStateSchema.parse({
        spaces: [DEFAULT_SPACE],
        activeSpaceId: 'default',
        tabs: [saved],
        archivedTabs: [],
      });
    else r.context.workspace.data.tabs = [saved.url];
    await r.api.restoreStartupTabs();
    const id = r.registry.all()[0].id;
    expect(r.registry.require(id, r.b.principal, 'effect').id).toBe(id);
    expect(r.context.agentOwnedTabs.has(id)).toBe(false);
  },
);

it('tool and IPC input cannot override the trusted tab owner', async () => {
  const r = runtime();
  const request = ToolRequestSchema.parse({
    requestId: randomUUID(),
    name: 'browser.tabs.open',
    args: { url: 'https://example.com/', ownerPrincipal: USER, principal: USER },
  });
  const { tabId } = await r.api.performTool(request, r.a.principal, undefined, r.a);
  r.api.grantAgentTabAcl(tabId, r.b.principal);
  r.privateTab(tabId, r.a.principal);
  expect(UrlInputSchema.safeParse(request.args).success).toBe(false);
});

it.each(['agent', 'external'] as const)(
  '%s private duplicate uses the registry owner and stays private after revoke',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    r.pages.get(parent)!.model.url = 'https://example.com/a';
    r.context.activeTabId = parent;
    r.context.agentOwnedTabs.delete(parent);
    const duplicate = await r.api.duplicateActiveTab();
    r.privateTab(duplicate, owner.principal);
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: duplicate }),
    ).resolves.toMatchObject({ tabId: duplicate });
    r.revoke(owner);
    r.api.grantAgentTabAcl(duplicate, r.b.principal);
    r.privateTab(duplicate, owner.principal);
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: duplicate }),
    ).rejects.toThrow();
  },
);

it.each(['agent', 'external'] as const)(
  '%s private duplicate retains provenance when its owner is already revoked',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    const parent = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    r.context.activeTabId = parent;
    r.revoke(owner);
    const duplicate = await r.api.duplicateActiveTab();
    r.api.grantAgentTabAcl(duplicate, r.b.principal);
    r.privateTab(duplicate, owner.principal);
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: duplicate }),
    ).rejects.toThrow();
  },
);

it.each(['agent', 'external'] as const)(
  '%s private closed-tab snapshot captures the owner before close removes provenance',
  async (kind) => {
    const r = runtime();
    await r.api.openTab();
    const owner = kind === 'agent' ? r.a : r.external;
    const id = await r.api.openAgentTab(owner.principal, 'https://example.com/a', owner);
    const title = r.pages.get(id)!.model.title;
    r.context.agentOwnedTabs.delete(id);
    const page = r.registry.get(id).page;
    vi.spyOn(page, 'close').mockImplementation(() => {
      expect(r.registry.has(id)).toBe(false);
      r.revoke(owner);
      r.context.agentOwnedTabs.delete(id);
    });
    await r.api.closeTab(id);
    expect(r.context.closedTabs).toEqual([
      { title, url: 'https://example.com/a', ownerPrincipal: owner.principal },
    ]);
    const reopened = (await r.api.reopenClosedTab())!;
    r.api.grantAgentTabAcl(reopened, r.b.principal);
    r.privateTab(reopened, owner.principal);
    expect(r.context.closedTabs).toHaveLength(0);
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: reopened }),
    ).rejects.toThrow();
  },
);

it.each(['agent', 'external'] as const)(
  '%s private reopen uses its trusted closed descriptor after revoke',
  async (kind) => {
    const r = runtime();
    const owner = kind === 'agent' ? r.a : r.external;
    r.revoke(owner);
    r.context.closedTabs.push({
      title: 'Private tab',
      url: 'https://example.com/private',
      ownerPrincipal: owner.principal,
    });
    const reopened = (await r.api.reopenClosedTab())!;
    r.api.grantAgentTabAcl(reopened, r.b.principal);
    r.privateTab(reopened, owner.principal);
    await expect(
      r.browser.observe({ principalId: owner.principal, tabId: reopened }),
    ).rejects.toThrow();
  },
);

it.each(['duplicate', 'reopen'] as const)(
  'private %s captures ownership before asynchronous creation and revocation',
  async (action) => {
    const r = runtime();
    await r.api.openTab();
    const parent = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
    r.context.activeTabId = parent;
    if (action === 'reopen') await r.api.closeTab(parent);
    const closed = r.context.closedTabs[0];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    r.delayCreate(async () => {
      entered();
      await waiting;
    });
    const copying = action === 'duplicate' ? r.api.duplicateActiveTab() : r.api.reopenClosedTab();
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    r.revoke(r.a);
    r.context.activeTabId = undefined;
    r.context.agentOwnedTabs.delete(parent);
    if (closed) closed.ownerPrincipal = r.b.principal;
    release();
    const id = (await copying)!;
    r.api.grantAgentTabAcl(id, r.b.principal);
    r.privateTab(id, r.a.principal);
    await expect(r.browser.observe({ principalId: r.a.principal, tabId: id })).rejects.toThrow();
  },
);

it('local-human duplicate and reopen remain shareable with selected B', async () => {
  const r = runtime();
  const parent = await r.api.openTab('https://example.com/user');
  r.pages.get(parent)!.model.url = 'https://example.com/user';
  const duplicate = await r.api.duplicateActiveTab();
  expect(r.registry.require(duplicate, r.b.principal, 'effect').id).toBe(duplicate);
  expect(r.context.agentOwnedTabs.has(duplicate)).toBe(false);
  await r.api.closeTab(parent);
  expect(r.context.closedTabs[0]).toMatchObject({
    url: 'https://example.com/user',
    ownerPrincipal: USER,
  });
  const reopened = (await r.api.reopenClosedTab())!;
  expect(r.registry.require(reopened, r.b.principal, 'effect').id).toBe(reopened);
  expect(r.context.agentOwnedTabs.has(reopened)).toBe(false);
});

it('private duplicate and reopen ignore caller and page-model ownership spoofing', async () => {
  const r = runtime();
  await r.api.openTab();
  const parent = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  r.context.activeTabId = parent;
  Object.assign(r.pages.get(parent)!.model, { ownerPrincipal: USER, principal: USER });
  const spoof = { ownerPrincipal: USER, principal: USER };
  const duplicate = await Reflect.apply(r.api.duplicateActiveTab, undefined, [spoof]);
  r.privateTab(duplicate, r.a.principal);
  await r.api.closeTab(parent);
  const reopened = await Reflect.apply(r.api.reopenClosedTab, undefined, [0, spoof]);
  r.privateTab(reopened, r.a.principal);
  const register = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc',
  )!;
  const handlers = new Map<string, { schema: unknown; callback: () => Promise<unknown> }>();
  const registrations = register.body!.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ['IPC.tabDuplicate', 'IPC.tabReopenClosed'].includes(
        node.expression.arguments[0]?.getText(source) ?? '',
      ),
  );
  runInNewContext(
    ts.transpileModule(registrations.map((node) => node.getText(source)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      IPC: { tabDuplicate: 'duplicate', tabReopenClosed: 'reopen' },
      handle: (name: string, schema: unknown, callback: () => Promise<unknown>) => {
        handlers.set(name, { schema, callback });
      },
      duplicateActiveTab: r.api.duplicateActiveTab,
      reopenClosedTab: r.api.reopenClosedTab,
    },
  );
  expect(handlers.size).toBe(2);
  for (const handler of handlers.values()) expect(handler.schema).toBeUndefined();
  const ipcDuplicate = await Reflect.apply(handlers.get('duplicate')!.callback, undefined, [spoof]);
  r.privateTab(ipcDuplicate, r.a.principal);
  await r.api.closeTab(reopened);
  const ipcReopened = await Reflect.apply(handlers.get('reopen')!.callback, undefined, [spoof]);
  r.privateTab(ipcReopened, r.a.principal);
});

it('close manage denial happens before recording, replay, snapshot, or browser close', async () => {
  const r = runtime();
  const id = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  r.context.activeTabId = id;
  r.context.recordingSession.tabId = () => id;
  r.context.replayRunning = () => true;
  const recording = vi.spyOn(r.context, 'leaveRecordingTab');
  const replay = vi.spyOn(r.context, 'stopReplay');
  const closing = vi.spyOn(r.browser, 'closeTab');
  const snapshot = vi.spyOn(r.context.agentOwnedTabs, 'get');
  await expect(r.api.closeTab(id, r.b.principal)).rejects.toThrow('Principal lacks manage');
  expect(recording).not.toHaveBeenCalled();
  expect(replay).not.toHaveBeenCalled();
  expect(closing).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(r.context.closedTabs).toHaveLength(0);
  expect(r.registry.has(id)).toBe(true);
  expect(r.pages.has(id)).toBe(true);
});

it('authorized close preserves manage, recording, replay, browser-close ordering', async () => {
  const r = runtime();
  await r.api.openTab();
  const id = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  r.context.activeTabId = id;
  r.context.recordingSession.tabId = () => id;
  r.context.replayRunning = () => true;
  const order: string[] = [];
  const require = r.registry.require.bind(r.registry);
  vi.spyOn(r.registry, 'require').mockImplementation((tab, actor, permission) => {
    order.push(permission);
    return require(tab, actor, permission);
  });
  vi.spyOn(r.context, 'leaveRecordingTab').mockImplementation(() => {
    order.push('recording');
  });
  vi.spyOn(r.context, 'stopReplay').mockImplementation(() => {
    order.push('replay');
  });
  const close = r.browser.closeTab.bind(r.browser);
  vi.spyOn(r.browser, 'closeTab').mockImplementation((actor, tab) => {
    order.push('close');
    return close(actor, tab);
  });
  await r.api.closeTab(id);
  expect(order.slice(0, 4)).toEqual(['manage', 'recording', 'replay', 'close']);
});

it('private reopen failure retains the closed owner for a successful retry', async () => {
  const r = runtime();
  await r.api.openTab();
  const id = await r.api.openAgentTab(r.a.principal, 'https://example.com/a', r.a);
  await r.api.closeTab(id);
  const closed = r.context.closedTabs[0];
  r.delayCreate(async () => {
    throw new Error('creation failed');
  });
  await expect(r.api.reopenClosedTab()).rejects.toThrow('creation failed');
  expect(r.context.closedTabs).toEqual([closed]);
  expect(closed.ownerPrincipal).toBe(r.a.principal);
  r.delayCreate(async () => {});
  const reopened = (await r.api.reopenClosedTab())!;
  r.privateTab(reopened, r.a.principal);
});
