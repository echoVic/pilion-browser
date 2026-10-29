import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MAX_CONCURRENT_SESSIONS,
  SessionRuntimeRegistry,
} from '../src/main/agents/session-runtime';
import { BrowserService } from '../src/main/browser/browser-service';
import { DurableHostStore, sha256 } from '../src/main/host/index';
import type { Conversation, ConversationMessage } from '../src/shared/contracts';
import type { ScheduledPromptRunInput, ScheduledPromptRunner } from '../src/main/schedule/runner';

const source = ts.createSourceFile(
  'main.ts',
  process.env.PILION_RUNTIME_LIFECYCLE_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:src/main/main.ts'], { encoding: 'utf8' })
    : readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  'conversationById',
  'conversationPermissionMode',
  'connBySessionId',
  'isLiveConnection',
  'requireLiveActor',
  'requireAttachment',
  'requireActiveConversationId',
  'activeConn',
  'taskRunning',
  'grantAgentTabAcl',
  'revokeAgentAcls',
  'attachAgent',
  'detachAgent',
  'connectAgent',
  'disconnectAgent',
  'failConnection',
  'expireAttachment',
  'interruptAgent',
  'handleGoalUpdate',
  'pauseForHuman',
  'executeAgentTask',
];
function initializer(name: string): string {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (item) => item.name.getText(source) === name,
    );
    if (declaration?.initializer) return declaration.initializer.getText(source);
  }
  throw new Error(`Missing production initializer: ${name}`);
}
const js = ts.transpileModule(
  [
    ...names.map((name) => {
      const node = source.statements.find(
        (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
      );
      if (!node) throw new Error(`Missing production function: ${name}`);
      return node.getText(source);
    }),
    `const sessionRuntimes = ${initializer('sessionRuntimes')};`,
    `const scheduledRunner = ${initializer('scheduledRunner')};`,
    `globalThis.api = { ${names.join(',')}, sessionRuntimes, scheduledRunner };`,
  ].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

type PromptResult = { stopReason: 'end_turn' | 'cancelled' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
class Transport extends EventEmitter {
  state = 'ready';
  sessionId = randomUUID();
  capabilities = { agent: {}, protocol: 1 };
  traceSnapshot: object[] = [];
  supportsPersistentGoals = false;
  goal: { status: string } | null = null;
  setPermissionMode = vi.fn(async () => {});
  setGoal = vi.fn<(_text: string) => Promise<void>>(async () => {
    this.goal = { status: 'active' };
  });
  clearGoal = vi.fn(async () => {
    this.goal = null;
  });
  cancel = vi.fn(async () => {});
  prompt = vi.fn<(_contents: object[]) => Promise<PromptResult>>(async () => ({
    stopReason: 'end_turn',
  }));
  stop = vi.fn(async () => {
    this.state = 'closed';
    this.emit('state', { current: 'closed' });
  });
}
class Lease {
  constructor(readonly options: { expire(): void }) {}
  stop = vi.fn();
  activity = vi.fn();
  beginActivity = () => () => {};
}
type Conn = {
  conversationId: string;
  principal: string;
  config: { id: string };
  transport: Transport;
  mcpHost: { stop(): Promise<void> };
  sessionId: string;
  attachmentId?: string;
  attachmentLease?: Lease;
  taskId?: string;
  agentTabId?: string;
  promptActive: boolean;
  promptCancelled: boolean;
};
type Api = {
  sessionRuntimes: SessionRuntimeRegistry;
  scheduledRunner: ScheduledPromptRunner;
  connectAgent(agentId: string, conversationId: string): Promise<void>;
  disconnectAgent(conversationId: string): Promise<void>;
  failConnection(conn: Conn, error: Error): Promise<void>;
  expireAttachment(conn: Conn, attachmentId: string): void;
  attachAgent(conn: Conn): void;
  detachAgent(conn: Conn): void;
  interruptAgent(
    mode: 'manual' | 'stopped',
    note: undefined,
    conversationId: string,
  ): Promise<void>;
  pauseForHuman(conn: Conn, reason?: string): void;
  handleGoalUpdate(conn: Conn, goal: { status: string } | null): void;
  executeAgentTask(input: { text: string }, resuming: boolean, conn: Conn): Promise<PromptResult>;
};
const stores: DurableHostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function harness() {
  const store = new DurableHostStore({ path: ':memory:' });
  stores.push(store);
  const conversations: Conversation[] = ['a', 'b'].map((id) => ({
    id,
    title: id,
    agentId: 'mock',
    permissionMode: 'ask',
    updatedAt: '',
    messages: [],
  }));
  const workspace = {
    data: { conversations, activeConversationId: 'b', permissionMode: 'ask' },
    get current() {
      return conversations.find((item) => item.id === this.data.activeConversationId);
    },
  };
  const transports: Transport[] = [];
  const timers: { callback(): void; delay: number }[] = [];
  const browser = new BrowserService({
    pageFactory: {
      create: async () => {
        throw new Error('No real pages in lifecycle tests');
      },
    },
    grantVerifier: {
      verify: async () => {
        throw new Error('No effects in lifecycle tests');
      },
    },
    authorizePrincipal: () => {},
    resolver: { resolve: async () => ['93.184.216.34'] },
  });
  class McpHost {
    socketPath = '/mock/socket';
    start = vi.fn(async () => ({}));
    stop = vi.fn(async () => {});
  }
  const context = {
    randomUUID,
    sha256,
    Buffer,
    Date,
    join,
    process,
    __dirname: '/mock',
    store,
    workspace,
    browser,
    SessionRuntimeRegistry,
    MAX_CONCURRENT_SESSIONS,
    USER_PRINCIPAL: 'local-user',
    PROFILE_ID: 'profile',
    ATTACHMENT_IDLE_MS: 3_600_000,
    PROMPT_IDLE_MS: 300_000,
    AttachmentLease: Lease,
    BrowserMcpHost: McpHost,
    app: { getPath: () => '/mock' },
    agents: [{ id: 'mock', name: 'Mock', enabled: true }],
    adaptersPath: () => '/mock/adapters',
    resolveLocalLaunch: async () => ({}),
    processManager: {
      approve: (launch: object) => launch,
      connect: vi.fn(async () => {
        const transport = new Transport();
        transports.push(transport);
        return transport;
      }),
    },
    sessions: new Map<string, Conn>(),
    transportSessions: new WeakMap(),
    externalAttachments: new Map(),
    agentOwnedTabs: new Map(),
    pages: new Map(),
    connection: undefined as Conn | undefined,
    connectionBusy: false,
    agentStatus: 'ready',
    lastError: undefined,
    activeTabId: undefined,
    pageFactory: { pointer: { hide: vi.fn() } },
    recordingSession: { isRecording: () => false },
    replayRunning: () => false,
    agentReplay: undefined,
    freshSessionNotice: new Set(),
    scheduledRunIds: new Set(),
    scheduledUnattendedDenials: new Set<string>(),
    skillProposals: { capture: vi.fn() },
    AgentEmptyResponseError: class extends Error {},
    isEmptyAgentReply: (text: string) => !text.trim(),
    promptContents: (text: string) => [{ type: 'text', text }],
    runPrompt: async (
      contents: object[],
      options: { prompt(contents: object[]): Promise<PromptResult> },
    ) => options.prompt(contents),
    executeTool: vi.fn(),
    requestAgentPermission: vi.fn(),
    handleSessionUpdate: vi.fn(),
    cancelBrowserApprovals: vi.fn(),
    cancelAcpApprovals: vi.fn(),
    currentPageUrl: () => 'https://example.com/',
    handoverBaseline: undefined,
    requestAttention: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    flushBroadcast: vi.fn(),
    readable: (error: Error) => error.message,
    setTimeout(callback: () => void, delay: number) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout() {},
  };
  runInNewContext(js, context);
  const api = (context as typeof context & { api: Api }).api;
  async function connect(id: string) {
    await api.connectAgent('mock', id);
    return context.sessions.get(id)!;
  }
  function running(conn: Conn, tabId = `tab-${conn.conversationId}`) {
    const conversation = conversations.find((item) => item.id === conn.conversationId)!;
    conversation.task = {
      id: randomUUID(),
      agentId: 'mock',
      goal: 'work',
      status: 'running',
      updatedAt: '',
    };
    conn.taskId = conversation.task.id;
    conn.agentTabId = tabId;
    api.sessionRuntimes.begin(conn.conversationId, conn.principal, 'mock');
    api.sessionRuntimes.setAgentTab(conn.conversationId, tabId);
    return conversation;
  }
  return { api, context, conversations, connect, running, transports, timers };
}
function scheduled(scheduleId = 'schedule'): ScheduledPromptRunInput {
  return {
    conversationTitle: 'Finite scheduled prompt',
    agentId: 'mock',
    prompt: 'Run once',
    scheduleId,
    origin: 'scheduled',
    permissionMode: 'ask',
  };
}

it('registers running work at task start, not at connection admission, and releases completed work', async () => {
  const h = harness();
  const conn = await h.connect('a');
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  const pending = deferred<PromptResult>();
  conn.transport.prompt.mockReturnValueOnce(pending.promise);
  const task = h.api.executeAgentTask({ text: 'Run once' }, false, conn);
  expect(h.api.sessionRuntimes.runningCount()).toBe(1);
  conn.agentTabId = 'work-tab';
  h.api.sessionRuntimes.setAgentTab('a', 'work-tab');
  pending.resolve({ stopReason: 'end_turn' });
  await task;
  expect(h.conversations[0].task?.status).toBe('completed');
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  expect(h.api.sessionRuntimes.agentTab('a')).toBeUndefined();
  expect(conn.agentTabId).toBeUndefined();
  expect(h.context.sessions.size).toBe(1);
});

it('keeps a maximum of four actual connections even when all are idle', async () => {
  const h = harness();
  h.conversations.push(
    ...['c', 'd', 'e'].map((id) => ({
      ...h.conversations[0],
      id,
      messages: [],
    })),
  );
  for (const id of ['a', 'b', 'c', 'd']) await h.connect(id);
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  await expect(h.connect('e')).rejects.toThrow();
  expect(h.context.sessions.size).toBe(MAX_CONCURRENT_SESSIONS);
  await h.api.disconnectAgent('a');
  await h.connect('e');
  expect(h.context.sessions.size).toBe(MAX_CONCURRENT_SESSIONS);
});

it('rechecks connection admission after asynchronous transport setup', async () => {
  const h = harness();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  h.conversations.push(
    ...ids.slice(2).map((id) => ({
      ...h.conversations[0],
      id,
      messages: [],
    })),
  );
  const results = await Promise.allSettled(ids.map((id) => h.connect(id)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
  expect(h.context.sessions.size).toBe(4);
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  expect(h.transports.filter((transport) => transport.state === 'closed')).toHaveLength(2);
});

it.each([
  'disconnect',
  'failure',
  'expiry',
  'closed',
  'detach',
  'manual',
  'stopped',
  'handover',
] as const)(
  '%s clears only the captured runtime and tab pointer, leaving its running sibling intact',
  async (kind) => {
    const h = harness();
    const a = await h.connect('a'),
      b = await h.connect('b');
    h.running(a);
    h.running(b);
    const sibling = { ...h.api.sessionRuntimes.get('b') };
    if (kind === 'disconnect') await h.api.disconnectAgent('a');
    if (kind === 'failure') await h.api.failConnection(a, new Error('Protocol failed'));
    if (kind === 'expiry') h.api.expireAttachment(a, a.attachmentId!);
    if (kind === 'closed') {
      a.transport.state = 'closed';
      a.transport.emit('state', { current: 'closed' });
      await vi.waitFor(() => expect(h.context.sessions.has('a')).toBe(false));
    }
    if (kind === 'detach') h.api.detachAgent(a);
    if (kind === 'manual' || kind === 'stopped') await h.api.interruptAgent(kind, undefined, 'a');
    if (kind === 'handover') h.api.pauseForHuman(a);
    expect(h.api.sessionRuntimes.runningCount()).toBe(1);
    expect(h.api.sessionRuntimes.agentTab('a')).toBeUndefined();
    expect(a.agentTabId).toBeUndefined();
    expect(h.api.sessionRuntimes.get('b')).toEqual(sibling);
    expect(h.context.connection).toBe(b);
    expect(b.agentTabId).toBe('tab-b');
    expect(b.transport.stop).not.toHaveBeenCalled();
  },
);

it('routes a registry interruption to its background conversation', async () => {
  const h = harness();
  const a = await h.connect('a'),
    b = await h.connect('b');
  h.running(a);
  h.running(b);
  h.api.sessionRuntimes.interrupt('a', 'manual');
  await vi.waitFor(() => expect(a.transport.cancel).toHaveBeenCalledOnce());
  expect(h.conversations[0].task?.status).toBe('manual');
  expect(h.api.sessionRuntimes.runningCount()).toBe(1);
  expect(b.transport.cancel).not.toHaveBeenCalled();
});

it('does not clear replacement runtime identity from a stale failure, lease, or prompt finally', async () => {
  const h = harness();
  const old = await h.connect('a');
  const pending = deferred<PromptResult>();
  old.transport.prompt.mockReturnValueOnce(pending.promise);
  const task = h.api.executeAgentTask({ text: 'Old work' }, false, old);
  const oldLease = old.attachmentLease!;
  const replacement = await h.connect('a');
  h.running(replacement, 'replacement-tab');
  const snapshot = { ...h.api.sessionRuntimes.get('a') };
  await h.api.failConnection(old, new Error('Late failure'));
  oldLease.options.expire();
  pending.resolve({ stopReason: 'end_turn' });
  await task;
  expect(h.api.sessionRuntimes.get('a')).toEqual(snapshot);
  expect(h.context.sessions.get('a')).toBe(replacement);
  expect(replacement.agentTabId).toBe('replacement-tab');
});

it('cleans up a connection that fails after registration without touching its sibling', async () => {
  const h = harness();
  const b = await h.connect('b');
  h.running(b);
  const attach = vi.spyOn(h.context.store, 'createAttachment').mockImplementationOnce(() => {
    throw new Error('Attachment setup failed');
  });
  await expect(h.connect('a')).rejects.toThrow('Attachment setup failed');
  attach.mockRestore();
  expect(h.context.sessions.has('a')).toBe(false);
  expect(h.api.sessionRuntimes.runningCount()).toBe(1);
  expect(h.context.connection).toBe(b);
  expect(h.transports[1].stop).toHaveBeenCalledOnce();
});

it('runs six sequential scheduled prompts without historical connections or runtimes blocking capacity', async () => {
  const h = harness();
  for (let index = 0; index < 6; index++) {
    const result = await h.api.scheduledRunner.run(scheduled());
    expect(result.status).toBe('ok');
    expect(h.api.sessionRuntimes.runningCount()).toBe(0);
    expect(h.context.sessions.size).toBe(0);
    expect(h.api.scheduledRunner.isRunning('schedule')).toBe(false);
  }
  expect(h.conversations.filter((item) => item.origin === 'scheduled')).toHaveLength(6);
  expect(h.context.workspace.data.activeConversationId).toBe('b');
  expect(h.transports).toHaveLength(6);
  for (const transport of h.transports) expect(transport.stop).toHaveBeenCalledOnce();
});

it('scheduled goal-capable transport uses prompt and retains overlap and denial accounting until completion', async () => {
  const h = harness();
  const pending = deferred<PromptResult>();
  h.context.processManager.connect.mockImplementationOnce(async () => {
    const transport = new Transport();
    transport.supportsPersistentGoals = true;
    transport.prompt.mockReturnValueOnce(pending.promise);
    h.transports.push(transport);
    return transport;
  });
  const run = h.api.scheduledRunner.run(scheduled());
  await vi.waitFor(() => expect(h.transports[0]?.prompt).toHaveBeenCalledOnce());
  const conversation = h.conversations.find((item) => item.origin === 'scheduled')!;
  expect(conversation.task?.executionMode).toBe('prompt');
  expect(conversation.task?.status).toBe('running');
  expect(h.transports[0].setGoal).not.toHaveBeenCalled();
  expect(h.api.scheduledRunner.isRunning('schedule')).toBe(true);
  expect(h.api.sessionRuntimes.runningCount()).toBe(1);
  expect(await h.api.scheduledRunner.run(scheduled())).toMatchObject({
    status: 'skipped',
    reason: 'overlap',
  });
  h.context.scheduledUnattendedDenials.add(conversation.id);
  pending.resolve({ stopReason: 'end_turn' });
  expect(await run).toMatchObject({ status: 'ok', unattendedDenied: true });
  expect(conversation.task?.status).toBe('completed');
  expect(h.api.scheduledRunner.isRunning('schedule')).toBe(false);
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
});

it('allows four genuinely concurrent scheduled prompts and rejects a fifth until a slot is released', async () => {
  const h = harness();
  const pending = Array.from({ length: 4 }, () => deferred<PromptResult>());
  let index = 0;
  h.context.processManager.connect.mockImplementation(async () => {
    const transport = new Transport();
    transport.prompt.mockReturnValueOnce(pending[index++].promise);
    h.transports.push(transport);
    return transport;
  });
  const runs = Array.from({ length: 4 }, (_, id) =>
    h.api.scheduledRunner.run(scheduled(`schedule-${id}`)),
  );
  await vi.waitFor(() => expect(h.api.sessionRuntimes.runningCount()).toBe(4));
  expect(await h.api.scheduledRunner.run(scheduled('schedule-5'))).toMatchObject({
    status: 'skipped',
    reason: 'capacity',
  });
  for (const prompt of pending) prompt.resolve({ stopReason: 'end_turn' });
  expect((await Promise.all(runs)).map((result) => result.status)).toEqual([
    'ok',
    'ok',
    'ok',
    'ok',
  ]);
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  expect(h.context.sessions.size).toBe(0);
});

it.each(['completed', 'paused', 'blocked', 'limited'] as const)(
  'preserves user persistent goals until a %s goal event and releases their runtime afterwards',
  async (goalStatus) => {
    const h = harness();
    const a = await h.connect('a');
    a.transport.supportsPersistentGoals = true;
    await h.api.executeAgentTask({ text: 'Keep working' }, false, a);
    expect(a.transport.setGoal).toHaveBeenCalledWith('Keep working');
    expect(a.transport.prompt).not.toHaveBeenCalled();
    expect(h.conversations[0].task?.status).toBe('running');
    expect(h.api.sessionRuntimes.runningCount()).toBe(1);
    a.agentTabId = 'goal-tab';
    h.api.sessionRuntimes.setAgentTab('a', 'goal-tab');
    h.api.handleGoalUpdate(a, { status: goalStatus });
    expect(h.conversations[0].task?.status).toBe(
      goalStatus === 'completed' ? 'completed' : 'manual',
    );
    expect(h.api.sessionRuntimes.runningCount()).toBe(0);
    expect(a.agentTabId).toBeUndefined();
  },
);

it.each(['cancelled', 'failed'] as const)(
  'releases scheduled capacity on %s prompt without reporting success',
  async (outcome) => {
    const h = harness();
    h.context.processManager.connect.mockImplementationOnce(async () => {
      const transport = new Transport();
      if (outcome === 'cancelled')
        transport.prompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
      else transport.prompt.mockRejectedValueOnce(new Error('Prompt failed'));
      return transport;
    });
    expect(await h.api.scheduledRunner.run(scheduled())).toMatchObject({ status: 'failed' });
    expect(h.context.sessions.size).toBe(0);
    expect(h.api.sessionRuntimes.runningCount()).toBe(0);
    expect(h.api.scheduledRunner.isRunning('schedule')).toBe(false);
  },
);

it('clears completed and disconnected historical runtime counts in the actual production paths', async () => {
  const h = harness();
  const a = await h.connect('a'),
    b = await h.connect('b');
  h.running(a);
  h.running(b);
  h.conversations[0].messages.push({
    id: 'reply',
    role: 'assistant',
    text: 'Done',
    time: '',
    status: 'running',
  } satisfies ConversationMessage);
  await h.api.executeAgentTask({ text: 'Complete' }, false, a);
  expect(h.api.sessionRuntimes.runningCount()).toBe(1);
  await h.api.disconnectAgent('a');
  await h.api.disconnectAgent('b');
  expect(h.api.sessionRuntimes.runningCount()).toBe(0);
  expect(h.context.sessions.size).toBe(0);
});

it('enforces running capacity when restarting a retained manual registry entry', () => {
  const registry = new SessionRuntimeRegistry({ interrupt() {} });
  registry.begin('manual', 'agent:manual', 'mock');
  registry.interrupt('manual', 'manual');
  for (let index = 0; index < MAX_CONCURRENT_SESSIONS; index++)
    registry.begin(`running-${index}`, `agent:${index}`, 'mock');
  expect(() => registry.begin('manual', 'agent:manual', 'mock')).toThrow();
  expect(registry.runningCount()).toBe(4);
});
