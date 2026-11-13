import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** registerIpc 里单个通道的处理函数原样拿出来，在给定的 vm 上下文里求值。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function handler<T = unknown>(channel: string, context: Record<string, unknown>) {
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      !call &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'handle' &&
      node.arguments[0]?.getText(source) === channel
    )
      call = node;
    if (!call) ts.forEachChild(node, visit);
  };
  visit(source);
  expect(call, channel).toBeDefined();
  return runInNewContext(
    ts.transpileModule(`(${call!.arguments[2]!.getText(source)})`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as (value: T) => Promise<unknown>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('a new conversation leaves the connection guard alone when another change already holds it', async () => {
  const connecting = deferred();
  const context: Record<string, unknown> = {
    connection: { config: { id: 'claude' } },
    workspace: { create: vi.fn() },
    randomUUID: () => 'new-conversation',
    connectionBusy: true,
    connectAgent: vi.fn(() => connecting.promise),
    focusActiveConversation: vi.fn(),
    emit: vi.fn(),
  };
  const create = handler('IPC.conversationNew', context);
  const created = create(undefined);
  connecting.resolve();
  await created;
  expect(context.connectAgent).toHaveBeenCalledWith('claude');
  // 另一条连接变更（断开、切换 Agent）还没做完：不能替它把关放开。
  expect(context.connectionBusy).toBe(true);
});

it('a new conversation holds the guard while it connects and releases the one it took', async () => {
  const connecting = deferred();
  const context: Record<string, unknown> = {
    connection: { config: { id: 'claude' } },
    workspace: { create: vi.fn() },
    randomUUID: () => 'new-conversation',
    connectionBusy: false,
    connectAgent: vi.fn(() => connecting.promise),
    focusActiveConversation: vi.fn(),
    emit: vi.fn(),
  };
  const created = handler('IPC.conversationNew', context)(undefined);
  await vi.waitFor(() => expect(context.connectAgent).toHaveBeenCalled());
  expect(context.connectionBusy).toBe(true);
  connecting.resolve();
  await created;
  expect(context.connectionBusy).toBe(false);
});

it('switching a conversation to an unknown or disabled Agent throws and keeps the old session', async () => {
  const conversation = {
    id: 'c',
    agentId: 'claude',
    agentName: 'Claude',
    acpSessionId: 'resumable',
  };
  const context: Record<string, unknown> = {
    workspace: { data: { conversations: [conversation], activeConversationId: 'c' } },
    agents: [
      { id: 'claude', name: 'Claude', enabled: true },
      { id: 'off', name: 'Off', enabled: false },
      { id: 'codex', name: 'Codex', enabled: true },
    ],
    freshSessionNotice: new Set<string>(),
    connectAgent: vi.fn(async () => {}),
    focusActiveConversation: vi.fn(),
    emit: vi.fn(),
  };
  const use = handler<{ conversationId: string; agentId: string }>(
    'IPC.useAgentForConversation',
    context,
  );
  for (const agentId of ['missing', 'off']) {
    await expect(use({ conversationId: 'c', agentId })).rejects.toThrow('Agent 配置不存在或已禁用');
    expect(conversation).toEqual({
      id: 'c',
      agentId: 'claude',
      agentName: 'Claude',
      acpSessionId: 'resumable',
    });
  }
  expect(context.freshSessionNotice).toEqual(new Set());
  expect(context.connectAgent).not.toHaveBeenCalled();
  await use({ conversationId: 'c', agentId: 'codex' });
  expect(conversation).toMatchObject({ agentId: 'codex', agentName: 'Codex' });
  expect(conversation.acpSessionId).toBeUndefined();
  expect(context.connectAgent).toHaveBeenCalledWith('codex', 'c');
});

it('applying a skill proposal to a skill whose distillation is in hand is refused', async () => {
  const context: Record<string, unknown> = {
    distillation: { busyReasonFor: (id: string) => (id === 'busy' ? '正在提炼' : undefined) },
    skillProposals: { apply: vi.fn(async () => 'applied') },
  };
  const apply = handler<{ proposalId: string; targetSkillId: string }>(
    'IPC.skillsProposalApply',
    context,
  );
  await expect(apply({ proposalId: 'p', targetSkillId: 'busy' })).rejects.toThrow(
    '正在提炼，请先保留或丢弃提案',
  );
  expect(
    (context.skillProposals as { apply: ReturnType<typeof vi.fn> }).apply,
  ).not.toHaveBeenCalled();
  expect(await apply({ proposalId: 'p', targetSkillId: 'free' })).toBe('applied');
});
