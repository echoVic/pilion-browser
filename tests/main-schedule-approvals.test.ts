import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { sha256 } from '../src/main/host/index';
import type { ApprovalViewState } from '../src/shared/contracts';

type Actor = {
  principal: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
  taskId: string;
};
type Pending = {
  view: ApprovalViewState;
  conversationId?: string;
  sessionId?: string;
  nonce: string;
  actionDigest: string;
};
function runtime() {
  const actor = (suffix: string): Actor => ({
    principal: `agent:${suffix}`,
    sessionId: `session-${suffix}`,
    attachmentId: `attachment-${suffix}`,
    connectionEpoch: 1,
    capabilitySnapshotHash: 'capabilities',
    taskId: `task-${suffix}`,
  });
  const a = { ...actor('a'), conversationId: 'A', promptCancelled: false };
  const b = { ...actor('b'), conversationId: 'B', promptCancelled: false };
  const connections = new Map([[a.sessionId, a], [b.sessionId, b]]);
  const approvals = new Map<string, Pending>();
  const timers: Array<() => void> = [];
  const gestures = new Map();
  const assertLive = vi.fn((identity: Actor) => {
    const conn = connections.get(identity.sessionId);
    if (!conn || conn.attachmentId !== identity.attachmentId || conn.taskId !== identity.taskId)
      throw new Error('stale actor');
  });
  const context = {
    randomBytes, randomUUID, sha256, approvals,
    gestureTokens: gestures,
    connBySessionId: (id: string) => connections.get(id),
    isLiveConnection: (conn: typeof a) => connections.get(conn.sessionId) === conn,
    requireLiveActor: assertLive,
    trustedRenderer() {},
    requestAttention() {},
    emit() {},
    setTimeout(callback: () => void) { timers.push(callback); return { callback }; },
    clearTimeout() {},
  };
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true,
  );
  const names = ['requestScheduleApproval', 'respondApproval', 'approvalSender', 'cancelAcpApprovals'];
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  const api = runInNewContext(
    ts.transpileModule(functions.map((fn) => fn.getText(source)).join('\n') +
      '\n({requestScheduleApproval, respondApproval, cancelAcpApprovals})', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, context,
  ) as {
    requestScheduleApproval(summary: string, actor: Actor, conversationId: string, tool?: string): Promise<boolean>;
    respondApproval(event: object, response: object): void;
    cancelAcpApprovals(conn: typeof a): void;
  };
  function decide(pending: Pending) {
    const gestureToken = randomUUID();
    gestures.set(gestureToken, { senderId: 1, approvalId: pending.view.approvalId, expiresAt: Date.now() + 60000 });
    api.respondApproval({ sender: { id: 1 } }, {
      approvalId: pending.view.approvalId, nonce: pending.nonce,
      actionDigest: pending.actionDigest, gestureToken, decision: 'approve',
    });
  }
  return { api, a, b, approvals, connections, timers, decide, assertLive };
}

it('publishes the captured source of schedule approvals for the conversation dock', async () => {
  const test = runtime();
  const result = test.api.requestScheduleApproval('create', test.a, 'A', 'browser.schedule.create');
  const pending = [...test.approvals.values()][0];
  test.decide(pending);
  expect(await result).toBe(true);
  expect(pending.conversationId).toBe('A');
  expect(pending.sessionId).toBe(test.a.sessionId);
});

it('cancels only schedule approvals owned by the detached internal connection', async () => {
  const test = runtime();
  const a = test.api.requestScheduleApproval('A', test.a, 'A');
  const b = test.api.requestScheduleApproval('B', test.b, 'B');
  test.api.cancelAcpApprovals(test.a);
  expect([...test.approvals.values()].map((p) => p.conversationId)).toEqual(['B']);
  test.decide([...test.approvals.values()][0]);
  expect(await a).toBe(false);
  expect(await b).toBe(true);
});

it('denies a stale schedule approval after task or attachment replacement', async () => {
  const test = runtime();
  const result = test.api.requestScheduleApproval('create', test.a, 'A');
  const pending = [...test.approvals.values()][0];
  test.a.attachmentId = 'replaced';
  test.decide(pending);
  expect(await result).toBe(false);
});

it('keeps unattended schedule approvals fail-closed at their real expiry callback', async () => {
  const test = runtime();
  const result = test.api.requestScheduleApproval('create', test.a, 'A');
  test.timers[0]();
  expect(await result).toBe(false);
  expect(test.approvals.size).toBe(0);
});
