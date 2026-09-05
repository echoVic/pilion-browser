import { describe, expect, it } from "vitest";
import {
  ExecutionGrantAuthority,
  HostError,
  ResumeCredentialAuthority,
  type ExecutionGrant,
} from "../src/main/host/index";

const now = new Date("2026-01-01T00:00:00.000Z");
const base = {
  hostInstanceId: "host",
  profileId: "profile",
  sessionId: "session",
  attachmentId: "attachment",
  connectionEpoch: 2,
  tabId: "tab",
  actionId: "action",
  attemptId: "attempt",
  canonicalCommandHash: "command-hash",
  actionDigest: "action-digest",
  capabilitySnapshotHash: "capability-hash",
  policySetVersion: "policy-v1",
  policyVerdict: "allow" as const,
  fencingToken: 8,
  deadline: "2026-01-01T00:00:10.000Z",
  obligations: [{ type: "revalidate_target", parameters: { documentEpoch: "doc" } }],
};
const expected = {
  hostInstanceId: base.hostInstanceId,
  profileId: base.profileId,
  sessionId: base.sessionId,
  attachmentId: base.attachmentId,
  connectionEpoch: base.connectionEpoch,
  tabId: base.tabId,
  actionId: base.actionId,
  attemptId: base.attemptId,
  canonicalCommandHash: base.canonicalCommandHash,
  actionDigest: base.actionDigest,
  capabilitySnapshotHash: base.capabilitySnapshotHash,
  policySetVersion: base.policySetVersion,
};

function codeOf(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return (error as HostError).code; }
  return undefined;
}

describe("ExecutionGrant", () => {
  it("验证 HMAC、epoch、expiry 并执行单次消费", () => {
    const authority = new ExecutionGrantAuthority(Buffer.alloc(32, 7), 5_000);
    const consumed = new Set<string>();
    const store = { consumeGrant: (grant: Pick<ExecutionGrant, "grantId">) => !consumed.has(grant.grantId) && (consumed.add(grant.grantId), true) };
    const grant = authority.issue(base, now);
    expect(authority.verifyAndConsume(grant, expected, store, now)).toBe(grant);
    expect(codeOf(() => authority.verifyAndConsume(grant, expected, store, now))).toBe("GRANT_ALREADY_CONSUMED");

    const fresh = authority.issue({ ...base, grantId: "old-epoch" }, now);
    expect(codeOf(() => authority.verifyAndConsume(fresh, { ...expected, connectionEpoch: 3 }, store, now))).toBe("STALE_CONNECTION_EPOCH");
    expect(codeOf(() => authority.verifyAndConsume(authority.issue({ ...base, grantId: "expired" }, now), expected, store, new Date(now.getTime() + 6_000)))).toBe("GRANT_EXPIRED");
  });

  it("拒绝篡改、未知 obligation 与缺少审批绑定", () => {
    const authority = new ExecutionGrantAuthority(Buffer.alloc(32, 8));
    const store = { consumeGrant: () => true };
    const grant = authority.issue(base, now);
    expect(codeOf(() => authority.verifyAndConsume({ ...grant, tabId: "evil" }, expected, store, now))).toBe("GRANT_INVALID");
    const unknown = authority.issue({ ...base, grantId: "unknown", obligations: [{ type: "future", parameters: {} }] }, now);
    expect(codeOf(() => authority.verifyAndConsume(unknown, expected, store, now))).toBe("GRANT_INVALID");
    expect(() => authority.issue({ ...base, policyVerdict: "require_approval" }, now)).toThrowError(HostError);
  });
});

describe("ResumeCredential", () => {
  it("绑定身份、Host、能力快照和 epoch，nonce 仅消费一次", () => {
    const authority = new ResumeCredentialAuthority(Buffer.alloc(32, 9), 60_000);
    const identity = { principal: "principal", agentId: "agent", hostInstanceId: "host", capabilitySnapshotHash: "caps", connectionEpoch: 4 };
    const credential = authority.issue(identity, now);
    const seen = new Set<string>();
    const store = { consumeResumeNonce: (nonce: string) => !seen.has(nonce) && (seen.add(nonce), true) };
    expect(authority.verifyAndConsume(credential, identity, store, now)).toBe(credential);
    expect(codeOf(() => authority.verifyAndConsume(credential, identity, store, now))).toBe("STALE_CONNECTION_EPOCH");
    const other = authority.issue(identity, now);
    expect(codeOf(() => authority.verifyAndConsume(other, { ...identity, connectionEpoch: 5 }, store, now))).toBe("STALE_CONNECTION_EPOCH");
    const tampered = { ...authority.issue(identity, now), capabilitySnapshotHash: "other" };
    expect(codeOf(() => authority.verifyAndConsume(tampered, identity, store, now))).toBe("GRANT_INVALID");
  });
});
