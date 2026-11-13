import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { focusedAgentStatus } from '../src/main/agents/conversation-link';

// 主进程里「哪条连接在跑这一回合」的几段判断：抽出 main.ts 的真实函数，在 vm 里配上最小的全局跑。
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function load<T>(names: string[], context: Record<string, unknown>): T {
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  return runInNewContext(
    ts.transpileModule(
      `${functions.map((fn) => fn.getText(source)).join('\n')}\n({${names.join(', ')}})`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  ) as T;
}

interface Conv {
  id: string;
  agentId?: string;
  title?: string;
  task?: { status: string };
  messages: Array<{ role: string; text: string; status: string }>;
}

function workspaceOf(conversations: Conv[], activeConversationId: string) {
  const data = { conversations, activeConversationId };
  return {
    data,
    get current() {
      return data.conversations.find((conv) => conv.id === data.activeConversationId);
    },
    create(id: string, agentId: string) {
      const conv: Conv = { id, agentId, messages: [] };
      data.conversations.push(conv);
      data.activeConversationId = id;
      return conv;
    },
    append(message: Conv['messages'][number]) {
      this.current!.messages.push(message);
    },
  };
}

function conn(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    conversationId,
    config: { id: 'agent' },
    transport: { state: 'ready', prompt: vi.fn(), capabilities: {} },
    attachmentId: `att-${conversationId}`,
    agentTabId: undefined as string | undefined,
    promptActive: false,
    promptCancelled: false,
    toolExecutions: 0,
    ...extra,
  };
}

// ---- 蒙层：按连接各自判断 ----

function shield() {
  const a = conn('a');
  const b = conn('b', { agentTabId: 'tb', promptActive: true });
  const conversations: Conv[] = [
    { id: 'a', messages: [] },
    { id: 'b', messages: [] },
  ];
  const context: Record<string, unknown> = {
    sessions: new Map([
      ['a', a],
      ['b', b],
    ]),
    connection: b,
    agentStatus: 'running',
    activeTabId: 'tb',
    replay: undefined,
    workspace: workspaceOf(conversations, 'b'),
    externalAgentTabs: () => [],
  };
  const api = load<{ agentOperatingActiveTab(): boolean; isAgentBrowserActive(): boolean }>(
    [
      'agentOperatingActiveTab',
      'isAgentBrowserActive',
      'connectionDrivingBrowser',
      'isLiveConnection',
      'taskRunning',
      'activeConn',
      'conversationById',
      'replayRunning',
    ],
    context,
  );
  const focus = (target: typeof a) => {
    context.connection = target;
    (context.workspace as ReturnType<typeof workspaceOf>).data.activeConversationId =
      target.conversationId;
    context.agentStatus = target.promptActive ? 'running' : 'ready';
  };
  return { api, context, a, b, conversations, focus };
}

it('another conversation that stopped a task earlier does not drop the shield of the one driving this page', () => {
  const s = shield();
  // A 停过一次任务，取消标记留在它自己的连接上；B 正在当前页上干活。
  s.a.promptCancelled = true;
  expect(s.api.agentOperatingActiveTab()).toBe(true);
  expect(s.api.isAgentBrowserActive()).toBe(true);
});

it('switching the panel to an idle conversation keeps the shield over the page another Agent is driving', () => {
  const s = shield();
  s.focus(s.a);
  expect(s.api.agentOperatingActiveTab()).toBe(true);
  // 状态栏的「Agent 正在…」跟着界面焦点：A 闲着就不说它在操作。
  expect(s.api.isAgentBrowserActive()).toBe(false);
});

it('a goal task between prompts or tools still in flight keep the shield up', () => {
  const s = shield();
  s.focus(s.a);
  s.b.promptActive = false;
  expect(s.api.agentOperatingActiveTab()).toBe(false);
  s.conversations[1].task = { status: 'running' };
  expect(s.api.agentOperatingActiveTab()).toBe(true);
  s.conversations[1].task = undefined;
  s.b.toolExecutions = 1;
  expect(s.api.agentOperatingActiveTab()).toBe(true);
});

it.each([
  [
    'the driving conversation was cancelled',
    (s: ReturnType<typeof shield>) => {
      s.b.promptCancelled = true;
    },
  ],
  [
    'the driving conversation is detached',
    (s: ReturnType<typeof shield>) => {
      s.b.attachmentId = undefined as unknown as string;
    },
  ],
  [
    'the driving conversation works on another tab',
    (s: ReturnType<typeof shield>) => {
      s.b.agentTabId = 'other';
    },
  ],
  [
    'the driving transport is no longer ready',
    (s: ReturnType<typeof shield>) => {
      s.b.transport.state = 'closed';
    },
  ],
  [
    'the connection is no longer the one registered for its conversation',
    (s: ReturnType<typeof shield>) => {
      (s.context.sessions as Map<string, unknown>).set('b', conn('b'));
    },
  ],
] as const)('no shield when %s', (_case, arrange) => {
  const s = shield();
  arrange(s);
  expect(s.api.agentOperatingActiveTab()).toBe(false);
});

// ---- 提炼：回合标记记在真正跑这一回合的连接上 ----

function distill(connect: (context: Record<string, unknown>) => Promise<void>) {
  const connA = conn('a');
  const workspace = workspaceOf([{ id: 'a', agentId: 'agent', messages: [] }], 'a');
  const distillation = {
    active: undefined,
    claim: vi.fn(),
    begin: vi.fn(),
    release: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
  };
  let seen: { cancelled(): boolean } | undefined;
  const during: Record<string, boolean | string | null> = {};
  let uuid = 0;
  const context: Record<string, unknown> = {
    sessions: new Map([['a', connA]]),
    connectAttempts: new Map(),
    connection: connA,
    agentStatus: 'ready',
    lastError: undefined,
    connectionBusy: false,
    replay: undefined,
    workspace,
    distillation,
    recordingSession: { isRecording: () => false },
    library: {
      read: async () => ({ trajectory: { meta: { name: '录制一' } }, markdown: '' }),
      readEvents: async () => undefined,
    },
    buildDistillPrompt: () => 'prompt',
    renderEvents: () => '',
    randomUUID: () => `id-${++uuid}`,
    focusedAgentStatus,
    log: vi.fn(),
    emit: vi.fn(),
    readable: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    requireAttachment: () => {
      const target = context.connection as ReturnType<typeof conn> | undefined;
      if (!target?.attachmentId) throw new Error('Agent 尚未附加到浏览器会话');
      return target;
    },
    connectAgent: () => connect(context),
    runPrompt: async (_contents: unknown, options: { cancelled(): boolean }) => {
      seen = options;
      const live = context.connection as ReturnType<typeof conn>;
      during.livePromptActive = live.promptActive;
      during.liveTaskId = (live as { taskId?: string }).taskId ?? null;
      during.previousPromptActive = connA.promptActive;
      during.cancelledBefore = options.cancelled();
      // 人在提炼对话里点了停止：标记落在提炼对话自己的连接上。
      live.promptCancelled = true;
      during.cancelledAfter = options.cancelled();
      return { stopReason: 'end_turn' };
    },
  };
  const api = load<{ startDistillation(id: string): Promise<void> }>(
    ['startDistillation', 'focusActiveConversation', 'liveState', 'taskRunning', 'replayRunning'],
    context,
  );
  return { api, context, connA, distillation, during, seen: () => seen };
}

it('a first distillation runs its turn on the new conversation connection, not the previous one', async () => {
  let connB: ReturnType<typeof conn> | undefined;
  const d = distill(async (context) => {
    const id = (context.workspace as ReturnType<typeof workspaceOf>).data.activeConversationId;
    connB = conn(id);
    (context.sessions as Map<string, unknown>).set(id, connB);
    context.connection = connB;
  });
  await d.api.startDistillation('rec-1');
  expect(connB).toBeDefined();
  expect(d.during).toEqual({
    livePromptActive: true,
    // 提炼对话没有 task：连接上不能带 taskId，否则这一回合的回复会被当成别的任务的迟到消息丢掉。
    liveTaskId: null,
    previousPromptActive: false,
    cancelledBefore: false,
    cancelledAfter: true,
  });
  // 停止落在提炼对话上，半截回合不当成品。
  expect(d.distillation.reject).toHaveBeenCalledWith(expect.objectContaining({ reason: '已取消' }));
  expect(d.distillation.accept).not.toHaveBeenCalled();
  expect(connB!.promptActive).toBe(false);
  expect(d.connA.promptActive).toBe(false);
  expect(d.connA.promptCancelled).toBe(false);
});

it('a distillation conversation that fails to connect does not keep the previous conversation connection', async () => {
  const d = distill(async (context) => {
    const id = (context.workspace as ReturnType<typeof workspaceOf>).data.activeConversationId;
    // connectAgent 在建出连接之前失败：它只记下失败，不碰「当前连接」。
    (context.connectAttempts as Map<string, unknown>).set(id, {
      phase: 'failed',
      error: '启动失败',
    });
    context.agentStatus = 'error';
    throw new Error('启动失败');
  });
  await expect(d.api.startDistillation('rec-1')).rejects.toThrow('启动失败');
  expect(d.context.connection).toBeUndefined();
  expect(d.context.agentStatus).toBe('error');
  expect(d.context.connectionBusy).toBe(false);
  expect(d.distillation.release).toHaveBeenCalledOnce();
  expect(d.connA.promptActive).toBe(false);
});

// ---- 回放：收尾出错也要收尾 ----

it('a replay whose final record fails still releases its actor and settles', async () => {
  const release = vi.fn();
  const active = {
    id: 'skill-1',
    steps: [{}],
    actor: { tabId: 't1', release },
    abort: new AbortController(),
    state: { id: 'skill-1', name: '技能一', step: 1, total: 1, status: 'running' } as {
      id: string;
      name: string;
      step: number;
      total: number;
      status: string;
      message?: string;
    },
  };
  const context: Record<string, unknown> = {
    replay: active,
    lastError: undefined,
    playSteps: async () => ({ ok: true, steps: 1 }),
    store: {
      recordEvent: () => {
        throw new Error('database is locked');
      },
    },
    log: vi.fn(),
    emit: vi.fn(),
    readable: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
  const api = load<{ runReplay(active: unknown, fromStep: number): Promise<void> }>(
    ['runReplay'],
    context,
  );
  await expect(api.runReplay(active, 1)).resolves.toBeUndefined();
  expect(active.state.status).toBe('done');
  expect(release).toHaveBeenCalledOnce();
  expect(context.emit).toHaveBeenCalled();
  expect(context.lastError).toBe('回放记录失败：database is locked');
});
