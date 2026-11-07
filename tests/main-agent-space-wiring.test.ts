import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentSpaces } from '../src/main/external/spaces';
import * as protocol from '../src/main/external/space-protocol';
import { externalPrincipalForClient, type ExternalConnection } from '../src/main/external/types';
import { TabOrganization } from '../src/main/browser/tab-organization';
import { BrowserService } from '../src/main/browser/browser-service';
import { BackgroundTabWakeManager } from '../src/main/browser/background-tabs';
import type { BrowserPagePort } from '../src/main/browser/types';
import * as host from '../src/main/host';
import { AttachmentLease, ATTACHMENT_IDLE_MS } from '../src/main/host/attachment-lease';
import {
  isAgentSpace,
  TabStateSchema,
  userCustodyCount,
  type ArchivedTab,
} from '../src/shared/tab-organization';

const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function evaluate(text: string, context: Record<string, unknown>) {
  return runInNewContext(
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
}
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error('Missing production wiring');
  return found;
}
const stores: host.DurableHostStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});
function runtime() {
  vi.useFakeTimers();
  const store = new host.DurableHostStore({ path: ':memory:' });
  stores.push(store);
  const organization = new TabOrganization();
  const pages = new Map<
    string,
    {
      model: { id: string; title: string; url: string; loading: boolean };
      view: { webContents: { stopFindInPage(): void } };
      metadata: ReturnType<TabOrganization['get']>;
      pendingUrl?: string;
    }
  >();
  // Extracted VM declarations are installed dynamically; fixture values retain runtime assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context: Record<string, any> = {
    ...host,
    ...protocol,
    isAgentSpace,
    userCustodyCount,
    store,
    randomUUID,
    AttachmentLease,
    ATTACHMENT_IDLE_MS,
    externalPrincipalForClient,
    PROFILE_ID: 'test',
    USER_PRINCIPAL: 'local-user',
    HOME: 'about:blank',
    tabOrganization: organization,
    pages,
    agentOwnedTabs: new Map(),
    externalAttachments: new Map(),
    externalSpacePermissions: new Set<string>(),
    externalToolActivity: new Set(),
    sessions: new Map(),
    workspace: { data: { conversations: [] } },
    connection: { principal: 'agent:unrelated' },
    activeTabId: undefined,
    tabSelectionVersion: 0,
    archivedTabs: [] as ArchivedTab[],
    closedTabs: [],
    approvals: new Map(),
    agentSpaces: undefined,
    activeFind: undefined,
    findResult: undefined,
    backgroundTabs: { forget() {}, isWoken: () => false },
    sessionRuntimes: { list: () => [], setAgentTab() {} },
    recordingSession: { tabId: () => undefined },
    replayRunning: () => false,
    isAgentBrowserActive: () => false,
    leaveRecordingTab: vi.fn(),
    stopReplay: vi.fn(),
    emit: vi.fn(),
    layout: vi.fn(),
    log: vi.fn(),
    readable: (e: Error) => e.message,
    requestAttention() {},
    flushBroadcast() {},
    scheduledUnattendedDenials: new Set(),
    draining: false,
    spaceTimers: new Map(),
    setTimeout,
    clearTimeout,
    requireString: (v: string) => v,
  };
  const names = [
    'admitExternalConnection',
    'requireAgentSpaces',
    'activateTab',
    'grantAgentTabAcl',
    'tabOwnerPrincipal',
    'rememberTabs',
    'closeTab',
    'selectSpace',
    'requestApproval',
    'externalApprovalScopes',
    'conversationById',
    'connBySessionId',
    'isLiveConnection',
    'requireLiveActor',
    'authorizeBrowserPrincipal',
    'archiveAgentSpaceTabs',
    'rejectPrincipalApprovals',
    'takeOverAgentSpace',
    'handBackAgentSpace',
    'wakeAgentTabForTool',
    'externalAgentTabs',
    'agentOperatingActiveTab',
    'cancelBrowserApprovals',
    'refreshMenu',
    'navigationLocked',
  ];
  const functions = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
  );
  // Declarations are inert; only the tested production functions run (no Electron import/boot).
  evaluate(functions.map((fn) => fn.getText(source)).join('\n'), context);
  let sequence = 0;
  context.browser = new BrowserService({
    pageFactory: {
      create: async () => {
        throw new Error('Test must supply page creation');
      },
    },
    authorizePrincipal: (p) => context.authorizeBrowserPrincipal(p),
    resolver: { resolve: async () => ['93.184.216.34'] },
    grantVerifier: {
      verify: async () => {
        throw new Error('No granted effect in fixture');
      },
    },
    idFactory: () => `created-${++sequence}`,
  });
  const expression = findNode(
    (node) => ts.isNewExpression(node) && node.expression.getText(source) === 'AgentSpaces',
  ) as ts.NewExpression;
  const effects = evaluate(`(${expression.arguments![1].getText(source)})`, context);
  context.agentSpaces = new AgentSpaces(organization, effects);
  const connections: ExternalConnection[] = [];
  context.externalServer = {
    // 外部通道的客户端注册表：交还时用它判断客户端是否还在、是否已吊销。
    clientsSnapshot: () => [
      {
        clientId: 'client',
        name: 'CLI',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        permissionMode: 'full',
      },
    ],
    describeConnections: () => connections,
    disconnectPrincipal(principal: string) {
      for (const conn of connections) if (conn.principal === principal) conn.revoke();
    },
  };
  function connect(spaceId?: string, clientId = 'client') {
    const conn = context.admitExternalConnection(clientId, 'CLI', spaceId) as ExternalConnection;
    connections.push(conn);
    return conn;
  }
  function addTab(id: string, spaceId: string, owner: string, url = `https://example.com/${id}`) {
    const page: BrowserPagePort = {
      snapshot: async () => ({ url, title: id, loading: false }),
      screenshot: async () => ({ mimeType: 'image/png', data: '' }),
      navigate: async () => {},
      observeElements: async () => [],
      elementFingerprint: async () => undefined,
      applyEffect: async () => {},
      setLifecycleListener() {},
      close: vi.fn(),
    };
    organization.add(id, { spaceId, kind: 'today', lastActiveAt: 12 });
    pages.set(id, {
      model: { id, url, title: id, loading: false },
      view: { webContents: { stopFindInPage() {} } },
      metadata: organization.get(id),
    });
    context.browser.registry.add(id, page, 'local-user');
    if (owner !== 'local-user') {
      context.agentOwnedTabs.set(id, owner);
      context.browser.registry.addAclEntry(id, owner, 'owner');
    }
    return page;
  }
  context.openTab = vi.fn(async () => 'unexpected-human-tab');
  function ipc(name: string) {
    const call = findNode(
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'handle' &&
        node.arguments[0]?.getText(source) === `IPC.${name}`,
    ) as ts.CallExpression;
    return evaluate(`(${call.arguments[2].getText(source)})`, context) as (value: {
      id: string;
      mode?: 'temporary' | 'permanent';
    }) => Promise<void>;
  }
  return {
    context,
    organization,
    pages,
    connect,
    addTab,
    ipc,
    spaces: context.agentSpaces as AgentSpaces,
    browser: context.browser as BrowserService,
    store,
    effects,
  };
}

it('space admission fixes the attachment principal and rejects work after its space stops', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const conn = r.connect(spaceId);
  expect(conn.principal).toBe(`external:client:${spaceId}`);
  expect(conn.spaceId).toBe(spaceId);
  expect([...r.context.externalAttachments.values()][0].principal).toBe(conn.principal);
  r.context.executeTool = vi.fn(async () => 'ok');
  expect(await conn.run({ name: 'browser.tabs.list', args: {} } as never)).toBe('ok');
  await r.spaces.stop(spaceId);
  await expect(conn.run({ name: 'browser.tabs.list', args: {} } as never)).rejects.toThrow();
  expect(r.context.executeTool).toHaveBeenCalledTimes(1);
});

it('each run checks its space state even before the socket disconnects', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const conn = r.connect(spaceId);
  r.context.executeTool = vi.fn(async () => 'must not run');
  r.organization.updateAgentSpace(spaceId, { state: 'ended', endReason: 'stopped' });
  await expect(conn.run({ name: 'browser.tabs.list', args: {} } as never)).rejects.toMatchObject({
    code: 'SPACE_ENDED',
  });
  expect(r.context.executeTool).not.toHaveBeenCalled();
});

it('authorized space activation preserves user selection, recording, replay and find state', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const sub = `external:client:${spaceId}`;
  r.addTab('user', 'default', 'local-user');
  r.addTab('agent', spaceId, sub);
  r.context.activeTabId = 'user';
  r.organization.activate('user', 10);
  r.context.activeFind = { tabId: 'user' };
  const find = r.context.activeFind;
  r.context.replayRunning = () => true;
  r.context.activateTab('agent', sub);
  expect(r.context.activeTabId).toBe('user');
  expect(r.organization.activeSpaceId).toBe('default');
  expect(r.context.tabSelectionVersion).toBe(0);
  expect(r.context.activeFind).toBe(find);
  expect(r.context.leaveRecordingTab).not.toHaveBeenCalled();
  expect(r.context.stopReplay).not.toHaveBeenCalled();
  expect(() => r.context.activateTab('user', sub)).toThrow('Principal lacks');
});

it.each(['idle', 'restart'] as const)(
  '%s resume restores private owner management and close without sharing',
  async (reason) => {
    const r = runtime();
    const { spaceId } = await r.spaces.create('client', 'A');
    const sub = `external:client:${spaceId}`;
    const page = r.addTab('own', spaceId, sub);
    r.addTab('foreign', spaceId, 'external:other:space');
    r.addTab('human', spaceId, 'local-user');
    r.addTab('user', 'default', 'local-user');
    r.context.activeTabId = 'user';
    if (reason === 'restart') {
      r.browser.revokePrincipal(sub);
      r.spaces.onStartup();
    } else {
      r.context.externalSpacePermissions.add(sub);
      await r.spaces.end(spaceId, 'idle');
      expect(r.context.externalSpacePermissions.has(sub)).toBe(false);
    }
    expect(await r.spaces.admit('client', spaceId)).toBe('resumed');
    expect(r.browser.registry.require('own', sub, 'effect').id).toBe('own');
    for (const id of ['foreign', 'human'])
      expect(() => r.browser.registry.require(id, sub, 'observe')).toThrow('Principal lacks');
    expect(() => r.browser.registry.require('own', 'agent:unrelated', 'observe')).toThrow(
      'Principal lacks',
    );
    expect(r.browser.registry.require('own', sub, 'manage').id).toBe('own');
    await r.context.closeTab('own', sub);
    expect(page.close).toHaveBeenCalledOnce();
    expect(r.pages.has('own')).toBe(false);
    expect(r.browser.registry.has('own')).toBe(false);
    expect(r.context.activeTabId).toBe('user');
  },
);

it.each(['active', 'ended'] as const)(
  'viewing an empty %s Agent Space preserves it without creating a human tab',
  async (state) => {
    const r = runtime();
    const { spaceId } = await r.spaces.create('client', 'Empty');
    r.addTab('user', 'default', 'local-user');
    r.context.activeTabId = 'user';
    r.context.activeFind = { tabId: 'user' };
    r.context.findResult = { matches: 1 };
    if (state === 'ended') await r.spaces.stop(spaceId);
    await r.ipc('spaceSelect')({ id: spaceId });
    expect(r.context.openTab).not.toHaveBeenCalled();
    expect(r.organization.activeSpaceId).toBe(spaceId);
    expect(r.context.activeTabId).toBeUndefined();
    expect(r.context.activeFind).toBeUndefined();
    expect(r.context.findResult).toBeUndefined();
    expect(r.context.lastError).toBe('这个 Agent 空间还没有标签');
    expect([...r.pages.keys()]).toEqual(['user']);
    expect(r.context.layout).toHaveBeenCalled();
    expect(r.context.workspace.data.tabState.activeSpaceId).toBe(spaceId);
  },
);

function restoreRuntime() {
  const r = runtime();
  const views: object[] = [];
  r.context.pageFactory = { pages: views };
  r.context.sync = vi.fn();
  let sequence = 0;
  r.context.browser.openTab = async () => {
    const id = `restored-${++sequence}`;
    const page = r.addTab(id, 'default', 'local-user', 'about:blank');
    views.push(Object.assign(page, { view: r.pages.get(id)!.view }));
    return { tabId: id, url: 'about:blank' };
  };
  r.context.bindPage = (
    id: string,
    _view: unknown,
    _url: string,
    metadata: { spaceId: string },
  ) => {
    r.organization.get(id).spaceId = metadata.spaceId;
  };
  const open = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'openTab',
  )!;
  evaluate(open.getText(source), r.context);
  return r;
}

it.each(['active', 'ended', 'user'] as const)(
  'restoring a saved %s tab preserves provenance without consuming background capacity',
  async (kind) => {
    const r = restoreRuntime();
    const { spaceId } = await r.spaces.create('client', 'Saved');
    if (kind === 'ended') await r.spaces.stop(spaceId);
    const owner = kind === 'user' ? 'local-user' : `external:client:${spaceId}`;
    const targetSpace = kind === 'user' ? 'default' : spaceId;
    const register = vi.fn();
    r.context.backgroundTabs.register = register;
    const id = await r.context.openTab('about:blank', {
      title: 'Saved',
      url: 'about:blank',
      spaceId: targetSpace,
      kind: 'today',
      lastActiveAt: 12,
      ownerPrincipal: owner,
    });
    expect(r.context.tabOwnerPrincipal(id)).toBe(owner);
    expect(r.organization.get(id).spaceId).toBe(targetSpace);
    expect(register).not.toHaveBeenCalled();
  },
);

it('historical restore retains 13 private tabs without the real background limit aborting startup', async () => {
  const r = restoreRuntime();
  const { spaceId } = await r.spaces.create('client', 'Historical');
  const sub = `external:client:${spaceId}`;
  const manager = new BackgroundTabWakeManager({ wake() {}, hide() {} });
  r.context.backgroundTabs = manager;
  const tabs = Array.from({ length: 13 }, () => ({
    title: 'Saved',
    url: 'about:blank',
    spaceId,
    kind: 'today',
    lastActiveAt: 12,
    ownerPrincipal: sub,
  }));
  expect(() =>
    TabStateSchema.parse({
      spaces: r.organization.spaces,
      activeSpaceId: 'default',
      tabs,
      archivedTabs: [],
    }),
  ).not.toThrow();
  for (const tab of tabs) await r.context.openTab(tab.url, tab);
  expect(r.pages.size).toBe(13);
  expect(manager.backgroundCount()).toBe(0);
  for (const id of r.pages.keys()) expect(r.context.tabOwnerPrincipal(id)).toBe(sub);
  const ids = [...r.pages.keys()];
  // Registration now belongs to the authorized tool path, never the restore loop.
  expect(
    findNode(
      (node) =>
        ts.isCallExpression(node) && node.expression.getText(source) === 'wakeAgentTabForTool',
    ).getText(source),
  ).toBe('wakeAgentTabForTool(tabId, current.principal)');
  for (const id of ids.slice(0, 12)) r.context.wakeAgentTabForTool(id, sub);
  expect(manager.backgroundCount()).toBe(12);
  expect(() => r.context.wakeAgentTabForTool(ids[12], sub)).toThrow('后台标签最多 12');
  expect(manager.isWoken(ids[12])).toBe(false);
  expect(r.pages.size).toBe(13);
  manager.forget(ids[0]);
  r.context.wakeAgentTabForTool(ids[12], sub);
  expect(manager.backgroundCount()).toBe(12);
  expect(manager.isWoken(ids[12])).toBe(true);
  manager.dispose();
});

it('lazy background registration rejects unauthorized tabs and keeps shared or foreign provenance unregistered', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'Private');
  const sub = `external:client:${spaceId}`;
  const wake = vi.fn();
  const manager = new BackgroundTabWakeManager({ wake, hide() {} });
  r.context.backgroundTabs = manager;
  r.addTab('own', spaceId, sub);
  r.addTab('foreign', spaceId, 'external:other:other-space');
  r.addTab('human', 'default', 'local-user');
  expect(() => r.context.wakeAgentTabForTool('human', sub)).toThrow('Principal lacks');
  expect(manager.backgroundCount()).toBe(0);
  for (const id of ['foreign', 'human']) r.browser.registry.addAclEntry(id, sub, 'observer');
  for (const id of ['foreign', 'human']) r.context.wakeAgentTabForTool(id, sub);
  expect(manager.backgroundCount()).toBe(0);
  r.context.wakeAgentTabForTool('own', sub);
  r.context.wakeAgentTabForTool('own', sub);
  expect(manager.backgroundCount()).toBe(1);
  expect(wake).toHaveBeenCalledExactlyOnceWith('own');
  expect(r.browser.registry.require('own', sub, 'manage').id).toBe('own');
  manager.dispose();
});

it('temporary takeover keeps provenance and hands the same tab back to the Agent', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const sub = `external:client:${spaceId}`;
  r.addTab('own', spaceId, sub);
  await r.ipc('spaceTakeOverAgent')({ id: spaceId });
  // 来源仍在：交接时才能精确重授。
  expect(r.context.tabOwnerPrincipal('own')).toBe(sub);
  expect(isAgentSpace(r.organization.spaces.find((s) => s.id === spaceId)!)).toBe(true);
  expect(() => r.browser.registry.require('own', sub, 'observe')).toThrow('Principal lacks');

  await r.ipc('spaceHandBackAgent')({ id: spaceId });
  expect(r.browser.registry.require('own', sub, 'observe').id).toBe('own');
  expect(r.organization.spaces.find((s) => s.id === spaceId)!.agent).toMatchObject({
    endReason: 'handed_back',
  });
});

it('permanent takeover transfers persisted ownership to the user and keeps the former Agent denied', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const sub = `external:client:${spaceId}`;
  r.addTab('own', spaceId, sub);
  await r.ipc('spaceTakeOverAgent')({ id: spaceId, mode: 'permanent' });
  expect(r.context.tabOwnerPrincipal('own')).toBe('local-user');
  expect(r.context.workspace.data.tabState.tabs[0].ownerPrincipal).toBe('local-user');
  expect(r.browser.registry.require('own', 'local-user', 'manage').id).toBe('own');
  expect(() => r.browser.registry.require('own', sub, 'observe')).toThrow('Principal lacks');
  expect(isAgentSpace(r.organization.spaces.find((s) => s.id === spaceId)!)).toBe(false);
});

it('ended deletion IPC archives the actual pending URL and removes the live page', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const sub = `external:client:${spaceId}`;
  r.addTab('user', 'default', 'local-user');
  const page = r.addTab('own', spaceId, sub, 'about:blank');
  r.pages.get('own')!.pendingUrl = 'https://example.com/pending';
  await r.spaces.stop(spaceId);
  await r.ipc('spaceRemove')({ id: spaceId });
  expect(r.context.archivedTabs).toHaveLength(1);
  expect(r.context.archivedTabs[0]).toMatchObject({
    title: 'own',
    url: 'https://example.com/pending',
    ownerPrincipal: sub,
  });
  expect(r.pages.has('own')).toBe(false);
  expect(r.browser.registry.has('own')).toBe(false);
  expect(page.close).toHaveBeenCalled();
  expect(r.organization.activeSpaceId).toBe('default');
  expect(r.context.activeTabId).toBe('user');
  expect(r.context.openTab).not.toHaveBeenCalled();
  expect(() => TabStateSchema.parse(r.context.workspace.data.tabState)).not.toThrow();
});

it('eviction archives metadata after organization removal and caps archives at 200', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'Old');
  const page = r.addTab('old', spaceId, `external:client:${spaceId}`);
  r.context.archivedTabs = Array.from({ length: 200 }, (_, i) => ({
    id: `archive-${i}`,
    spaceId: 'default',
    kind: 'today',
    lastActiveAt: 0,
    archivedAt: 0,
    title: 'old archive',
    url: 'https://example.com/archive',
  }));
  await r.spaces.stop(spaceId);
  for (let i = 0; i < 8; i++) {
    vi.advanceTimersByTime(1);
    const s = await r.spaces.create('client', `New ${i}`);
    await r.spaces.stop(s.spaceId);
  }
  expect(r.context.archivedTabs).toHaveLength(200);
  expect(r.context.archivedTabs[0]).toMatchObject({ title: 'old', url: 'https://example.com/old' });
  expect(r.pages.has('old')).toBe(false);
  expect(page.close).toHaveBeenCalled();
});

it('stopping a space settles its actual waiting approval, denies the durable action and clears its timer', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'A');
  const conn = r.connect(spaceId);
  const actor = [...r.context.externalAttachments.values()][0];
  r.store.createIntent({
    actionId: 'action',
    sessionId: actor.sessionId,
    attachmentId: actor.attachmentId,
    connectionEpoch: 1,
    tabId: 'own',
    canonicalCommandHash: 'command',
    actionDigest: 'digest',
    canonicalCommand: { schemaVersion: '1' },
    idempotencyKey: 'key',
    revisionPreconditions: {},
    policySetVersion: 'test',
    policyVerdict: 'require_approval',
    policyReasons: [],
    obligations: [],
    approval: {
      approvalId: 'approval',
      nonce: 'nonce',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const waiting = r.context.requestApproval({
    approvalId: 'approval',
    nonce: 'nonce',
    digest: 'digest',
    tool: 'browser.click',
    summary: 'click',
    tabId: 'own',
    documentEpoch: 0,
    origin: 'https://example.com',
    actor,
  }) as Promise<unknown>;
  let outcome = 'pending';
  waiting.then(
    () => {
      outcome = 'approved';
    },
    () => {
      outcome = 'denied';
    },
  );
  await r.spaces.stop(spaceId);
  await Promise.resolve();
  expect(outcome).toBe('denied');
  expect(r.context.approvals.size).toBe(0);
  expect(r.store.getAction('action')?.state).toBe('cancelled');
  expect(vi.getTimerCount()).toBe(0);
  expect(r.context.externalAttachments.size).toBe(0);
  await expect(conn.run({ name: 'browser.tabs.list', args: {} } as never)).rejects.toThrow();
});

it('startup initializes rules synchronously before external admission is enabled', async () => {
  const r = runtime();
  r.context.agentSpaces = undefined;
  const integration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'startAgentIntegration',
  )!;
  const wiring = integration.body!.statements;
  const controller = wiring.findIndex((node) =>
    node.getText(source).startsWith('agentIntegration ='),
  );
  // Run the production initialization prefix in the same context; imports/GUI stay out of the VM.
  r.context.AgentSpaces = AgentSpaces;
  evaluate(
    `function initializeRules() { ${wiring
      .slice(0, controller)
      .map((node) => node.getText(source))
      .join('\n')
      .replace('})();', '})().catch(() => {});')} }`,
    r.context,
  );
  r.context.initializeRules();
  expect(r.context.agentSpaces).toBeInstanceOf(AgentSpaces);
});

it('external Space tabs keep AI ownership across CLI close and reconnect, then clear on takeover', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'Skill task');
  const conn = r.connect(spaceId);
  r.addTab('skill-tab', spaceId, conn.principal);
  r.addTab('human-tab', r.organization.activeSpaceId, 'local-user');
  r.context.activeTabId = 'human-tab';
  expect(r.context.externalAgentTabs()).toEqual([
    { tabId: 'skill-tab', principal: conn.principal, spaceId, phase: 'think' },
  ]);
  expect(r.context.agentOperatingActiveTab()).toBe(false);
  conn.close();
  expect(r.context.externalAgentTabs()).toHaveLength(1);
  r.context.activeTabId = 'skill-tab';
  expect(r.context.agentOperatingActiveTab()).toBe(true);
  const reconnected = r.connect(spaceId);
  expect(reconnected.principal).toBe(conn.principal);
  expect(r.context.externalAgentTabs()).toHaveLength(1);
  await r.context.takeOverAgentSpace(spaceId);
  expect(r.context.externalAgentTabs()).toEqual([]);
  expect(r.context.agentOperatingActiveTab()).toBe(false);
});

it('external tab phases follow only their own operation and approval; stop and channel shutdown clear them', async () => {
  const r = runtime();
  const a = (await r.spaces.create('client', 'A')).spaceId;
  const b = (await r.spaces.create('client', 'B')).spaceId;
  const ca = r.connect(a),
    cb = r.connect(b);
  r.addTab('a', a, ca.principal);
  r.addTab('b', b, cb.principal);
  r.addTab('unowned', a, 'local-user');
  r.context.externalToolActivity.add({ principal: ca.principal, tabId: 'a' });
  expect(r.context.externalAgentTabs().map((t: { phase: string }) => t.phase)).toEqual([
    'act',
    'think',
  ]);
  r.context.approvals.set('approval', {
    kind: 'browser',
    tabId: 'a',
    actor: { principal: ca.principal },
    view: { state: 'pending' },
    reject() {},
  });
  expect(r.context.externalAgentTabs().map((t: { phase: string }) => t.phase)).toEqual([
    'confirm',
    'think',
  ]);
  await r.spaces.end(a, 'stopped');
  expect(r.context.externalAgentTabs().map((t: { tabId: string }) => t.tabId)).toEqual(['b']);
  r.context.externalServer = undefined;
  expect(r.context.externalAgentTabs()).toEqual([]);
});

it('legacy external connection marks only owned tabs while attached and does not bind a conversation', () => {
  const r = runtime();
  const conn = r.connect();
  r.addTab('legacy', r.organization.activeSpaceId, conn.principal);
  r.addTab('human', r.organization.activeSpaceId, 'local-user');
  expect(r.context.externalAgentTabs()).toEqual([
    { tabId: 'legacy', principal: conn.principal, phase: 'think' },
  ]);
  conn.close();
  expect(r.context.externalAgentTabs()).toEqual([]);
  const next = r.connect();
  expect(r.context.externalAgentTabs()).toHaveLength(1);
  next.revoke();
  expect(r.context.externalAgentTabs()).toEqual([]);
  expect(r.context.sessionRuntimes.list()).toEqual([]);
});

it('reconnecting cannot re-lock a taken-over legacy tab or a tab moved out of an idle Space', async () => {
  const r = runtime();
  const legacy = r.connect();
  r.addTab('legacy-taken-over', 'default', legacy.principal);
  legacy.revoke();
  r.connect();
  expect(r.context.externalAgentTabs()).toEqual([]);
  const { spaceId } = await r.spaces.create('client', 'Moved');
  const conn = r.connect(spaceId);
  r.addTab('moved', spaceId, conn.principal);
  await r.spaces.end(spaceId, 'idle');
  r.organization.move('moved', 'default');
  await r.spaces.admit('client', spaceId);
  r.connect(spaceId);
  r.context.activeTabId = 'moved';
  expect(r.context.externalAgentTabs()).toEqual([]);
  expect(r.context.agentOperatingActiveTab()).toBe(false);
});

it('the native menu enables external task controls and locks only the visible external page', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'Menu');
  const conn = r.connect(spaceId);
  r.addTab('menu', spaceId, conn.principal);
  r.context.menuSignature = '';
  r.context.Menu = { setApplicationMenu: vi.fn() };
  const build = vi.fn((state) => state);
  r.context.buildMenu = build;
  r.context.runMenuAction = vi.fn();
  r.context.openSettings = vi.fn();
  const snapshot = {
    activeTabId: 'menu',
    agentStatus: 'ready',
    attachmentStatus: 'none',
    externalAgentTabs: r.context.externalAgentTabs(),
  };
  r.context.refreshMenu(snapshot);
  expect(build.mock.calls[0][0]).toMatchObject({ agentDriving: true, navigationLocked: true });
  r.context.refreshMenu({ ...snapshot, activeTabId: 'human' });
  expect(build.mock.calls[1][0]).toMatchObject({ agentDriving: false, navigationLocked: false });
});

it('closing an attachment cancels only its waiting approvals and preserves task permission', async () => {
  const r = runtime();
  const { spaceId } = await r.spaces.create('client', 'Pending');
  const conn = r.connect(spaceId);
  const actor = [...r.context.externalAttachments.values()][0];
  const other = r.connect(spaceId);
  const otherActor = r.context.externalAttachments.get(other.attachmentId);
  const reject = vi.fn();
  const siblingReject = vi.fn();
  r.context.externalSpacePermissions.add(conn.principal);
  for (const [id, bound, fail] of [
    ['old', actor, reject],
    ['sibling', otherActor, siblingReject],
  ] as const) {
    r.context.approvals.set(id, {
      kind: 'browser',
      sessionId: bound.sessionId,
      actor: bound,
      view: { approvalId: id, state: 'pending' },
      timer: setTimeout(() => {}, 60_000),
      reject: fail,
    });
  }
  conn.close();
  expect(reject).toHaveBeenCalledOnce();
  expect(siblingReject).not.toHaveBeenCalled();
  expect([...r.context.approvals.keys()]).toEqual(['sibling']);
  expect(r.context.externalSpacePermissions.has(conn.principal)).toBe(true);
  expect(vi.getTimerCount()).toBe(3); // Space idle + sibling approval + sibling lease
});
