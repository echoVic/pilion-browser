import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalCborEncode } from './canonical.js';
import { HostError } from './types.js';

export interface ExecutionGrant {
  schemaVersion: '1';
  grantId: string;
  hostInstanceId: string;
  profileId: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  tabId: string;
  actionId: string;
  attemptId: string;
  canonicalCommandHash: string;
  actionDigest: string;
  capabilitySnapshotHash: string;
  policySetVersion: string;
  policyVerdict: 'allow' | 'require_approval';
  approvalId?: string;
  approvalDigest?: string;
  fencingToken: number;
  issuedAt: string;
  deadline: string;
  expiresAt: string;
  obligations: Array<{ type: string; parameters: Record<string, unknown> }>;
  signature: string;
}

export type UnsignedExecutionGrant = Omit<
  ExecutionGrant,
  'schemaVersion' | 'grantId' | 'issuedAt' | 'expiresAt' | 'signature'
> & {
  schemaVersion?: '1';
  grantId?: string;
  issuedAt?: string;
  expiresAt?: string;
};

export interface GrantExpectation {
  hostInstanceId: string;
  profileId: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  tabId: string;
  actionId: string;
  attemptId: string;
  canonicalCommandHash: string;
  actionDigest: string;
  capabilitySnapshotHash: string;
  policySetVersion: string;
  minFencingTokenExclusive?: number;
}

export interface GrantConsumptionStore {
  consumeGrant(
    grant: Pick<ExecutionGrant, 'grantId' | 'attemptId' | 'tabId' | 'fencingToken' | 'expiresAt'>,
  ): boolean;
}

const grantKeys = [
  'schemaVersion',
  'grantId',
  'hostInstanceId',
  'profileId',
  'sessionId',
  'attachmentId',
  'connectionEpoch',
  'tabId',
  'actionId',
  'attemptId',
  'canonicalCommandHash',
  'actionDigest',
  'capabilitySnapshotHash',
  'policySetVersion',
  'policyVerdict',
  'approvalId',
  'approvalDigest',
  'fencingToken',
  'issuedAt',
  'deadline',
  'expiresAt',
  'obligations',
  'signature',
] as const;

const obligationFields: Record<string, readonly string[]> = {
  revalidate_target: ['documentEpoch', 'frameEpoch', 'localFingerprint'],
  trusted_approval: ['approvalDigest'],
  https_only: [],
};

function mac(key: Buffer, value: unknown): string {
  return createHmac('sha256', key).update(canonicalCborEncode(value)).digest('base64url');
}

function unsignedGrant(grant: ExecutionGrant): Omit<ExecutionGrant, 'signature'> {
  const unsigned: Partial<ExecutionGrant> = { ...grant };
  delete unsigned.signature;
  return unsigned as Omit<ExecutionGrant, 'signature'>;
}

function decodeCanonicalBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

function secureEqual(left: unknown, right: unknown): boolean {
  const a = decodeCanonicalBase64Url(left);
  const b = decodeCanonicalBase64Url(right);
  return a !== undefined && b !== undefined && a.length === b.length && timingSafeEqual(a, b);
}

function validDate(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result))
    throw new HostError('GRANT_INVALID', 'Grant contains an invalid timestamp');
  return result;
}

export class ExecutionGrantAuthority {
  constructor(
    private readonly key = randomBytes(32),
    private readonly ttlMs = 15_000,
  ) {
    if (key.length < 32) throw new TypeError('ExecutionGrant HMAC key must be at least 256 bits');
  }

  issue(input: UnsignedExecutionGrant, now = new Date()): ExecutionGrant {
    const issuedAt = input.issuedAt ?? now.toISOString();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.ttlMs).toISOString();
    const unsigned: Omit<ExecutionGrant, 'signature'> = {
      ...input,
      schemaVersion: '1',
      grantId: input.grantId ?? randomUUID(),
      issuedAt,
      expiresAt,
    };
    if (
      unsigned.policyVerdict === 'require_approval' &&
      (!unsigned.approvalId || !unsigned.approvalDigest)
    ) {
      throw new HostError('GRANT_INVALID', 'Approval-bound grant is missing approval evidence');
    }
    return { ...unsigned, signature: mac(this.key, unsigned) };
  }

  verifyAndConsume(
    grant: ExecutionGrant,
    expected: GrantExpectation,
    consumption: GrantConsumptionStore,
    now = new Date(),
  ): ExecutionGrant {
    if (
      !grant ||
      typeof grant !== 'object' ||
      Object.keys(grant).some((key) => !grantKeys.includes(key as (typeof grantKeys)[number]))
    ) {
      throw new HostError('GRANT_INVALID', 'Grant schema has unknown fields');
    }
    if (
      grant.schemaVersion !== '1' ||
      !secureEqual(grant.signature, mac(this.key, unsignedGrant(grant)))
    ) {
      throw new HostError('GRANT_INVALID', 'Grant signature is invalid');
    }
    const nowMs = now.getTime();
    if (
      validDate(grant.expiresAt) <= nowMs ||
      validDate(grant.deadline) <= nowMs ||
      validDate(grant.issuedAt) > nowMs + 5_000
    ) {
      throw new HostError('GRANT_EXPIRED', 'Grant is expired or not yet valid');
    }
    for (const key of Object.keys(expected) as Array<keyof GrantExpectation>) {
      if (key === 'minFencingTokenExclusive') continue;
      if (grant[key as keyof ExecutionGrant] !== expected[key]) {
        const code = key === 'connectionEpoch' ? 'STALE_CONNECTION_EPOCH' : 'GRANT_INVALID';
        throw new HostError(code, `Grant binding mismatch: ${key}`);
      }
    }
    if (
      expected.minFencingTokenExclusive !== undefined &&
      grant.fencingToken <= expected.minFencingTokenExclusive
    ) {
      throw new HostError('GRANT_INVALID', 'Stale fencing token');
    }
    for (const obligation of grant.obligations) {
      const allowed = obligationFields[obligation.type];
      if (
        !allowed ||
        Object.keys(obligation.parameters).some((field) => !allowed.includes(field))
      ) {
        throw new HostError('GRANT_INVALID', `Unknown or malformed obligation: ${obligation.type}`);
      }
    }
    if (!consumption.consumeGrant(grant)) {
      throw new HostError('GRANT_ALREADY_CONSUMED', 'ExecutionGrant was already consumed');
    }
    return grant;
  }
}

export interface ResumeCredential {
  principal: string;
  agentId: string;
  hostInstanceId: string;
  capabilitySnapshotHash: string;
  connectionEpoch: number;
  expiry: string;
  nonce: string;
  mac: string;
}

export interface ResumeExpectation {
  principal: string;
  agentId: string;
  hostInstanceId: string;
  capabilitySnapshotHash: string;
  connectionEpoch: number;
}

export interface ResumeNonceStore {
  consumeResumeNonce(nonce: string, expiry: string): boolean;
}

export interface ResumeAttachmentInput {
  attachmentId: string;
  leaseExpiresAt: string;
  role?: 'owner' | 'observer';
}

export interface ResumeCommitStore {
  resumeSession(credential: ResumeCredential, attachment: ResumeAttachmentInput): number;
}

export class ResumeCredentialAuthority {
  constructor(
    private readonly key = randomBytes(32),
    private readonly ttlMs = 60_000,
  ) {
    if (key.length < 32) throw new TypeError('ResumeCredential HMAC key must be at least 256 bits');
  }

  issue(identity: ResumeExpectation, now = new Date()): ResumeCredential {
    const unsigned = {
      ...identity,
      expiry: new Date(now.getTime() + this.ttlMs).toISOString(),
      nonce: randomBytes(24).toString('base64url'),
    };
    return { ...unsigned, mac: mac(this.key, unsigned) };
  }

  verify(
    credential: ResumeCredential,
    expected: ResumeExpectation,
    now = new Date(),
  ): ResumeCredential {
    const { mac: suppliedMac, ...unsigned } = credential;
    if (!secureEqual(suppliedMac, mac(this.key, unsigned))) {
      throw new HostError('GRANT_INVALID', 'Resume credential MAC is invalid');
    }
    if (Date.parse(credential.expiry) <= now.getTime()) {
      throw new HostError('GRANT_EXPIRED', 'Resume credential has expired');
    }
    for (const key of Object.keys(expected) as Array<keyof ResumeExpectation>) {
      if (credential[key] !== expected[key]) {
        const code = key === 'connectionEpoch' ? 'STALE_CONNECTION_EPOCH' : 'GRANT_INVALID';
        throw new HostError(code, `Resume credential mismatch: ${key}`);
      }
    }
    return credential;
  }

  verifyAndConsume(
    credential: ResumeCredential,
    expected: ResumeExpectation,
    nonces: ResumeNonceStore,
    now = new Date(),
  ): ResumeCredential {
    this.verify(credential, expected, now);
    if (!nonces.consumeResumeNonce(credential.nonce, credential.expiry)) {
      throw new HostError('STALE_CONNECTION_EPOCH', 'Resume credential was already consumed');
    }
    return credential;
  }

  verifyAndResume(
    credential: ResumeCredential,
    expected: ResumeExpectation,
    store: ResumeCommitStore,
    attachment: ResumeAttachmentInput,
    now = new Date(),
  ): number {
    this.verify(credential, expected, now);
    return store.resumeSession(credential, attachment);
  }
}
