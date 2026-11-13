import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** 把 main.ts 的退出收尾（drain）和它要用的 cancelBrowserApprovals 原样拿出来，在 vm 里跑。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const FUNCTIONS = ['drain', 'cancelBrowserApprovals'];

type Pending = {
  kind: 'browser' | 'schedule' | 'acp';
  sessionId: string;
  conversationId?: string;
  view: { approvalId: string };
  nonce: string;
  actionDigest: string;
  timer: unknown;
  resolve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
};

function load() {
  const nodes = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && FUNCTIONS.includes(node.name?.text ?? ''),
  );
  expect(nodes).toHaveLength(FUNCTIONS.length);
  const log: string[] = [];
  let finishIdle!: () => void;
  const idle = new Promise<void>((resolve) => {
    finishIdle = () => {
      log.push('schedules idle');
      resolve();
    };
  });
  const approvals = new Map<string, Pending>();
  const sessions = new Map<string, { sessionId: string; conversationId: string }>();
  const context: Record<string, unknown> = {
    console: { error: vi.fn() },
    shutdownPhase: 'running',
    archiveTimer: undefined,
    workspaceTimer: undefined,
    clearInterval() {},
    clearTimeout() {},
    scheduler: { stop: vi.fn() },
    abortAdapterInstalls: vi.fn(),
    recordingSession: { isRecording: () => false },
    stopRecording: vi.fn(),
    autoRecordingName: () => 'auto',
    stopReplay: vi.fn(),
    backgroundTabs: { dispose: vi.fn() },
    agentReplay: undefined,
    distillation: { finish: vi.fn() },
    workspace: { save: async () => log.push('workspace saved') },
    sessions,
    approvals,
    emit: vi.fn(),
    store: {
      resolveApproval: vi.fn((input: { approvalId: string; decision: string }) => {
        log.push(`ledger ${input.decision} ${input.approvalId}`);
      }),
      close: vi.fn(() => log.push('store closed')),
    },
    // 真实的 disconnectAgent 会经 cancelBrowserApprovals(current) 把这条会话等着的审批记成拒绝。
    disconnectAgent: vi.fn(async (id: string) => {
      log.push(`disconnect ${id}`);
      (context.cancelBrowserApprovals as (target: object) => void)(sessions.get(id)!);
      sessions.delete(id);
    }),
    processManager: { stopAll: async () => log.push('processes stopped') },
    stopExternalControl: async () => log.push('external stopped'),
    schedules: { idle: () => idle },
  };
  runInNewContext(
    ts.transpileModule(
      `${nodes.map((node) => node.getText(source)).join('\n')}
globalThis.drain = drain;
globalThis.cancelBrowserApprovals = cancelBrowserApprovals;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  const pending = (
    approvalId: string,
    kind: Pending['kind'],
    sessionId: string,
    conversationId?: string,
  ): Pending => {
    const item: Pending = {
      kind,
      sessionId,
      ...(conversationId ? { conversationId } : {}),
      view: { approvalId },
      nonce: `nonce-${approvalId}`,
      actionDigest: `digest-${approvalId}`,
      timer: undefined,
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    approvals.set(approvalId, item);
    return item;
  };
  return {
    drain: context.drain as () => Promise<void>,
    context,
    approvals,
    sessions,
    pending,
    log,
    finishIdle,
  };
}

it('quitting disconnects sessions before settling approvals, so none is left pending in the ledger', async () => {
  const { drain, sessions, pending, approvals, log, finishIdle } = load();
  sessions.set('a', { sessionId: 'session-a', conversationId: 'a' });
  const agentApproval = pending('agent', 'browser', 'session-a', 'a');
  const externalApproval = pending('external', 'browser', 'session-external');
  const schedule = pending('schedule', 'schedule', 'session-schedule');
  const acp = pending('acp', 'acp', 'session-acp');
  finishIdle();
  await drain();

  // 会话等着的审批由断开会话自己经账本记成拒绝；剩下的外部审批同样经账本，原因是正在退出。
  expect(log.indexOf('disconnect a')).toBeLessThan(log.indexOf('ledger deny agent'));
  expect(log).toContain('ledger deny external');
  expect(log.filter((line) => line.startsWith('ledger'))).toHaveLength(2);
  expect(agentApproval.reject).toHaveBeenCalledOnce();
  expect(externalApproval.reject).toHaveBeenCalledWith(new Error('应用正在退出'));
  // 定时任务和 ACP 审批不在浏览器台账里：照旧直接结束。
  expect(schedule.resolve).toHaveBeenCalledWith(false);
  expect(acp.resolve).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
  expect(approvals.size).toBe(0);
  expect(log.at(-1)).toBe('store closed');
});

it('quitting waits for pending schedule writes before closing the ledger', async () => {
  const { drain, log, finishIdle, context } = load();
  let done = false;
  const draining = drain().then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(log).toContain('external stopped'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(done).toBe(false);
  expect(log).not.toContain('store closed');
  finishIdle();
  await draining;
  expect(log.slice(-2)).toEqual(['schedules idle', 'store closed']);
  expect(context.shutdownPhase).toBe('draining');
});

it('a failing schedule flush is logged and the ledger is still closed', async () => {
  const { drain, log, context } = load();
  context.schedules = { idle: async () => Promise.reject(new Error('disk full')) };
  await drain();
  expect(log.at(-1)).toBe('store closed');
  expect((context.console as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith(
    '退出收尾失败：写完定时任务',
    new Error('disk full'),
  );
});
