import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { sha256 } from './canonical.js';
import type {
  ExecutionGrant,
  GrantConsumptionStore,
  ResumeAttachmentInput,
  ResumeCommitStore,
  ResumeCredential,
  ResumeNonceStore,
} from './credentials.js';
import { assertTransition } from './state-machine.js';
import { HostError, type ActionState, type ApprovalState, type AttemptState } from './types.js';

export interface StoreOptions {
  path: string;
  now?: () => Date;
}

export interface IntentInput {
  actionId: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  tabId: string;
  canonicalCommandHash: string;
  actionDigest: string;
  canonicalCommand: unknown;
  idempotencyKey: string;
  revisionPreconditions: unknown;
  policySetVersion: string;
  policyVerdict: 'allow' | 'require_approval' | 'deny';
  policyReasons: string[];
  obligations: unknown[];
  approval?: { approvalId: string; nonce: string; expiresAt: string };
}

export interface PrepareInput {
  actionId: string;
  attemptId: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  tabId: string;
  policySetVersion: string;
  capabilitySnapshotHash: string;
  expectedApprovalDigest?: string;
}

export interface PreparedAttempt {
  attemptId: string;
  actionId: string;
  fencingToken: number;
  preparedMarker: string;
  canonicalCommandHash: string;
  actionDigest: string;
  policyVerdict: 'allow' | 'require_approval';
  policySetVersion: string;
  approvalId?: string;
  approvalDigest?: string;
}

type DbRow = Record<string, unknown>;

const migrations = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    state TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    capability_snapshot_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    principal TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    capability_snapshot_hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_epoch
    ON attachments(session_id, connection_epoch) WHERE role = 'owner' AND state = 'attached';
  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
    connection_epoch INTEGER NOT NULL,
    tab_id TEXT NOT NULL,
    state TEXT NOT NULL,
    canonical_command_hash TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    canonical_command_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    revision_json TEXT NOT NULL,
    policy_set_version TEXT NOT NULL,
    policy_verdict TEXT NOT NULL,
    policy_reasons_json TEXT NOT NULL,
    obligations_json TEXT NOT NULL,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL UNIQUE REFERENCES actions(action_id),
    state TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    approval_digest TEXT,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS fencing_tokens (
    tab_id TEXT PRIMARY KEY,
    last_token INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    state TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    prepared_marker TEXT NOT NULL,
    grant_id TEXT,
    effect_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(action_id, attempt_id),
    UNIQUE(action_id, fencing_token)
  );
  CREATE TABLE IF NOT EXISTS results (
    result_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL UNIQUE REFERENCES actions(action_id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
    outcome TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  );
  CREATE TABLE IF NOT EXISTS consumed_grants (
    grant_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    fencing_token INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY(grant_id, attempt_id, fencing_token),
    UNIQUE(tab_id, fencing_token)
  );
  CREATE TABLE IF NOT EXISTS consumed_resume_nonces (
    nonce TEXT PRIMARY KEY,
    expiry TEXT NOT NULL,
    consumed_at TEXT NOT NULL
  );
  `,
];

export class DurableHostStore
  implements GrantConsumptionStore, ResumeNonceStore, ResumeCommitStore
{
  readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(options: StoreOptions) {
    this.database = new DatabaseSync(options.path);
    this.now = options.now ?? (() => new Date());
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
    );
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
      );
      const applied = new Set(
        (this.database.prepare('SELECT version FROM schema_migrations').all() as DbRow[]).map(
          (row) => Number(row.version),
        ),
      );
      migrations.forEach((sql, index) => {
        const version = index + 1;
        if (!applied.has(version)) {
          this.database.exec(sql);
          this.database
            .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
            .run(version, this.timestamp());
        }
      });
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private row(sql: string, ...values: SQLInputValue[]): DbRow | undefined {
    return this.database.prepare(sql).get(...values) as DbRow | undefined;
  }

  private event(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: unknown,
  ): void {
    const eventId = randomUUID();
    const createdAt = this.timestamp();
    const body = JSON.stringify({
      eventId,
      aggregateType,
      aggregateId,
      eventType,
      payload,
      createdAt,
    });
    this.database
      .prepare(
        'INSERT INTO events(event_id, aggregate_type, aggregate_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(eventId, aggregateType, aggregateId, eventType, JSON.stringify(payload), createdAt);
    this.database
      .prepare('INSERT INTO outbox(event_id, payload_json, created_at) VALUES (?, ?, ?)')
      .run(eventId, body, createdAt);
  }

  createSession(input: {
    sessionId: string;
    profileId: string;
    principal: string;
    agentId: string;
    connectionEpoch: number;
    capabilitySnapshotHash: string;
    state?: 'creating' | 'active';
  }): void {
    this.transaction(() => {
      const at = this.timestamp();
      this.database
        .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          input.sessionId,
          input.profileId,
          input.principal,
          input.agentId,
          input.state ?? 'active',
          input.connectionEpoch,
          input.capabilitySnapshotHash,
          at,
          at,
        );
      this.event('session', input.sessionId, 'session.created', {
        state: input.state ?? 'active',
        connectionEpoch: input.connectionEpoch,
      });
    });
  }

  createAttachment(input: {
    attachmentId: string;
    sessionId: string;
    principal: string;
    agentId: string;
    role: 'owner' | 'observer';
    state?: 'attaching' | 'attached';
    leaseExpiresAt: string;
    connectionEpoch: number;
    capabilitySnapshotHash: string;
  }): void {
    this.transaction(() => {
      const session = this.row('SELECT * FROM sessions WHERE session_id = ?', input.sessionId);
      if (!session) throw new HostError('NOT_FOUND', 'Session not found');
      if (Number(session.connection_epoch) !== input.connectionEpoch)
        throw new HostError('STALE_CONNECTION_EPOCH', 'Attachment epoch is stale');
      this.database
        .prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          input.attachmentId,
          input.sessionId,
          input.principal,
          input.agentId,
          input.role,
          input.state ?? 'attached',
          input.leaseExpiresAt,
          input.connectionEpoch,
          this.timestamp(),
          input.capabilitySnapshotHash,
        );
      this.event('attachment', input.attachmentId, 'attachment.created', {
        state: input.state ?? 'attached',
      });
    });
  }

  transitionSession(sessionId: string, next: 'active' | 'draining' | 'closed' | 'failed'): void {
    this.transaction(() => {
      const row = this.row('SELECT state FROM sessions WHERE session_id = ?', sessionId);
      if (!row) throw new HostError('NOT_FOUND', 'Session not found');
      assertTransition('session', row.state as never, next);
      this.database
        .prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE session_id = ?')
        .run(next, this.timestamp(), sessionId);
      this.event('session', sessionId, 'session.state_changed', { from: row.state, to: next });
    });
  }

  transitionAttachment(
    attachmentId: string,
    next: 'attached' | 'detached' | 'expired' | 'closed' | 'failed',
  ): void {
    this.transaction(() => {
      const row = this.row('SELECT state FROM attachments WHERE attachment_id = ?', attachmentId);
      if (!row) throw new HostError('NOT_FOUND', 'Attachment not found');
      assertTransition('attachment', row.state as never, next);
      this.database
        .prepare('UPDATE attachments SET state = ?, last_seen_at = ? WHERE attachment_id = ?')
        .run(next, this.timestamp(), attachmentId);
      this.event('attachment', attachmentId, 'attachment.state_changed', {
        from: row.state,
        to: next,
      });
    });
  }

  private requireLiveAttachment(attachmentId: string): void {
    const expired = this.transaction(() => {
      const attachment = this.row(
        'SELECT state, lease_expires_at FROM attachments WHERE attachment_id = ?',
        attachmentId,
      );
      if (!attachment) throw new HostError('NOT_FOUND', 'Attachment not found');
      if (
        attachment.state === 'attached' &&
        Date.parse(String(attachment.lease_expires_at)) <= this.now().getTime()
      ) {
        const at = this.timestamp();
        this.database
          .prepare(
            "UPDATE attachments SET state = 'expired', last_seen_at = ? WHERE attachment_id = ? AND state = 'attached'",
          )
          .run(at, attachmentId);
        this.event('attachment', attachmentId, 'attachment.expired', {
          leaseExpiresAt: attachment.lease_expires_at,
        });
        return true;
      }
      return attachment.state === 'expired';
    });
    if (expired) throw new HostError('LEASE_EXPIRED', 'Attachment lease has expired');
  }

  assertAttachmentAccess(input: {
    sessionId: string;
    attachmentId: string;
    principal: string;
    connectionEpoch: number;
  }): void {
    this.requireLiveAttachment(input.attachmentId);
    const row = this.row(
      'SELECT a.state, a.principal, a.connection_epoch, s.state AS session_state, s.connection_epoch AS session_epoch FROM attachments a JOIN sessions s ON s.session_id = a.session_id WHERE a.attachment_id = ? AND a.session_id = ?',
      input.attachmentId,
      input.sessionId,
    );
    if (!row) throw new HostError('NOT_FOUND', 'Session or attachment not found');
    if (row.state !== 'attached' || row.session_state !== 'active')
      throw new HostError('INVALID_STATE_TRANSITION', 'Session or attachment is not active');
    if (
      row.principal !== input.principal ||
      Number(row.connection_epoch) !== input.connectionEpoch ||
      Number(row.session_epoch) !== input.connectionEpoch
    ) {
      throw new HostError('STALE_CONNECTION_EPOCH', 'Attachment authorization changed');
    }
  }

  createIntent(input: IntentInput): { actionState: ActionState; approvalId?: string } {
    this.requireLiveAttachment(input.attachmentId);
    return this.transaction(() => {
      const session = this.row(
        'SELECT state, connection_epoch FROM sessions WHERE session_id = ?',
        input.sessionId,
      );
      const attachment = this.row(
        'SELECT state, connection_epoch FROM attachments WHERE attachment_id = ? AND session_id = ?',
        input.attachmentId,
        input.sessionId,
      );
      if (!session || !attachment)
        throw new HostError('NOT_FOUND', 'Session or attachment not found');
      if (session.state !== 'active' || attachment.state !== 'attached')
        throw new HostError('INVALID_STATE_TRANSITION', 'Session is not accepting actions');
      if (
        Number(session.connection_epoch) !== input.connectionEpoch ||
        Number(attachment.connection_epoch) !== input.connectionEpoch
      ) {
        throw new HostError('STALE_CONNECTION_EPOCH', 'Action epoch is stale');
      }
      if (input.policyVerdict === 'require_approval' && !input.approval) {
        throw new HostError('POLICY_DENIED', 'Trusted approval is required');
      }
      const state: ActionState =
        input.policyVerdict === 'deny'
          ? 'failed'
          : input.policyVerdict === 'require_approval'
            ? 'awaiting_approval'
            : 'queued';
      const at = this.timestamp();
      this.database
        .prepare(
          `INSERT INTO actions(action_id, session_id, attachment_id, connection_epoch, tab_id, state,
          canonical_command_hash, action_digest, canonical_command_json, idempotency_key, revision_json,
          policy_set_version, policy_verdict, policy_reasons_json, obligations_json, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.actionId,
          input.sessionId,
          input.attachmentId,
          input.connectionEpoch,
          input.tabId,
          state,
          input.canonicalCommandHash,
          input.actionDigest,
          JSON.stringify(input.canonicalCommand),
          input.idempotencyKey,
          JSON.stringify(input.revisionPreconditions),
          input.policySetVersion,
          input.policyVerdict,
          JSON.stringify(input.policyReasons),
          JSON.stringify(input.obligations),
          input.policyVerdict === 'deny' ? 'POLICY_DENIED' : null,
          at,
          at,
        );
      if (input.approval) {
        this.database
          .prepare("INSERT INTO approvals VALUES (?, ?, 'pending', ?, ?, ?, NULL, NULL)")
          .run(
            input.approval.approvalId,
            input.actionId,
            input.approval.nonce,
            input.approval.expiresAt,
            input.actionDigest,
          );
      }
      this.event('action', input.actionId, 'action.intent_recorded', {
        state,
        policyVerdict: input.policyVerdict,
        approvalId: input.approval?.approvalId,
      });
      return { actionState: state, approvalId: input.approval?.approvalId };
    });
  }

  resolveApproval(input: {
    approvalId: string;
    nonce: string;
    actionDigest: string;
    decision: 'approve' | 'deny';
    bindingValid: boolean;
    now?: Date;
  }): { approvalState: ApprovalState; actionState: ActionState; approvalDigest?: string } {
    return this.transaction(() => {
      const row = this.row(
        'SELECT p.*, a.state AS action_state FROM approvals p JOIN actions a ON a.action_id = p.action_id WHERE p.approval_id = ?',
        input.approvalId,
      );
      if (!row) throw new HostError('NOT_FOUND', 'Approval not found');
      if (row.state !== 'pending' || row.nonce !== input.nonce)
        throw new HostError('APPROVAL_ALREADY_RESOLVED', 'Approval nonce is invalid or consumed');
      let approvalState: ApprovalState;
      let actionState: ActionState;
      let approvalDigest: string | undefined;
      if (row.action_digest !== input.actionDigest || !input.bindingValid) {
        approvalState = 'stale';
        actionState = 'stale';
      } else if (Date.parse(String(row.expires_at)) <= (input.now ?? this.now()).getTime()) {
        approvalState = 'expired';
        actionState = 'stale';
      } else if (input.decision === 'deny') {
        approvalState = 'denied';
        actionState = 'cancelled';
      } else {
        approvalState = 'approved';
        actionState = 'approved';
        approvalDigest = sha256({
          approvalId: input.approvalId,
          actionDigest: input.actionDigest,
          decision: 'approve',
          nonce: input.nonce,
        });
      }
      assertTransition('approval', row.state as never, approvalState);
      assertTransition('action', row.action_state as never, actionState);
      const at = this.timestamp();
      this.database
        .prepare(
          'UPDATE approvals SET state = ?, approval_digest = ?, resolved_at = ? WHERE approval_id = ?',
        )
        .run(approvalState, approvalDigest ?? null, at, input.approvalId);
      this.database
        .prepare('UPDATE actions SET state = ?, updated_at = ? WHERE action_id = ?')
        .run(actionState, at, row.action_id as string);
      this.event('approval', input.approvalId, 'approval.resolved', {
        state: approvalState,
        actionState,
      });
      return { approvalState, actionState, approvalDigest };
    });
  }

  prepareExecution(input: PrepareInput): PreparedAttempt {
    this.requireLiveAttachment(input.attachmentId);
    return this.transaction(() => {
      const action = this.row(
        `SELECT a.*, s.state AS session_state, s.connection_epoch AS session_epoch,
          s.capability_snapshot_hash AS session_capability_hash, t.state AS attachment_state,
          t.connection_epoch AS attachment_epoch, t.capability_snapshot_hash AS attachment_capability_hash,
          p.approval_id, p.state AS approval_state, p.approval_digest
         FROM actions a JOIN sessions s ON s.session_id = a.session_id
         JOIN attachments t ON t.attachment_id = a.attachment_id
         LEFT JOIN approvals p ON p.action_id = a.action_id WHERE a.action_id = ?`,
        input.actionId,
      );
      if (!action) throw new HostError('NOT_FOUND', 'Action not found');
      if (
        action.session_id !== input.sessionId ||
        action.attachment_id !== input.attachmentId ||
        action.tab_id !== input.tabId
      )
        throw new HostError('GRANT_INVALID', 'Execution scope mismatch');
      if (
        Number(action.session_epoch) !== input.connectionEpoch ||
        Number(action.attachment_epoch) !== input.connectionEpoch ||
        Number(action.connection_epoch) !== input.connectionEpoch
      )
        throw new HostError('STALE_CONNECTION_EPOCH', 'Execution epoch is stale');
      if (action.session_state !== 'active' || action.attachment_state !== 'attached')
        throw new HostError('INVALID_STATE_TRANSITION', 'Session is not executable');
      if (
        action.session_capability_hash !== input.capabilitySnapshotHash ||
        action.attachment_capability_hash !== input.capabilitySnapshotHash
      )
        throw new HostError('GRANT_INVALID', 'Capability snapshot changed');
      if (action.policy_set_version !== input.policySetVersion)
        throw new HostError('GRANT_INVALID', 'Policy version changed');
      if (action.policy_verdict === 'deny')
        throw new HostError('POLICY_DENIED', 'Policy denied action');
      if (
        action.policy_verdict === 'require_approval' &&
        (action.approval_state !== 'approved' ||
          action.approval_digest !== input.expectedApprovalDigest)
      )
        throw new HostError('APPROVAL_STALE', 'Approval is absent or stale');
      const expectedState = action.policy_verdict === 'require_approval' ? 'approved' : 'queued';
      if (action.state !== expectedState)
        throw new HostError(
          'INVALID_STATE_TRANSITION',
          `Action cannot prepare from ${String(action.state)}`,
        );
      assertTransition('action', action.state as never, 'executing');
      this.database
        .prepare(
          `INSERT INTO fencing_tokens(tab_id, last_token) VALUES (?, 1)
         ON CONFLICT(tab_id) DO UPDATE SET last_token = last_token + 1`,
        )
        .run(input.tabId);
      const fencingToken = Number(
        this.row('SELECT last_token FROM fencing_tokens WHERE tab_id = ?', input.tabId)?.last_token,
      );
      const marker = randomUUID();
      const at = this.timestamp();
      this.database
        .prepare(
          "INSERT INTO attempts(attempt_id, action_id, state, fencing_token, prepared_marker, created_at, updated_at) VALUES (?, ?, 'prepared', ?, ?, ?, ?)",
        )
        .run(input.attemptId, input.actionId, fencingToken, marker, at, at);
      this.database
        .prepare("UPDATE actions SET state = 'executing', updated_at = ? WHERE action_id = ?")
        .run(at, input.actionId);
      this.event('attempt', input.attemptId, 'attempt.prepared', {
        actionId: input.actionId,
        fencingToken,
        preparedMarker: marker,
      });
      return {
        attemptId: input.attemptId,
        actionId: input.actionId,
        fencingToken,
        preparedMarker: marker,
        canonicalCommandHash: String(action.canonical_command_hash),
        actionDigest: String(action.action_digest),
        policyVerdict: action.policy_verdict as 'allow' | 'require_approval',
        policySetVersion: String(action.policy_set_version),
        approvalId: action.approval_id as string | undefined,
        approvalDigest: action.approval_digest as string | undefined,
      };
    });
  }

  markDispatched(attemptId: string, grantId: string): void {
    this.transitionAttempt(attemptId, 'dispatched', 'attempt.dispatched', { grantId }, grantId);
  }

  markEffectStarted(attemptId: string): void {
    this.transitionAttempt(attemptId, 'effect_started', 'attempt.effect_started', {
      effectStartedAt: this.timestamp(),
    });
  }

  private transitionAttempt(
    attemptId: string,
    next: AttemptState,
    eventType: string,
    payload: unknown,
    grantId?: string,
  ): void {
    this.transaction(() => {
      const row = this.row('SELECT state FROM attempts WHERE attempt_id = ?', attemptId);
      if (!row) throw new HostError('NOT_FOUND', 'Attempt not found');
      assertTransition('attempt', row.state as never, next);
      const at = this.timestamp();
      this.database
        .prepare(
          "UPDATE attempts SET state = ?, grant_id = COALESCE(?, grant_id), effect_started_at = CASE WHEN ? = 'effect_started' THEN ? ELSE effect_started_at END, updated_at = ? WHERE attempt_id = ?",
        )
        .run(next, grantId ?? null, next, at, at, attemptId);
      this.event('attempt', attemptId, eventType, payload);
    });
  }

  recordResult(input: {
    attemptId: string;
    outcome: 'succeeded' | 'failed' | 'outcome_unknown' | 'cancelled';
    result?: unknown;
    errorCode?: string;
  }): void {
    this.transaction(() => {
      const row = this.row(
        'SELECT state, action_id FROM attempts WHERE attempt_id = ?',
        input.attemptId,
      );
      if (!row) throw new HostError('NOT_FOUND', 'Attempt not found');
      assertTransition('attempt', row.state as never, input.outcome);
      const action = this.row(
        'SELECT state FROM actions WHERE action_id = ?',
        row.action_id as string,
      );
      if (!action) throw new HostError('NOT_FOUND', 'Action not found');
      assertTransition('action', action.state as never, input.outcome);
      const at = this.timestamp();
      this.database
        .prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ?')
        .run(input.outcome, at, input.attemptId);
      this.database
        .prepare('UPDATE actions SET state = ?, error_code = ?, updated_at = ? WHERE action_id = ?')
        .run(input.outcome, input.errorCode ?? null, at, row.action_id as string);
      this.database
        .prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          row.action_id as string,
          input.attemptId,
          input.outcome,
          input.result === undefined ? null : JSON.stringify(input.result),
          input.errorCode ?? null,
          at,
        );
      this.event('action', row.action_id as string, 'action.completed', {
        attemptId: input.attemptId,
        outcome: input.outcome,
        errorCode: input.errorCode,
      });
    });
  }

  reconcileExecuting(
    evidence: Record<string, 'not_consumed' | 'no_effect' | 'succeeded' | 'failed' | 'unknown'>,
  ): Array<{ attemptId: string; outcome: AttemptState }> {
    const rows = this.database
      .prepare(
        "SELECT t.attempt_id, t.state FROM attempts t JOIN actions a ON a.action_id = t.action_id WHERE a.state = 'executing' AND t.state IN ('prepared','dispatched','effect_started')",
      )
      .all() as DbRow[];
    const outcomes: Array<{ attemptId: string; outcome: AttemptState }> = [];
    for (const row of rows) {
      const attemptId = String(row.attempt_id);
      const proof = evidence[attemptId] ?? 'unknown';
      if ((proof === 'not_consumed' && row.state === 'prepared') || proof === 'no_effect') {
        this.failBeforeDispatch(attemptId);
        outcomes.push({ attemptId, outcome: 'failed_before_dispatch' });
      } else {
        const outcome =
          proof === 'succeeded' ? 'succeeded' : proof === 'failed' ? 'failed' : 'outcome_unknown';
        this.recordResult({
          attemptId,
          outcome,
          errorCode: outcome === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : undefined,
        });
        outcomes.push({ attemptId, outcome });
      }
    }
    return outcomes;
  }

  private failBeforeDispatch(attemptId: string): void {
    this.transaction(() => {
      const row = this.row('SELECT state, action_id FROM attempts WHERE attempt_id = ?', attemptId);
      if (!row) throw new HostError('NOT_FOUND', 'Attempt not found');
      assertTransition('attempt', row.state as never, 'failed_before_dispatch');
      const at = this.timestamp();
      this.database
        .prepare(
          "UPDATE attempts SET state = 'failed_before_dispatch', updated_at = ? WHERE attempt_id = ?",
        )
        .run(at, attemptId);
      this.database
        .prepare(
          "UPDATE actions SET state = 'failed', error_code = 'FAILED_BEFORE_DISPATCH', updated_at = ? WHERE action_id = ?",
        )
        .run(at, row.action_id as string);
      this.event('action', row.action_id as string, 'action.failed_before_dispatch', { attemptId });
    });
  }

  consumeGrant(
    grant: Pick<ExecutionGrant, 'grantId' | 'attemptId' | 'tabId' | 'fencingToken' | 'expiresAt'>,
  ): boolean {
    try {
      return this.transaction(() => {
        const attempt = this.row(
          'SELECT t.state, t.fencing_token, a.tab_id FROM attempts t JOIN actions a ON a.action_id = t.action_id WHERE t.attempt_id = ?',
          grant.attemptId,
        );
        if (
          !attempt ||
          attempt.state !== 'prepared' ||
          attempt.tab_id !== grant.tabId ||
          Number(attempt.fencing_token) !== grant.fencingToken
        )
          return false;
        this.database
          .prepare('INSERT INTO consumed_grants VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            grant.grantId,
            grant.attemptId,
            grant.tabId,
            grant.fencingToken,
            grant.expiresAt,
            this.timestamp(),
          );
        return true;
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return false;
      throw error;
    }
  }

  resumeSession(credential: ResumeCredential, attachment: ResumeAttachmentInput): number {
    return this.transaction(() => {
      const session = this.row(
        'SELECT * FROM sessions WHERE principal = ? AND agent_id = ?',
        credential.principal,
        credential.agentId,
      );
      if (
        !session ||
        session.state !== 'active' ||
        session.capability_snapshot_hash !== credential.capabilitySnapshotHash
      ) {
        throw new HostError(
          'GRANT_INVALID',
          'Resume identity or capability snapshot does not match',
        );
      }
      if (Number(session.connection_epoch) !== credential.connectionEpoch) {
        throw new HostError('STALE_CONNECTION_EPOCH', 'Resume credential epoch is stale');
      }
      if (Date.parse(credential.expiry) <= this.now().getTime()) {
        throw new HostError('GRANT_EXPIRED', 'Resume credential has expired');
      }
      try {
        this.database
          .prepare('INSERT INTO consumed_resume_nonces VALUES (?, ?, ?)')
          .run(credential.nonce, credential.expiry, this.timestamp());
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
          throw new HostError('STALE_CONNECTION_EPOCH', 'Resume credential was already consumed');
        }
        throw error;
      }
      const nextEpoch = credential.connectionEpoch + 1;
      this.database
        .prepare(
          "UPDATE attachments SET state = 'closed', last_seen_at = ? WHERE session_id = ? AND state IN ('attaching', 'attached', 'detached')",
        )
        .run(this.timestamp(), session.session_id as string);
      const updated = this.database
        .prepare(
          'UPDATE sessions SET connection_epoch = ?, updated_at = ? WHERE session_id = ? AND connection_epoch = ?',
        )
        .run(nextEpoch, this.timestamp(), session.session_id as string, credential.connectionEpoch);
      if (Number(updated.changes) !== 1)
        throw new HostError('STALE_CONNECTION_EPOCH', 'Concurrent resume won the epoch');
      this.database
        .prepare("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, 'attached', ?, ?, ?, ?)")
        .run(
          attachment.attachmentId,
          session.session_id as string,
          credential.principal,
          credential.agentId,
          attachment.role ?? 'owner',
          attachment.leaseExpiresAt,
          nextEpoch,
          this.timestamp(),
          credential.capabilitySnapshotHash,
        );
      this.event('session', session.session_id as string, 'session.resumed', {
        attachmentId: attachment.attachmentId,
        connectionEpoch: nextEpoch,
      });
      return nextEpoch;
    });
  }

  consumeResumeNonce(nonce: string, expiry: string): boolean {
    try {
      this.database
        .prepare('INSERT INTO consumed_resume_nonces VALUES (?, ?, ?)')
        .run(nonce, expiry, this.timestamp());
      return true;
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return false;
      throw error;
    }
  }

  pendingOutbox(limit = 100): Array<{ sequence: number; eventId: string; payload: unknown }> {
    return (
      this.database
        .prepare(
          'SELECT sequence, event_id, payload_json FROM outbox WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT ?',
        )
        .all(limit) as DbRow[]
    ).map((row) => ({
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      payload: JSON.parse(String(row.payload_json)) as unknown,
    }));
  }

  acknowledgeOutbox(sequence: number): void {
    this.database
      .prepare(
        'UPDATE outbox SET acknowledged_at = ? WHERE sequence = ? AND acknowledged_at IS NULL',
      )
      .run(this.timestamp(), sequence);
  }

  getAction(actionId: string): DbRow | undefined {
    return this.row('SELECT * FROM actions WHERE action_id = ?', actionId);
  }

  getAttempt(attemptId: string): DbRow | undefined {
    return this.row('SELECT * FROM attempts WHERE attempt_id = ?', attemptId);
  }

  count(table: 'events' | 'outbox' | 'actions' | 'attempts' | 'results'): number {
    return Number(this.row(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0);
  }
}
