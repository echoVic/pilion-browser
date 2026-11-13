import { expect, it } from 'vitest';
import { approvalAttention } from '../src/renderer/panel/approval-attention';

const approval = (approvalId: string) => ({ approvalId });

it('a new approval asks for attention once; the same pending approval does not ask again', () => {
  const first = approvalAttention(new Set(), [approval('a')]);
  expect(first.fresh).toBe(true);
  // 下一次广播仍带着同一条等待中的审批：用户收起的面板不该再被展开。
  const second = approvalAttention(first.seen, [approval('a')]);
  expect(second.fresh).toBe(false);
});

it('a second approval arriving while the first is pending asks again', () => {
  const first = approvalAttention(new Set(), [approval('a')]);
  const second = approvalAttention(first.seen, [approval('a'), approval('b')]);
  expect(second.fresh).toBe(true);
});

it('forgets settled approvals, and no approvals never asks', () => {
  const first = approvalAttention(new Set(), [approval('a')]);
  const cleared = approvalAttention(first.seen, []);
  expect(cleared.fresh).toBe(false);
  expect([...cleared.seen]).toEqual([]);
});
