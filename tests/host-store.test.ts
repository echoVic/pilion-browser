import { afterEach, describe, expect, it } from 'vitest';
import {
  DurableHostStore,
  HostError,
  ResumeCredentialAuthority,
  type IntentInput,
} from '../src/main/host/index';

const stores: DurableHostStore[] = [];
const clock = new Date('2026-01-01T00:00:00.000Z');

function setup(): DurableHostStore {
  const store = new DurableHostStore({ path: ':memory:', now: () => clock });
  stores.push(store);
  store.createSession({
    sessionId: 'session',
    profileId: 'profile',
    principal: 'principal',
    agentId: 'agent',
    connectionEpoch: 2,
    capabilitySnapshotHash: 'caps',
  });
  store.createAttachment({
    attachmentId: 'attachment',
    sessionId: 'session',
    principal: 'principal',
    agentId: 'agent',
    role: 'owner',
    leaseExpiresAt: '2026-01-01T01:00:00.000Z',
    connectionEpoch: 2,
    capabilitySnapshotHash: 'caps',
  });
  return store;
}

function intent(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    actionId: 'action',
    sessionId: 'session',
    attachmentId: 'attachment',
    connectionEpoch: 2,
    tabId: 'tab',
    canonicalCommandHash: 'command-hash',
    actionDigest: 'action-digest',
    canonicalCommand: { schemaVersion: '1' },
    idempotencyKey: 'idempotency-key',
    revisionPreconditions: { documentEpoch: 'doc' },
    policySetVersion: 'policy-v1',
    policyVerdict: 'allow',
    policyReasons: ['PAGE_STATE_CHANGE'],
    obligations: [{ type: 'revalidate_target', parameters: {} }],
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('SQLite durable store', () => {
  it('Intent 与 Outbox 同事务提交，失败时一起回滚', () => {
    const store = setup();
    store.createIntent(intent());
    const eventsAfterSuccess = store.count('events');
    const outboxAfterSuccess = store.count('outbox');
    expect(eventsAfterSuccess).toBe(outboxAfterSuccess);
    expect(store.getAction('action')?.state).toBe('queued');

    expect(() =>
      store.createIntent(intent({ actionId: 'duplicate', idempotencyKey: 'idempotency-key' })),
    ).toThrow();
    expect(store.count('actions')).toBe(1);
    expect(store.count('events')).toBe(eventsAfterSuccess);
    expect(store.count('outbox')).toBe(outboxAfterSuccess);
    expect(store.pendingOutbox()).toHaveLength(outboxAfterSuccess);
  });

  it('审批、prepare、dispatched、effect_started、Result 各自形成事务屏障', () => {
    const store = setup();
    store.createIntent(
      intent({
        policyVerdict: 'require_approval',
        approval: { approvalId: 'approval', nonce: 'nonce', expiresAt: '2026-01-01T00:01:00.000Z' },
      }),
    );
    expect(store.getAction('action')?.state).toBe('awaiting_approval');
    expect(store.count('attempts')).toBe(0);

    const approval = store.resolveApproval({
      approvalId: 'approval',
      nonce: 'nonce',
      actionDigest: 'action-digest',
      decision: 'approve',
      bindingValid: true,
    });
    expect(approval.actionState).toBe('approved');
    expect(() =>
      store.resolveApproval({
        approvalId: 'approval',
        nonce: 'nonce',
        actionDigest: 'action-digest',
        decision: 'approve',
        bindingValid: true,
      }),
    ).toThrowError(HostError);

    const prepared = store.prepareExecution({
      actionId: 'action',
      attemptId: 'attempt',
      sessionId: 'session',
      attachmentId: 'attachment',
      connectionEpoch: 2,
      tabId: 'tab',
      policySetVersion: 'policy-v1',
      capabilitySnapshotHash: 'caps',
      expectedApprovalDigest: approval.approvalDigest,
    });
    expect(prepared.fencingToken).toBe(1);
    expect(store.getAttempt('attempt')?.state).toBe('prepared');
    expect(store.getAction('action')?.state).toBe('executing');

    store.markDispatched('attempt', 'grant');
    store.markEffectStarted('attempt');
    store.recordResult({ attemptId: 'attempt', outcome: 'succeeded', result: { ok: true } });
    expect(store.getAction('action')?.state).toBe('succeeded');
    expect(store.getAttempt('attempt')?.state).toBe('succeeded');
    expect(store.count('results')).toBe(1);
    expect(store.count('events')).toBe(store.count('outbox'));
  });

  it('拒绝旧 epoch，重启 reconcile 将未知副作用收敛为 outcome_unknown', () => {
    const stale = setup();
    expect(() => stale.createIntent(intent({ connectionEpoch: 1 }))).toThrowError(HostError);
    try {
      stale.createIntent(
        intent({ actionId: 'another', idempotencyKey: 'other', connectionEpoch: 1 }),
      );
    } catch (error) {
      expect((error as HostError).code).toBe('STALE_CONNECTION_EPOCH');
    }

    const store = setup();
    store.createIntent(intent());
    store.prepareExecution({
      actionId: 'action',
      attemptId: 'attempt',
      sessionId: 'session',
      attachmentId: 'attachment',
      connectionEpoch: 2,
      tabId: 'tab',
      policySetVersion: 'policy-v1',
      capabilitySnapshotHash: 'caps',
    });
    store.markDispatched('attempt', 'grant');
    store.markEffectStarted('attempt');
    expect(store.reconcileExecuting({ attempt: 'unknown' })).toEqual([
      { attemptId: 'attempt', outcome: 'outcome_unknown' },
    ]);
    expect(store.getAction('action')?.state).toBe('outcome_unknown');
    expect(store.getAttempt('attempt')?.state).toBe('outcome_unknown');
    expect(store.count('events')).toBe(store.count('outbox'));
  });

  it('恢复凭证消费、epoch 递增和新 Attachment 原子提交', () => {
    const store = setup();
    const authority = new ResumeCredentialAuthority(Buffer.alloc(32, 5));
    const identity = {
      principal: 'principal',
      agentId: 'agent',
      hostInstanceId: 'host',
      capabilitySnapshotHash: 'caps',
      connectionEpoch: 2,
    };
    const credential = authority.issue(identity, clock);
    expect(
      authority.verifyAndResume(
        credential,
        identity,
        store,
        {
          attachmentId: 'replacement',
          leaseExpiresAt: '2026-01-01T00:01:00.000Z',
        },
        clock,
      ),
    ).toBe(3);
    expect(() =>
      authority.verifyAndResume(
        credential,
        identity,
        store,
        {
          attachmentId: 'replay',
          leaseExpiresAt: '2026-01-01T00:01:00.000Z',
        },
        clock,
      ),
    ).toThrowError(HostError);
    expect(() => store.createIntent(intent({ connectionEpoch: 2 }))).toThrowError(HostError);
  });

  it('未消费 Grant 的 prepared Attempt 可证明未分发', () => {
    const store = setup();
    store.createIntent(intent());
    store.prepareExecution({
      actionId: 'action',
      attemptId: 'attempt',
      sessionId: 'session',
      attachmentId: 'attachment',
      connectionEpoch: 2,
      tabId: 'tab',
      policySetVersion: 'policy-v1',
      capabilitySnapshotHash: 'caps',
    });
    expect(store.reconcileExecuting({ attempt: 'not_consumed' })).toEqual([
      { attemptId: 'attempt', outcome: 'failed_before_dispatch' },
    ]);
    expect(store.getAttempt('attempt')?.state).toBe('failed_before_dispatch');
    expect(store.getAction('action')?.state).toBe('failed');
  });

  it('过期 Attachment 在 createIntent 前原子标记 expired', () => {
    const store = new DurableHostStore({ path: ':memory:', now: () => clock });
    stores.push(store);
    store.createSession({
      sessionId: 'session',
      profileId: 'profile',
      principal: 'principal',
      agentId: 'agent',
      connectionEpoch: 2,
      capabilitySnapshotHash: 'caps',
    });
    store.createAttachment({
      attachmentId: 'attachment',
      sessionId: 'session',
      principal: 'principal',
      agentId: 'agent',
      role: 'owner',
      leaseExpiresAt: clock.toISOString(),
      connectionEpoch: 2,
      capabilitySnapshotHash: 'caps',
    });
    expect(() => store.createIntent(intent())).toThrowError(
      expect.objectContaining({ code: 'LEASE_EXPIRED' }),
    );
    expect(
      store.database
        .prepare('SELECT state FROM attachments WHERE attachment_id = ?')
        .get('attachment'),
    ).toMatchObject({ state: 'expired' });
    expect(store.count('actions')).toBe(0);
  });

  it('Intent 后 lease 到期会阻断 prepareExecution 并持久化 expired', () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new DurableHostStore({ path: ':memory:', now: () => now });
    stores.push(store);
    store.createSession({
      sessionId: 'session',
      profileId: 'profile',
      principal: 'principal',
      agentId: 'agent',
      connectionEpoch: 2,
      capabilitySnapshotHash: 'caps',
    });
    store.createAttachment({
      attachmentId: 'attachment',
      sessionId: 'session',
      principal: 'principal',
      agentId: 'agent',
      role: 'owner',
      leaseExpiresAt: '2026-01-01T00:00:01.000Z',
      connectionEpoch: 2,
      capabilitySnapshotHash: 'caps',
    });
    store.createIntent(intent());
    now = new Date('2026-01-01T00:00:02.000Z');
    expect(() =>
      store.prepareExecution({
        actionId: 'action',
        attemptId: 'attempt',
        sessionId: 'session',
        attachmentId: 'attachment',
        connectionEpoch: 2,
        tabId: 'tab',
        policySetVersion: 'policy-v1',
        capabilitySnapshotHash: 'caps',
      }),
    ).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
    expect(
      store.database
        .prepare('SELECT state FROM attachments WHERE attachment_id = ?')
        .get('attachment'),
    ).toMatchObject({ state: 'expired' });
    expect(store.count('attempts')).toBe(0);
  });
});
