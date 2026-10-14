import { CircleAlert, CircleDashed, RefreshCw, Unplug } from 'lucide-react';
import type { ConversationAgentView } from '../../shared/contracts';

type Props = {
  view?: ConversationAgentView;
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * 打开历史对话时恢复原 Agent 的三种状态：
 * - connecting：正在连接，历史消息照常浏览；
 * - unavailable：原 Agent 已被删除/禁用，提示并给出手动换 Agent 入口；
 * - failed/capacity：恢复失败或并发上限，给重试。
 * 一律以主进程快照为准，前端不推断 Agent；重试/换 Agent 都走主进程 IPC。
 */
export function ConversationAgentNotice({ view, busy, run }: Props) {
  if (!view || view.state === 'none' || view.state === 'ready' || view.state === 'running')
    return null;
  const name = view.agentName ?? '原 Agent';
  const retry = () => {
    if (!view.agentId) return;
    void run(() => window.pilion.agents.connect(view.agentId!));
  };

  if (view.state === 'connecting')
    return (
      <div className="composer-notice" role="status" aria-live="polite">
        <CircleDashed size={13} className="spin" />
        <span>正在连接{name}…，历史消息可以先浏览</span>
      </div>
    );

  if (view.state === 'unavailable')
    return (
      <div className="composer-notice" role="status">
        <Unplug size={13} />
        <span>原 Agent（{name}）不可用。在上方选择其他 Agent 不会带上之前的上下文。</span>
      </div>
    );

  return (
    <div className="composer-notice is-danger" role="alert">
      <CircleAlert size={13} />
      <span>
        {view.state === 'capacity'
          ? '并发会话已达上限，该对话暂未恢复连接。'
          : `恢复失败：${view.error ?? '未知错误'}。`}
      </span>
      <button type="button" disabled={busy || !view.agentId} onClick={retry}>
        <RefreshCw size={12} />
        重试
      </button>
    </div>
  );
}
