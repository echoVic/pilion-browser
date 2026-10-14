import { CircleAlert, CircleDashed, RefreshCw, Unplug } from 'lucide-react';
import type { ConversationAgentView, AgentConfig } from '../../shared/contracts';

type Props = {
  view?: ConversationAgentView;
  agents?: AgentConfig[];
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * 打开历史对话时恢复原 Agent 的状态横幅：
 * - connecting：正在连接，历史消息照常浏览；
 * - unavailable：原 Agent 已被删除/禁用，提供手动换 Agent 入口；
 * - failed/capacity：恢复失败或并发上限，给重试；
 * - ready/running 且带 notice：显示上下文丢失提示。
 * 一律以主进程快照为准，前端不推断 Agent；重试/换 Agent 都走主进程 IPC。
 */
export function ConversationAgentNotice({ view, agents, busy, run }: Props) {
  if (!view || view.state === 'none') return null;
  const name = view.agentName ?? '原 Agent';

  // ready/running 状态下的上下文丢失提示
  if (view.state === 'ready' || view.state === 'running') {
    if (!view.notice) return null;
    const text =
      view.notice === 'new_session_no_context'
        ? `已用 ${name} 新会话继续，之前的上下文未带入`
        : '会话已重置，之前的上下文未带入';
    return (
      <div className="composer-notice" role="status">
        <span>{text}</span>
      </div>
    );
  }

  const retry = () => {
    void run(() => window.pilion.agents.retryConversation(view.conversationId));
  };

  const switchAgent = (agentId: string) => {
    void run(() => window.pilion.agents.useAgentForConversation(view.conversationId, agentId));
  };

  if (view.state === 'connecting')
    return (
      <div className="composer-notice" role="status" aria-live="polite">
        <CircleDashed size={13} className="spin" />
        <span>正在连接{name}…，历史消息可以先浏览</span>
      </div>
    );

  if (view.state === 'unavailable') {
    const availableAgents = (agents ?? []).filter((a) => a.enabled && a.id !== view.agentId);
    return (
      <div className="composer-notice is-warn" role="alert">
        <Unplug size={13} />
        <span>原 Agent（{name}）不可用。选择其他 Agent 不会带上之前的上下文。</span>
        {availableAgents.length > 0 && (
          <select
            aria-label="为对话选择其他 Agent"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) switchAgent(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">选择其他 Agent…</option>
            {availableAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  return (
    <div className="composer-notice is-danger" role="alert">
      <CircleAlert size={13} />
      <span>
        {view.state === 'capacity'
          ? '并发会话已达上限，该对话暂未恢复连接。'
          : `恢复失败：${view.error ?? '未知错误'}。`}
      </span>
      <button type="button" disabled={busy} onClick={retry}>
        <RefreshCw size={12} />
        重试
      </button>
    </div>
  );
}
