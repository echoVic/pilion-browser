export type SessionState = "creating" | "active" | "draining" | "closed" | "failed";
export type AttachmentState =
  | "attaching"
  | "attached"
  | "detached"
  | "expired"
  | "closed"
  | "failed";
export type ActionState =
  | "created"
  | "queued"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "stale";
export type AttemptState =
  | "prepared"
  | "dispatched"
  | "effect_started"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "failed_before_dispatch";
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "stale";
export type EffectLevel =
  | "pure-observe"
  | "viewport-mutating"
  | "page-mutating"
  | "external-side-effect";

export interface Session {
  sessionId: string;
  profileId: string;
  principal: string;
  agentId: string;
  state: SessionState;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  attachmentId: string;
  sessionId: string;
  principal: string;
  agentId: string;
  role: "owner" | "observer";
  state: AttachmentState;
  leaseExpiresAt: string;
  connectionEpoch: number;
  lastSeenAt: string;
  capabilitySnapshotHash: string;
}

export interface Action {
  actionId: string;
  sessionId: string;
  attachmentId: string;
  tabId: string;
  state: ActionState;
  canonicalCommandHash: string;
  actionDigest: string;
  idempotencyKey: string;
  policySetVersion: string;
  policyVerdict: "allow" | "require_approval" | "deny";
}

export interface Attempt {
  attemptId: string;
  actionId: string;
  state: AttemptState;
  fencingToken: number;
  preparedMarker: string;
  effectStartedAt?: string;
}

export interface Approval {
  approvalId: string;
  actionId: string;
  state: ApprovalState;
  nonce: string;
  expiresAt: string;
  actionDigest: string;
  approvalDigest?: string;
}

export type HostErrorCode =
  | "INVALID_STATE_TRANSITION"
  | "STALE_CONNECTION_EPOCH"
  | "GRANT_INVALID"
  | "GRANT_EXPIRED"
  | "GRANT_ALREADY_CONSUMED"
  | "APPROVAL_ALREADY_RESOLVED"
  | "APPROVAL_STALE"
  | "POLICY_DENIED"
  | "LEASE_EXPIRED"
  | "OUTCOME_UNKNOWN"
  | "NOT_FOUND";

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}
