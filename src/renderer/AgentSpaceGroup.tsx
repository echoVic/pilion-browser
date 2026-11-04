import { Check } from 'lucide-react';
import { isAgentSpace, type BrowserSpace } from '../shared/tab-organization';

type Props = {
  spaces: BrowserSpace[];
  agentClientNames?: Record<string, string>;
  activeSpaceId?: string;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

export function AgentSpaceGroup({ spaces, agentClientNames, activeSpaceId, run }: Props) {
  const agentSpaces = spaces.filter(isAgentSpace);
  if (agentSpaces.length === 0) return null;

  return (
    <div className="space-agent-group" role="group" aria-label="Agent 空间">
      <div className="space-agent-group-header">
        <small>Agent</small>
      </div>
      {agentSpaces.map((space) => {
        const agent = space.agent;
        const clientName = agentClientNames?.[agent.clientId] ?? '外部客户端';
        const isActive = agent.state === 'active';
        return (
          <div key={space.id} className="space-agent-row">
            <button
              className="space-agent-main"
              aria-pressed={space.id === activeSpaceId}
              onClick={() => run(() => window.pilion.spaces.select(space.id))}
            >
              <span className="space-agent-label">
                {clientName} · {agent.label}
              </span>
              <span className={`space-agent-status ${isActive ? 'active' : 'ended'}`}>
                {isActive ? (
                  <>
                    <span className="space-agent-activity" aria-label="Agent 在此空间运行" />
                    AI 操作中
                  </>
                ) : (
                  '已结束'
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
              {isActive ? (
                <>
                  <button
                    className="space-agent-action"
                    onClick={() => run(() => window.pilion.spaces.stopAgent(space.id))}
                  >
                    停止
                  </button>
                  <button
                    className="space-agent-action"
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
                </>
              ) : (
                <>
                  <button
                    className="space-agent-action"
                    onClick={() => run(() => window.pilion.spaces.takeOverAgent(space.id))}
                  >
                    接管
                  </button>
                  <button
                    className="space-agent-action"
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
