import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DurableHostStore,
  ExecutionGrantAuthority,
  HostError,
  actionDigest,
  canonicalCommandHash,
  canonicalizeCommand,
  classifySemanticRisk,
  evaluatePolicy,
  sha256,
} from '../src/main/host/index';
import { BrowserService } from '../src/main/browser/browser-service';
import { BrowserError } from '../src/main/browser/errors';
import type { BrowserPagePort, Observation } from '../src/main/browser/types';
import {
  MAX_CONCURRENT_SESSIONS,
  SessionRuntimeRegistry,
} from '../src/main/agents/session-runtime';
import * as contracts from '../src/shared/contracts';
import * as schedule from '../src/shared/schedule';

const source = ts.createSourceFile(
  'main.ts',
  process.env.PILION_MAIN_SECURITY_BASELINE === '1'
    ? execFileSync('git', ['show', ':0:src/main/main.ts'], { encoding: 'utf8' })
    : readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const functions = [
  'executeTool',
  'runTool',
  'executePreparedAction',
  'performTool',
  'targetTab',
  'sessionAgentTabForActor',
  'conversationIdForActor',
  'actorPermissionMode',
  'conversationPermissionMode',
  'conversationById',
  'taskRunning',
  'activeConn',
  'connByIdentity',
  'connBySessionId',
  'requireAttachment',
  'grantAgentTabAcl',
  'revokeAgentAcls',
  'detachAgent',
  'attachAgent',
  'expireCurrentAttachment',
  'expireAttachment',
  'authorizeBrowserPrincipal',
  'verifier',
  'effectFor',
  'effectRef',
  'trustedCommandArguments',
  'trustedApprovalSummary',
  'validateTrustedEffectTarget',
  'requireString',
  'safeOrigin',
  'requestApproval',
  'respondApproval',
  'approvalOrigin',
  'approvalSender',
  'cancelBrowserApprovals',
  'cancelAcpApprovals',
  'interruptAgent',
  'requestAgentPermission',
  'sessionPermissionMode',
  'loadSkillForPlay',
  'skillApprovalSummary',
  'skillApprovalKey',
  'requireActiveConversationId',
  'isLiveConnection',
  'requireLiveActor',
  'executeAgentTask',
  'handleSessionUpdate',
  'handleGoalUpdate',
  'pauseForHuman',
  'runScheduleTool',
  'requestScheduleApproval',
  'formatWhenShort',
  'requireConversationConnection',
];

type Actor = {
  principal: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
  replayApproval?: string;
};
class FakeLease {
  constructor(readonly options: { expire(): void }) {}
  stop = vi.fn();
  activity = vi.fn();
  beginActivity = () => () => {};
}
type Conn = {
  conversationId: string;
  config: { id: string };
  principal: string;
  sessionId: string;
  capabilitySnapshotHash: string;
  connectionEpoch: number;
  attachmentId?: string;
  attachmentLease?: FakeLease;
  promptCancelled: boolean;
  promptActive: boolean;
  connectionBusy: boolean;
  toolExecutions: number;
  taskId?: string;
  transport: {
    state: string;
    sessionId: string;
    capabilities: { agent: object; agentInfo?: object };
    traceSnapshot: object[];
    supportsPersistentGoals: boolean;
    cancel(): Promise<void>;
    clearGoal(): Promise<void>;
    prompt(contents: object[]): Promise<{ stopReason: string }>;
    holdIdle(): () => void;
    setGoal(text: string): Promise<void>;
  };
};
type Pending = {
  kind: string;
  conversationId?: string;
  sessionId?: string;
  view: { approvalId: string; externalClientName?: string };
  nonce: string;
  actionDigest: string;
};
type Api = {
  attachAgent(conn: Conn): void;
  detachAgent(conn: Conn): void;
  interruptAgent(mode: string, note: undefined, id: string): Promise<void>;
  executeTool(request: contracts.ToolRequest, actor: Actor): Promise<unknown>;
  requestAgentPermission(request: object, conn: Conn): Promise<unknown>;
  executeAgentTask(input: object, resuming: boolean, conn: Conn): Promise<unknown>;
  handleSessionUpdate(conn: Conn, update: object): void;
  handleGoalUpdate(conn: Conn, goal: object): void;
  targetTab(request: contracts.ToolRequest, actor: Actor): string | undefined;
  respondApproval(event: object, response: object): void;
};
const stores: DurableHostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function runtime() {
  const store = new DurableHostStore({ path: ':memory:' });
  stores.push(store);
  const conversation = (id: string): contracts.Conversation => ({
    id,
    title: 'New conversation',
    agentId: `agent:${id}`,
    updatedAt: '',
    permissionMode: 'full',
    task: {
      id: `task:${id}`,
      agentId: `agent:${id}`,
      goal: 'mock task',
      status: 'running',
      updatedAt: '',
    },
    messages: [],
  });
  const a = conversation('a'),
    b = conversation('b');
  const workspace = {
    data: { conversations: [a, b], activeConversationId: a.id, permissionMode: 'full' },
    get current() {
      return this.data.conversations.find((c) => c.id === this.data.activeConversationId);
    },
    append: vi.fn((message: contracts.ConversationMessage) =>
      workspace.current!.messages.push(message),
    ),
  };
  const context = {
    ...contracts,
    ...schedule,
    DurableHostStore,
    ExecutionGrantAuthority,
    HostError,
    BrowserError,
    actionDigest,
    canonicalCommandHash,
    canonicalizeCommand,
    classifySemanticRisk,
    evaluatePolicy,
    sha256,
    randomBytes,
    randomUUID,
    Buffer,
    URL,
    Date,
    AbortController,
    store,
    workspace,
    sessions: new Map<string, Conn>(),
    USER_PRINCIPAL: 'local-user',
    PROFILE_ID: 'profile',
    HOST_INSTANCE_ID: 'host',
    POLICY_VERSION: 'policy',
    HOME: 'about:blank',
    ATTACHMENT_IDLE_MS: 3_600_000,
    AttachmentLease: FakeLease,
    grants: new ExecutionGrantAuthority(),
    grantBindings: new Map(),
    approvals: new Map<string, Pending>(),
    gestureTokens: new Map(),
    externalAttachments: new Map(),
    agentOwnedTabs: new Map(),
    scheduledUnattendedDenials: new Set(),
    freshSessionNotice: new Set(),
    sessionRuntimes: new SessionRuntimeRegistry({ interrupt: async () => {} }),
    pages: new Map(),
    pageFactory: { pointer: { hide: vi.fn() }, pages: [] },
    recordingSession: { isRecording: () => false },
    distillation: { running: false },
    replayRunning: () => false,
    agentStatus: 'ready',
    restoreReadyAfterTools: false,
    connectionBusy: false,
    viewport: { commandBarOpen: false },
    draining: false,
    connection: undefined as Conn | undefined,
    activeTabId: undefined as string | undefined,
    agentReplay: undefined as
      { sessionId: string; attachmentId: string; abort: AbortController } | undefined,
    agentReplayStarting: false,
    pendingSkillPlays: new Map(),
    approvedSkills: new Map<string, Set<string>>(),
    tabOrganization: { beginUse: () => () => {} },
    backgroundTabs: { isBackground: () => false },
    lastError: undefined,
    emit() {},
    log() {},
    requestAttention() {},
    flushBroadcast() {},
    trustedRenderer() {},
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    failConnection: vi.fn(async () => {}),
    executionFailureResult: () => ({ error: 'redacted' }),
    stepsHash: () => 'skill-hash',
    describeStep: () => 'mock step',
    playSkillForAgent: vi
      .fn<(...args: unknown[]) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true }),
    library: {
      hasSkill: async () => true,
      readSkill: async () => ({ skill: { meta: { name: 'mock', about: 'mock' }, steps: [{}] } }),
    },
    runPrompt: async (
      contents: object[],
      options: { prompt(contents: object[]): Promise<unknown> },
    ) => options.prompt(contents),
    promptContents: (text: string) => [{ type: 'text', text }],
    isEmptyAgentReply: (text: string) => !text.trim(),
    AgentEmptyResponseError: class extends Error {},
    skillProposals: { capture: vi.fn() },
    createSchedule: vi.fn((input: object, origin: object) => ({
      ...input,
      origin,
      id: 'new-schedule',
    })),
    schedules: { items: [] },
    currentPageUrl: () => 'https://example.com/',
    handoverBaseline: undefined,
    externalServer: {
      describeConnections: () => [
        { principal: 'external:client', name: 'Trusted External Client' },
      ],
    },
  };
  const extracted = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? ''),
  );
  runInNewContext(
    ts.transpileModule(
      `${extracted.map((node) => node.getText(source)).join('\n')}
       globalThis.api = { ${extracted.map((node) => node.name!.text).join(',')} };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText,
    context,
  );
  const api = (context as typeof context & { api: Api }).api;
  const browser = new BrowserService({
    pageFactory: {
      create: async () => {
        throw new Error('unused');
      },
    },
    grantVerifier: (context as typeof context & { verifier(): never }).verifier(),
    authorizePrincipal: (context as typeof context & { authorizeBrowserPrincipal(p: string): void })
      .authorizeBrowserPrincipal,
    resolver: { resolve: async () => ['93.184.216.34'] },
  });
  Object.assign(context, { browser });
  function connect(conv: contracts.Conversation): Conn {
    const conn: Conn = {
      conversationId: conv.id,
      config: { id: conv.agentId! },
      principal: `agent:${conv.id}`,
      sessionId: randomUUID(),
      capabilitySnapshotHash: 'capability',
      connectionEpoch: 1,
      promptCancelled: false,
      promptActive: false,
      connectionBusy: false,
      toolExecutions: 0,
      transport: {
        state: 'ready',
        sessionId: 'same-acp-id',
        capabilities: { agent: {} },
        traceSnapshot: [],
        supportsPersistentGoals: false,
        cancel: async () => {},
        clearGoal: async () => {},
        prompt: async () => ({ stopReason: 'end_turn' }),
        holdIdle: () => () => {},
        setGoal: async () => {},
      },
    };
    context.sessions.set(conv.id, conn);
    store.createSession({
      sessionId: conn.sessionId,
      profileId: 'profile',
      principal: conn.principal,
      agentId: conn.config.id,
      connectionEpoch: 1,
      capabilitySnapshotHash: 'capability',
    });
    api.attachAgent(conn);
    context.sessionRuntimes.begin(conv.id, conn.principal, conn.config.id);
    return conn;
  }
  const ca = connect(a),
    cb = connect(b);
  context.connection = ca;
  function tab(id: string, owner: string, overrides: Partial<BrowserPagePort> = {}) {
    const page: BrowserPagePort = {
      snapshot: async () => ({ url: 'https://example.com/', title: 'mock', loading: false }),
      readText: async () => 'mock',
      screenshot: async () => ({ mimeType: 'image/png', data: 'mock' }),
      navigate: async () => {},
      observeElements: async () => [
        {
          elementKey: '1',
          frameId: 'main',
          localFingerprint: 'fp',
          role: 'textbox',
          name: 'Mock field',
          disabled: false,
          tagName: 'input',
          inputType: 'text',
        },
      ],
      elementFingerprint: async () => 'fp',
      applyEffect: async () => {},
      setLifecycleListener() {},
      close() {},
      ...overrides,
    };
    browser.registry.add(id, page, owner);
    browser.setTabAcl(owner, id, {
      entries:
        owner === 'local-user'
          ? [{ principalId: owner, role: 'owner' }]
          : [
              { principalId: owner, role: 'owner' },
              { principalId: 'local-user', role: 'owner' },
            ],
    });
    context.pages.set(id, {
      model: { id, url: 'https://example.com/' },
      view: { webContents: { getURL: () => 'https://example.com/' } },
    });
    return page;
  }
  const actor = (conn: Conn): Actor => ({ ...conn, attachmentId: conn.attachmentId ?? '' });
  const request = (name: contracts.ToolRequest['name'], args = {}) =>
    contracts.ToolRequestSchema.parse({ requestId: randomUUID(), name, args });
  function approve(pending: Pending) {
    const token = randomUUID();
    context.gestureTokens.set(token, {
      senderId: 1,
      approvalId: pending.view.approvalId,
      expiresAt: Date.now() + 60_000,
    });
    api.respondApproval(
      { sender: { id: 1 } },
      {
        approvalId: pending.view.approvalId,
        nonce: pending.nonce,
        actionDigest: pending.actionDigest,
        gestureToken: token,
        decision: 'approve',
      },
    );
  }
  return { context, api, store, browser, a, b, ca, cb, tab, actor, request, approve };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function ipc(e: ReturnType<typeof runtime>) {
  const handlers = new Map<string, (input?: unknown) => unknown>();
  Object.assign(e.context, {
    handle: (
      channel: string,
      schema: { parse(input: unknown): unknown } | undefined,
      fn: (input: unknown) => unknown,
    ) => {
      handlers.set(channel, (input) => fn(schema ? schema.parse(input) : input));
    },
  });
  const register = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc',
  )!;
  const channels = new Set([
    'IPC.agentAttach',
    'IPC.agentDetach',
    'IPC.agentTask',
    'IPC.agentCancel',
    'IPC.agentTakeOver',
    'IPC.agentResume',
  ]);
  const nodes = register.body!.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      channels.has(node.expression.arguments[0]?.getText(source)),
  );
  expect(nodes).toHaveLength(6);
  runInNewContext(
    ts.transpileModule(nodes.map((node) => node.getText(source)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    e.context,
  );
  return (channel: string, input?: unknown) =>
    Promise.resolve().then(() => handlers.get(channel)!(input));
}
async function approvalReady(context: { approvals: Map<string, Pending> }) {
  await vi.waitFor(() => expect(context.approvals.size).toBe(1));
  return [...context.approvals.values()][0];
}

it('G2-1: reattachment cannot grant access to sibling or external-owned tabs', async () => {
  const e = runtime();
  e.tab('sibling', e.ca.principal);
  e.tab('external', 'external:client');
  e.tab('human', 'local-user');
  e.api.detachAgent(e.cb);
  e.api.attachAgent(e.cb);
  for (const id of ['sibling', 'external']) {
    await expect(
      e.api.executeTool(e.request('browser.observe', { tabId: id }), e.actor(e.cb)),
    ).rejects.toThrow(/permission/);
  }
  await expect(
    e.api.executeTool(e.request('browser.observe', { tabId: 'human' }), e.actor(e.cb)),
  ).resolves.toMatchObject({ tabId: 'human' });
});

it('reattachment does not reclassify a revoked sibling-owned tab as a human tab', () => {
  const e = runtime();
  e.tab('sibling', e.ca.principal);
  e.api.detachAgent(e.ca);
  e.api.detachAgent(e.cb);
  e.api.attachAgent(e.cb);
  expect(e.browser.registry.listFor(e.cb.principal).map((tab) => tab.id)).not.toContain('sibling');
  e.api.attachAgent(e.ca);
  expect(e.browser.registry.listFor(e.ca.principal).map((tab) => tab.id)).toContain('sibling');
});

it('G2-2: interrupting background B aborts its in-flight effect and preserves A', async () => {
  const e = runtime(),
    gate = deferred(),
    started = deferred();
  let signalSeen: AbortSignal | undefined,
    writes = 0;
  e.tab('tab-b', e.cb.principal, {
    applyEffect: async (_f, _k, _e, signal) => {
      signalSeen = signal;
      started.resolve();
      await gate.promise;
      signal?.throwIfAborted();
      writes++;
    },
  });
  const actor = e.actor(e.cb);
  const observed = (await e.api.executeTool(
    e.request('browser.observe', { tabId: 'tab-b' }),
    actor,
  )) as Observation;
  const pending = e.api
    .executeTool(
      e.request('browser.type', {
        tabId: 'tab-b',
        elementRef: observed.elements[0].ref,
        text: 'mock',
      }),
      actor,
    )
    .then(
      () => 'succeeded',
      () => 'aborted',
    );
  await started.promise;
  const attachmentA = e.ca.attachmentId;
  await e.api.interruptAgent('manual', undefined, e.b.id);
  gate.resolve();
  const result = await pending;
  expect(signalSeen?.aborted).toBe(true);
  expect(result).toBe('aborted');
  expect(writes).toBe(0);
  expect(e.ca.attachmentId).toBe(attachmentA);
  expect(e.cb.attachmentId).toBeUndefined();
  expect(e.context.agentStatus).toBe('ready');
});

it('G2-3: ACP ask belongs to the captured connection despite colliding transport IDs', async () => {
  const e = runtime();
  e.b.permissionMode = 'ask';
  const pending = e.api.requestAgentPermission(
    {
      sessionId: e.cb.transport.sessionId,
      options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow once' }],
      toolCall: { toolCallId: 'mock', title: 'mock', rawInput: {} },
    },
    e.cb,
  );
  await Promise.resolve();
  expect(e.context.approvals.size).toBe(1);
  const approval = [...e.context.approvals.values()][0];
  expect(approval.conversationId).toBe(e.b.id);
  e.api.detachAgent(e.ca);
  expect(e.context.approvals.size).toBe(1);
  e.api.detachAgent(e.cb);
  await expect(pending).resolves.toMatchObject({ outcome: { outcome: 'cancelled' } });
});

it('connectAgent binds the actual transport permission callback to its new connection', async () => {
  const e = runtime();
  e.b.permissionMode = 'ask';
  let permission!: (request: object) => Promise<unknown>;
  const transport = Object.assign(new EventEmitter(), e.cb.transport, {
    setPermissionMode: async () => {},
    stop: async () => {},
  });
  Object.assign(e.context, {
    agents: [{ id: e.b.agentId, enabled: true, name: 'mock', transport: 'stdio' }],
    app: { getPath: () => '/mock' },
    __dirname: '/mock',
    join,
    process,
    transportSessions: new WeakMap(),
    PROMPT_IDLE_MS: 60_000,
    MAX_CONCURRENT_SESSIONS,
    BrowserMcpHost: class {
      start = async () => ({});
      stop = async () => {};
    },
    processManager: {
      approve: (launch: object) => launch,
      connect: async (
        _launch: object,
        options: { session: { requestPermission: typeof permission } },
      ) => {
        permission = options.session.requestPermission;
        return transport;
      },
    },
    adaptersPath: () => '/mock',
    resolveLocalLaunch: async () => ({}),
    disconnectAgent: async (id: string) => {
      const conn = e.context.sessions.get(id);
      if (conn) e.api.detachAgent(conn);
      e.context.sessions.delete(id);
    },
  });
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'connectAgent',
  )!;
  runInNewContext(
    ts.transpileModule(fn.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    e.context,
  );
  const connect = (
    e.context as typeof e.context & {
      connectAgent(id: string, conversationId: string): Promise<void>;
    }
  ).connectAgent;
  await connect(e.b.agentId!, e.b.id);
  const pending = permission({
    sessionId: transport.sessionId,
    options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow once' }],
    toolCall: { toolCallId: 'mock', title: 'mock' },
  });
  await Promise.resolve();
  expect(e.context.approvals.size).toBe(1);
  const approval = [...e.context.approvals.values()][0];
  expect(approval.conversationId).toBe(e.b.id);
  e.approve(approval);
  await expect(pending).resolves.toMatchObject({
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
  expect(e.context.connection).toBe(e.ca);
});

it('ACP approval cannot authorize an attachment that expired while it was pending', async () => {
  const e = runtime();
  e.b.permissionMode = 'ask';
  const pending = e.api.requestAgentPermission(
    {
      sessionId: e.cb.transport.sessionId,
      options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow once' }],
      toolCall: { toolCallId: 'mock', title: 'mock' },
    },
    e.cb,
  );
  const approval = await approvalReady(e.context);
  e.store.transitionAttachment(e.cb.attachmentId!, 'expired');
  e.approve(approval);
  await expect(pending).resolves.toMatchObject({ outcome: { outcome: 'cancelled' } });
});

it('G2-4: skill approval cannot use the foreground task cache', async () => {
  const e = runtime();
  e.b.permissionMode = 'ask';
  e.tab('tab-b', e.cb.principal);
  e.context.sessionRuntimes.setAgentTab(e.b.id, 'tab-b');
  e.context.approvedSkills.set(e.a.task!.id, new Set(['skill-hash']));
  const pending = e.api.executeTool(
    e.request('browser.skills.play', { skillId: 'mock' }),
    e.actor(e.cb),
  );
  const approval = await approvalReady(e.context);
  expect(approval.conversationId).toBe(e.b.id);
  e.context.workspace.data.activeConversationId = e.b.id;
  e.approve(approval);
  await pending;
  expect(e.context.approvedSkills.get(e.b.task!.id)).toBeUndefined();
});

it('a skill authorization is cached only for its original attachment and task', async () => {
  const e = runtime();
  e.tab('tab-b', e.cb.principal);
  e.context.sessionRuntimes.setAgentTab(e.b.id, 'tab-b');
  const actor = e.actor(e.cb);
  const req = () => e.request('browser.skills.play', { skillId: 'mock' });
  const first = e.api.executeTool(req(), actor);
  e.approve(await approvalReady(e.context));
  await first;
  e.context.agentReplayStarting = false;
  await e.api.executeTool(req(), actor);
  expect(e.context.approvals.size).toBe(0);
  e.context.agentReplayStarting = false;
  e.api.detachAgent(e.cb);
  e.api.attachAgent(e.cb);
  e.context.sessionRuntimes.begin(e.b.id, e.cb.principal, e.cb.config.id);
  e.context.sessionRuntimes.setAgentTab(e.b.id, 'tab-b');
  const next = e.api.executeTool(req(), e.actor(e.cb)).then(
    () => 'played',
    () => 'rejected',
  );
  await approvalReady(e.context);
  e.api.detachAgent(e.cb);
  expect(await next).toBe('rejected');
});

it('a task change during skill approval cannot populate another task cache', async () => {
  const e = runtime();
  e.tab('tab-b', e.cb.principal);
  e.context.sessionRuntimes.setAgentTab(e.b.id, 'tab-b');
  const pending = e.api
    .executeTool(
      e.request('browser.skills.play', {
        skillId: 'mock',
      }),
      e.actor(e.cb),
    )
    .then(
      () => 'played',
      () => 'rejected',
    );
  const approval = await approvalReady(e.context);
  e.b.task = { ...e.b.task!, id: 'replacement' };
  e.approve(approval);
  expect(await pending).toBe('rejected');
  expect(e.context.approvedSkills.size).toBe(0);
  expect(e.context.playSkillForAgent).not.toHaveBeenCalled();
});

it('G2-5: B lease expiration revokes only B and cannot expire a replacement attachment', () => {
  const e = runtime();
  e.tab('tab-a', e.ca.principal);
  e.tab('tab-b', e.cb.principal);
  const attachmentA = e.ca.attachmentId,
    lease = e.cb.attachmentLease!;
  lease.options.expire();
  expect(e.cb.attachmentId).toBeUndefined();
  expect(e.ca.attachmentId).toBe(attachmentA);
  expect(e.browser.registry.listFor(e.cb.principal)).toHaveLength(0);
  expect(() => e.api.attachAgent(e.ca)).not.toThrow();
  e.api.attachAgent(e.cb);
  const replacement = e.cb.attachmentId;
  lease.options.expire();
  expect(e.cb.attachmentId).toBe(replacement);
});

it('G2-6: detaching A leaves B browser approval pending', async () => {
  const e = runtime();
  e.b.permissionMode = 'ask';
  e.tab('tab-b', e.cb.principal);
  const actor = e.actor(e.cb);
  const observed = (await e.api.executeTool(
    e.request('browser.observe', { tabId: 'tab-b' }),
    actor,
  )) as Observation;
  const pending = e.api
    .executeTool(
      e.request('browser.type', {
        tabId: 'tab-b',
        elementRef: observed.elements[0].ref,
        text: 'mock',
      }),
      actor,
    )
    .then(
      () => 'succeeded',
      () => 'cancelled',
    );
  const approval = await approvalReady(e.context);
  expect(approval.view.externalClientName).toBeUndefined();
  e.api.detachAgent(e.ca);
  const stillPending = e.context.approvals.has(approval.view.approvalId);
  if (stillPending) e.approve(approval);
  const result = await pending;
  expect(stillPending).toBe(true);
  expect(result).toBe('succeeded');
});

it('an explicit background task never consults or appends to the active conversation', async () => {
  const e = runtime();
  const before = JSON.stringify(e.a);
  e.context.connection = undefined;
  Object.defineProperty(e.context.workspace, 'current', {
    get() {
      throw new Error('foreground conversation read');
    },
  });
  e.context.workspace.append.mockImplementation(() => {
    throw new Error('foreground append');
  });
  e.cb.promptCancelled = false;
  e.context.connectionBusy = true;
  await expect(
    e.api.executeAgentTask({ text: 'background prompt' }, false, e.cb),
  ).resolves.toMatchObject({ stopReason: 'end_turn' });
  expect(JSON.stringify(e.a)).toBe(before);
  expect(e.b.messages).toContainEqual(
    expect.objectContaining({ role: 'user', text: 'background prompt' }),
  );
  expect(e.context.agentStatus).toBe('ready');
  expect(e.context.pageFactory.pointer.hide).not.toHaveBeenCalled();
});

it.each([
  contracts.IPC.agentAttach,
  contracts.IPC.agentDetach,
  contracts.IPC.agentTask,
  contracts.IPC.agentCancel,
  contracts.IPC.agentTakeOver,
  contracts.IPC.agentResume,
])(
  'UI %s rejects a supplied stale conversation without mutating the current one',
  async (channel) => {
    const e = runtime();
    e.a.task!.status = 'manual';
    const before = JSON.stringify(e.a),
      attachment = e.ca.attachmentId;
    Object.assign(e.context, { executeAgentTask: vi.fn(async () => ({ stopReason: 'end_turn' })) });
    const input =
      channel === contracts.IPC.agentTask || channel === contracts.IPC.agentResume
        ? { conversationId: e.b.id, text: 'stale' }
        : { conversationId: e.b.id };
    await expect(ipc(e)(channel, input)).rejects.toThrow(/对话.*变化/);
    expect(JSON.stringify(e.a)).toBe(before);
    expect(e.ca.attachmentId).toBe(attachment);
  },
);

it.each([
  contracts.IPC.agentAttach,
  contracts.IPC.agentDetach,
  contracts.IPC.agentCancel,
  contracts.IPC.agentTakeOver,
  contracts.IPC.agentResume,
])('legacy no-argument %s still routes only to the active conversation', async (channel) => {
  const e = runtime();
  const attachmentB = e.cb.attachmentId;
  if (channel === contracts.IPC.agentResume) {
    e.a.task!.status = 'manual';
    e.api.detachAgent(e.ca);
  }
  Object.assign(e.context, { executeAgentTask: vi.fn(async () => ({ stopReason: 'end_turn' })) });
  await expect(ipc(e)(channel)).resolves.not.toThrow();
  expect(e.cb.attachmentId).toBe(attachmentB);
  expect(e.b.task?.status).toBe('running');
});

it('resume rechecks its captured UI conversation after awaiting reconnect', async () => {
  const e = runtime(),
    gate = deferred(),
    started = deferred();
  e.a.task!.status = 'manual';
  e.context.agentStatus = 'disconnected';
  e.ca.transport.state = 'closed';
  const send = vi.fn(async () => ({ stopReason: 'end_turn' }));
  Object.assign(e.context, {
    executeAgentTask: send,
    connectAgent: async () => {
      started.resolve();
      await gate.promise;
    },
  });
  const pending = ipc(e)(contracts.IPC.agentResume, {
    conversationId: e.a.id,
    text: 'continue',
  }).then(
    () => 'sent',
    () => 'stale',
  );
  await started.promise;
  e.context.workspace.data.activeConversationId = e.b.id;
  e.context.connection = e.cb;
  gate.resolve();
  expect(await pending).toBe('stale');
  expect(send).not.toHaveBeenCalled();
  expect(e.a.task?.status).toBe('manual');
  expect(e.b.task?.status).toBe('running');
});

it('late prompt completion cannot settle a replacement task or its messages', async () => {
  const e = runtime(),
    gate = deferred<{ stopReason: string }>(),
    started = deferred();
  e.cb.transport.prompt = async () => {
    started.resolve();
    return gate.promise;
  };
  const pending = e.api.executeAgentTask({ text: 'old task' }, false, e.cb);
  await started.promise;
  e.b.task = { ...e.b.task!, id: 'replacement', status: 'running' };
  e.b.messages.push({
    id: 'replacement-message',
    role: 'assistant',
    text: 'new turn',
    status: 'running',
    time: '',
  });
  gate.resolve({ stopReason: 'end_turn' });
  await pending;
  expect(e.b.task.status).toBe('running');
  expect(e.b.messages.find((message) => message.id === 'replacement-message')?.status).toBe(
    'running',
  );
});

it('callbacks from a replaced connection cannot mutate its conversation', () => {
  const e = runtime();
  e.context.sessions.set(e.b.id, { ...e.cb, sessionId: 'replacement' });
  const before = JSON.stringify(e.b);
  e.api.handleSessionUpdate(e.cb, {
    sessionId: e.cb.transport.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
  });
  e.b.task!.executionMode = 'goal';
  const goalBefore = JSON.stringify(e.b);
  e.api.handleGoalUpdate(e.cb, { status: 'completed' });
  expect(e.b.messages).toHaveLength(0);
  expect(JSON.stringify({ ...e.b, task: { ...e.b.task, executionMode: undefined } })).toBe(before);
  expect(JSON.stringify(e.b)).toBe(goalBefore);
});

it.each(['replay', 'distillation', 'agent-replay'])(
  'bound MCP actors cannot bypass the %s lock',
  async (lock) => {
    const e = runtime();
    Object.assign(e.context, { runTool: async () => ({ ok: true }) });
    e.tab('tab-b', e.cb.principal);
    if (lock === 'replay') e.context.replayRunning = () => true;
    if (lock === 'distillation') e.context.distillation.running = true;
    if (lock === 'agent-replay')
      e.context.agentReplay = {
        sessionId: e.cb.sessionId,
        attachmentId: e.cb.attachmentId!,
        abort: new AbortController(),
      };
    await expect(
      e.api.executeTool(e.request('browser.observe', { tabId: 'tab-b' }), e.actor(e.cb)),
    ).rejects.toThrow(/回放|提炼/);
  },
);

it('only the active Agent replay actor can use the internal replay-step marker', async () => {
  const e = runtime();
  e.tab('tab-b', e.cb.principal);
  e.context.agentReplay = {
    sessionId: e.cb.sessionId,
    attachmentId: e.cb.attachmentId!,
    abort: new AbortController(),
  };
  const step = { ...e.actor(e.cb), replayApproval: 'approved-earlier' };
  await expect(
    e.api.executeTool(e.request('browser.observe', { tabId: 'tab-b' }), step),
  ).resolves.toMatchObject({ tabId: 'tab-b' });
  await expect(
    e.api.executeTool(e.request('browser.observe', { tabId: 'tab-b' }), {
      ...e.actor(e.ca),
      replayApproval: 'approved-earlier',
    }),
  ).rejects.toThrow(/回放/);
});

it('detaching B cannot abort the foreground A skill replay', async () => {
  const e = runtime();
  const abort = new AbortController();
  e.context.agentReplay = { sessionId: e.ca.sessionId, attachmentId: e.ca.attachmentId!, abort };
  await e.api.interruptAgent('manual', undefined, e.b.id);
  expect(abort.signal.aborted).toBe(false);
});

it('local-user replay targets the visible human page, not the old Agent working tab', () => {
  const e = runtime();
  e.context.activeTabId = 'human-page';
  e.context.sessionRuntimes.setAgentTab(e.a.id, 'old-agent-page');
  expect(
    e.api.targetTab(e.request('browser.click'), {
      ...e.actor(e.ca),
      principal: 'local-user',
      sessionId: 'local-replay',
    }),
  ).toBe('human-page');
});

it('HUMAN skill playback pauses the actor conversation and writes its cursor only there', async () => {
  const e = runtime();
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'playSkillForAgent',
  )!;
  Object.assign(e.context, {
    playSteps: async () => ({ ok: false, reason: 'HUMAN', at: 1, humanReason: 'mock pause' }),
    AGENT_REPLAY_BUDGET_MS: 80_000,
  });
  runInNewContext(
    ts.transpileModule(fn.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    e.context,
  );
  const before = JSON.stringify(e.a);
  await e.context.playSkillForAgent(
    'mock',
    { skill: { meta: { name: 'mock' }, steps: [{}, {}] }, fromStep: 1 },
    e.actor(e.cb),
  );
  expect(JSON.stringify(e.a)).toBe(before);
  expect(e.b.task?.status).toBe('manual');
  expect(e.b.task?.replayCursor).toMatchObject({ skillId: 'mock', nextStep: 2 });
});

it('a scheduled actor cannot reach schedule tools while the UI shows a normal conversation', async () => {
  const e = runtime();
  e.b.origin = 'scheduled';
  await expect(
    e.api.executeTool(e.request('browser.schedule.list'), e.actor(e.cb)),
  ).rejects.toThrow(/定时任务/);
});

const scheduleInput = {
  name: 'Mock schedule',
  agentId: 'mock',
  prompt: 'mock prompt',
  rule: { kind: 'interval', every: 60, unit: 'minute' },
  permissionMode: 'full',
};

it('schedule approval keeps its original actor source across a UI switch', async () => {
  const e = runtime();
  e.context.workspace.data.conversations.push({ ...e.a, id: 'c', messages: [] });
  const pending = e.api.executeTool(
    e.request('browser.schedule.create', scheduleInput),
    e.actor(e.cb),
  );
  const approval = await approvalReady(e.context);
  e.context.workspace.data.activeConversationId = 'c';
  e.approve(approval);
  await pending;
  expect(e.context.createSchedule).toHaveBeenCalledWith(
    expect.objectContaining({ permissionMode: 'ask' }),
    { kind: 'agent', conversationId: e.b.id },
  );
});

it('detachment while schedule approval is pending cannot create a schedule', async () => {
  const e = runtime();
  const pending = e.api
    .executeTool(e.request('browser.schedule.create', scheduleInput), e.actor(e.cb))
    .then(
      () => 'created',
      () => 'rejected',
    );
  const approval = await approvalReady(e.context);
  e.api.detachAgent(e.cb);
  if (e.context.approvals.has(approval.view.approvalId)) e.approve(approval);
  expect(await pending).toBe('rejected');
  expect(e.context.createSchedule).not.toHaveBeenCalled();
});

it.each([true, false])(
  'external ask approval has no unrelated conversation binding (no UI: %s)',
  async (noUi) => {
    const e = runtime();
    if (noUi) e.context.workspace.data.activeConversationId = '';
    const external: Actor = {
      principal: 'external:client',
      sessionId: randomUUID(),
      attachmentId: randomUUID(),
      connectionEpoch: 1,
      capabilitySnapshotHash: 'external-capability',
    };
    e.store.createSession({ ...external, profileId: 'profile', agentId: external.principal });
    e.store.createAttachment({
      ...external,
      agentId: external.principal,
      role: 'owner',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    e.context.externalAttachments.set(external.attachmentId, external);
    e.tab('external', external.principal);
    const observed = (await e.api.executeTool(
      e.request('browser.observe', { tabId: 'external' }),
      external,
    )) as Observation;
    const pending = e.api.executeTool(
      e.request('browser.type', {
        tabId: 'external',
        elementRef: observed.elements[0].ref,
        text: 'mock',
      }),
      external,
    );
    const approval = await approvalReady(e.context);
    expect(approval.conversationId).toBeUndefined();
    expect(approval.view.externalClientName).toBe('Trusted External Client');
    e.approve(approval);
    await pending;
  },
);

it('detachment during screenshot capture blocks delivery of the old attachment result', async () => {
  const e = runtime(),
    gate = deferred<{ mimeType: 'image/png'; data: string }>(),
    started = deferred();
  e.tab('tab-b', e.cb.principal, {
    screenshot: async () => {
      started.resolve();
      return gate.promise;
    },
  });
  const pending = e.api
    .executeTool(e.request('browser.screenshot', { tabId: 'tab-b' }), e.actor(e.cb))
    .then(
      () => 'delivered',
      () => 'rejected',
    );
  await started.promise;
  e.api.detachAgent(e.cb);
  e.api.attachAgent(e.cb);
  gate.resolve({ mimeType: 'image/png', data: 'old result' });
  expect(await pending).toBe('rejected');
});
