import { Check } from 'lucide-react';
import type { ApprovalViewState } from '../shared/contracts';
import { isAgentSpace, type BrowserSpace } from '../shared/tab-organization';
import { AGENT_SPACE_STATUS_TEXT, agentSpaceStatus } from './agent-space-status';

type Props = {
  spaces: BrowserSpace[];
  agentClientNames?: Record<string, string>;
  activeSpaceId?: string;
  /** 用来标出「等待确认」：与任务总览同一套状态。 */
  approvals?: readonly ApprovalViewState[];
  run(action: () => Promise<unknown>): Promise<boolean>;
};

export function AgentSpaceGroup({
  spaces,
  agentClientNames,
  activeSpaceId,
  approvals,
  run,
}: Props) {
  const agentSpaces = spaces
    .filter(isAgentSpace)
    .map((space) => ({ space, status: agentSpaceStatus(space, approvals) }))
    .sort((a, b) => {
      const rank = (s: typeof a.status) =>
        s === 'held' ? 0 : s === 'running' || s === 'confirm' ? 1 : s === 'recoverable' ? 2 : 3;
      return rank(a.status) - rank(b.status);
    });
  if (agentSpaces.length === 0) return null;
  const takeOverPermanently = (id: string) => {
    // 永久接管会删掉 Agent 身份，不可逆；只在人明确确认后下发。
    if (!window.confirm('转为我的空间后，Agent 再也无法继续这个空间。标签会保留。')) return;
    void run(() => window.pilion.spaces.takeOverAgent(id, 'permanent'));
  };

  return (
    <div className="space-agent-group" role="group" aria-label="Agent 空间">
      <div className="space-agent-group-header">
        <small>Agent</small>
      </div>
      {agentSpaces.map(({ space, status }) => {
        const agent = space.agent;
        const clientName = agentClientNames?.[agent.clientId] ?? '外部客户端';
        const isHeldByUser = status === 'held';
        const isActive = status === 'running' || status === 'confirm';
        // 交还后是「可恢复态」而非「已结束」：不能落到删除分支，否则 removeEnded 会让 Agent 拿到 SPACE_NOT_FOUND。
        const isHandedBack = status === 'recoverable';
        const isEnded = !isActive && !isHeldByUser && !isHandedBack;
        return (
          <div key={space.id} className={`space-agent-row${isEnded ? ' is-ended' : ''}`}>
            <button
              className="space-agent-main"
              aria-pressed={space.id === activeSpaceId}
              onClick={() => run(() => window.pilion.spaces.select(space.id))}
            >
              <span className="space-agent-label">
                {clientName} · {agent.label}
              </span>
              <span
                className={`space-agent-status ${isActive ? 'active' : isHeldByUser || isHandedBack ? 'held' : 'ended'}`}
              >
                {isActive ? (
                  <>
                    <span className="space-agent-activity" aria-label="Agent 在此空间运行" />
                    {AGENT_SPACE_STATUS_TEXT[status]}
                  </>
                ) : (
                  AGENT_SPACE_STATUS_TEXT[status]
                )}
              </span>
              {space.id === activeSpaceId && <Check size={13} />}
            </button>
            {isActive && (
              <span className="sr-only" role="status">
                Agent 正在「{agent.label}」空间中运行
              </span>
            )}
            <div className="space-agent-actions">
              {isHeldByUser ? (
                <>
                  <button
                    className="space-agent-action is-primary"
                    onClick={() => run(() => window.pilion.spaces.handBackAgent(space.id))}
                  >
                    交还
                  </button>
                  <button
                    className="space-agent-action"
                    onClick={() => takeOverPermanently(space.id)}
                  >
                    转为我的空间…
                  </button>
                  <button
                    className="space-agent-action is-danger"
                    onClick={() => run(() => window.pilion.spaces.remove(space.id))}
                  >
                    删除
                  </button>
                </>
              ) : isActive ? (
                <>
                  <button
                    className="space-agent-action is-primary"
                    title="Agent 会被立即中断，之后可以交还"
                    onClick={() => run(() => window.pilion.spaces.takeOverAgent(space.id))}
                  >
                    接管
                  </button>
                  <button
                    className="space-agent-action"
                    onClick={() => run(() => window.pilion.spaces.select(space.id))}
                  >
                    查看
                  </button>
                  <button
                    className="space-agent-action is-danger"
                    onClick={() => run(() => window.pilion.spaces.stopAgent(space.id))}
                  >
                    停止
                  </button>
                </>
              ) : isHandedBack ? (
                <>
                  <span className="space-agent-recover-note" role="status">
                    已交还，等 Agent 重新连接恢复
                  </span>
                  <button
                    className="space-agent-action is-primary"
                    onClick={() => run(() => window.pilion.spaces.takeOverAgent(space.id))}
                  >
                    再次接管
                  </button>
                  <button
                    className="space-agent-action"
                    onClick={() => takeOverPermanently(space.id)}
                  >
                    转为我的空间…
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="space-agent-action"
                    title="Agent 会被中断，之后可以交还"
                    onClick={() => run(() => window.pilion.spaces.takeOverAgent(space.id))}
                  >
                    接管
                  </button>
                  <button
                    className="space-agent-action"
                    onClick={() => takeOverPermanently(space.id)}
                  >
                    转为我的空间…
                  </button>
                  <button
                    className="space-agent-action is-danger"
                    onClick={() => run(() => window.pilion.spaces.remove(space.id))}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
