export type SessionState = 'creating' | 'active' | 'draining' | 'closed' | 'failed';
export type AttachmentState =
  'attaching' | 'attached' | 'detached' | 'expired' | 'closed' | 'failed';
export type ActionState =
  | 'created'
  | 'queued'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
  | 'stale';
export type AttemptState =
  | 'prepared'
  | 'dispatched'
  | 'effect_started'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
  | 'failed_before_dispatch';
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'stale';
export type EffectLevel =
  'pure-observe' | 'viewport-mutating' | 'page-mutating' | 'external-side-effect';

export type HostErrorCode =
  | 'INVALID_STATE_TRANSITION'
  | 'STALE_CONNECTION_EPOCH'
  | 'GRANT_INVALID'
  | 'GRANT_EXPIRED'
  | 'GRANT_ALREADY_CONSUMED'
  | 'APPROVAL_ALREADY_RESOLVED'
  | 'APPROVAL_STALE'
  | 'POLICY_DENIED'
  | 'LEASE_EXPIRED'
  | 'OUTCOME_UNKNOWN'
  | 'NOT_FOUND';

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}
