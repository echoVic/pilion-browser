/**
 * 审批什么时候该把协作面板展开：只在出现了之前没见过的审批时。
 * 仍在等待的旧审批每次状态广播都会带上，它们不算「新的」。
 */
export function approvalAttention(
  seen: ReadonlySet<string>,
  approvals: ReadonlyArray<{ approvalId: string }>,
): { fresh: boolean; seen: ReadonlySet<string> } {
  const current = new Set(approvals.map((approval) => approval.approvalId));
  let fresh = false;
  for (const id of current) if (!seen.has(id)) fresh = true;
  return { fresh, seen: current };
}
