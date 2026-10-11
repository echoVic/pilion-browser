import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentLease } from '../src/main/host/attachment-lease';
import { DurableHostStore } from '../src/main/host/durable-store';

const minute = 60_000;
const start = new Date('2026-01-01T00:00:00.000Z');
const stores: DurableHostStore[] = [];

function setup() {
  const store = new DurableHostStore({ path: ':memory:', now: () => new Date(Date.now()) });
  stores.push(store);
  store.createSession({
    sessionId: 'session',
    profileId: 'profile',
    principal: 'agent',
    agentId: 'agent',
    connectionEpoch: 1,
    capabilitySnapshotHash: 'caps',
  });
  store.createAttachment({
    attachmentId: 'attachment',
    sessionId: 'session',
    principal: 'agent',
    agentId: 'agent',
    role: 'owner',
    connectionEpoch: 1,
    capabilitySnapshotHash: 'caps',
    leaseExpiresAt: '2026-01-01T01:00:00.000Z',
  });
  let active = false;
  const lease = new AttachmentLease({
    leaseExpiresAt: start.getTime() + 60 * minute,
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
    isActive: () => active,
    renew: (deadline) => store.renewAttachment('attachment', new Date(deadline).toISOString()),
    expire: () => store.transitionAttachment('attachment', 'expired'),
  });
  const attachment = () => store.database.prepare('SELECT * FROM attachments').get();
  const renewals = () =>
    store.database.prepare("SELECT * FROM events WHERE event_type = 'attachment.renewed'").all();
  const access = () =>
    store.assertAttachmentAccess({
      sessionId: 'session',
      attachmentId: 'attachment',
      principal: 'agent',
      connectionEpoch: 1,
    });
  return {
    lease,
    attachment,
    renewals,
    access,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe('Attachment 空闲 lease', () => {
  it('活跃工作结束后获得完整的 60 分钟空闲窗口', () => {
    const run = setup();
    run.setActive(true);
    const finish = run.lease.beginActivity();
    vi.advanceTimersByTime(117 * minute + 59_000);
    run.setActive(false);
    finish();
    vi.advanceTimersByTime(60 * minute - 1);
    expect(run.attachment()?.state).toBe('attached');
    expect(() => run.access()).not.toThrow();
    vi.advanceTimersByTime(1);
    expect(run.attachment()?.state).toBe('expired');
  });

  it('stop 后迟到的工作结束回调不会续租', () => {
    const run = setup();
    const finish = run.lease.beginActivity();
    run.lease.stop();
    vi.advanceTimersByTime(2 * minute);
    finish();
    expect(run.renewals()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('空闲 60 分钟才过期', () => {
    const run = setup();
    vi.advanceTimersByTime(60 * minute - 1);
    expect(run.attachment()?.state).toBe('attached');
    vi.advanceTimersByTime(1);
    expect(run.attachment()?.state).toBe('expired');
  });

  it('第 59 分钟活动将过期时间移到第 119 分钟', () => {
    const run = setup();
    vi.advanceTimersByTime(59 * minute);
    run.lease.activity();
    vi.advanceTimersByTime(60 * minute - 1);
    expect(run.attachment()?.state).toBe('attached');
    expect(run.attachment()?.lease_expires_at).toBe('2026-01-01T01:59:00.000Z');
    vi.advanceTimersByTime(1);
    expect(run.attachment()?.state).toBe('expired');
  });

  it('截止时 prompt 仍在运行则续租，store 在原截止后仍可访问', () => {
    const run = setup();
    run.setActive(true);
    run.lease.activity();
    vi.advanceTimersByTime(60 * minute);
    expect(run.renewals()).toHaveLength(1);
    expect(() => run.access()).not.toThrow();
    vi.advanceTimersByTime(120 * minute);
    expect(() => run.access()).not.toThrow();
    run.setActive(false);
    vi.advanceTimersByTime(60 * minute);
    expect(run.attachment()?.state).toBe('expired');
  });

  it('距上次续租不足一分钟不写库，但保留最后活动的截止时间', () => {
    const run = setup();
    vi.advanceTimersByTime(2 * minute);
    run.lease.activity();
    expect(run.renewals()).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    run.lease.activity();
    vi.advanceTimersByTime(29_999);
    expect(run.renewals()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(run.renewals()).toHaveLength(2);
    expect(run.attachment()?.lease_expires_at).toBe('2026-01-01T01:02:30.000Z');
    vi.advanceTimersByTime(59.5 * minute - 1);
    expect(run.attachment()?.state).toBe('attached');
    vi.advanceTimersByTime(1);
    expect(run.attachment()?.state).toBe('expired');
  });

  it('stop 取消计时器，后续活动不会重新启动', () => {
    const run = setup();
    expect(vi.getTimerCount()).toBe(1);
    run.lease.stop();
    expect(vi.getTimerCount()).toBe(0);
    run.lease.activity();
    vi.advanceTimersByTime(120 * minute);
    expect(run.renewals()).toHaveLength(0);
    expect(run.attachment()?.state).toBe('attached');
    expect(vi.getTimerCount()).toBe(0);
  });
});
