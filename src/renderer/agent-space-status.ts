import type { ApprovalViewState } from '../shared/contracts';
import type { AgentBrowserSpace } from '../shared/tab-organization';

/**
 * Agent 空间此刻处于哪一步。侧栏的 Agent 空间组、空间切换器的接管条和任务总览都从这里取，
 * 同一个空间在几处不会说出两种状态。
 *
 * - held：人临时接管了，等交还；优先于其它一切。
 * - confirm：Agent 在跑，但有一条这个空间的审批在等人。
 * - running：Agent 在跑。
 * - recoverable：人交还后 Agent 还没重新连上，可恢复，不能当已结束删掉。
 * - ended：停止、空闲回收、重启、关闭等真正结束的空间。
 */
export type AgentSpaceStatus = 'held' | 'confirm' | 'running' | 'recoverable' | 'ended';

export const AGENT_SPACE_STATUS_TEXT: Record<AgentSpaceStatus, string> = {
  held: '已接管 · 待交还',
  confirm: '等待确认',
  running: '运行中',
  recoverable: '已交还 · 可恢复',
  ended: '已结束',
};

export function agentSpaceStatus(
  space: AgentBrowserSpace,
  approvals: readonly Pick<ApprovalViewState, 'state' | 'spaceId'>[] = [],
): AgentSpaceStatus {
  const agent = space.agent;
  if (agent.takenOverAt !== undefined) return 'held';
  if (agent.state === 'active')
    return approvals.some(
      (approval) => approval.state === 'pending' && approval.spaceId === space.id,
    )
      ? 'confirm'
      : 'running';
  return agent.endReason === 'handed_back' ? 'recoverable' : 'ended';
}
