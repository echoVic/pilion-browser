import type { ReactNode } from 'react';
import { ChevronRight, MessageSquare, Plus } from 'lucide-react';
import type { AppState, Conversation } from '../shared/contracts';

/**
 * 「对话记录」页。多会话下别的对话在跑不妨碍新建或切换（主进程照常接受），
 * 所以这里不因 Agent 忙而禁用；正在跑的对话在行内标出来。
 */
export function ConversationLibrary({
  state,
  conversations,
  native,
  run,
  onOpened,
  search,
  empty,
}: {
  state: AppState;
  /** 已按搜索词筛过、且有消息的对话。 */
  conversations: readonly Conversation[];
  native: boolean;
  run(action: () => Promise<unknown>): Promise<boolean>;
  /** 新建或切换成功后：展开面板、回到浏览器。 */
  onOpened(): void;
  search: ReactNode;
  /** 有对话但一条都没筛中时显示。 */
  empty: ReactNode;
}) {
  return (
    <div className="library-surface">
      <header className="surface-header">
        <h1>对话记录</h1>
        <button
          className="secondary-button"
          disabled={!native}
          onClick={async () => {
            if (await run(() => window.pilion.workspace.newConversation())) onOpened();
          }}
        >
          <Plus size={16} />
          新对话
        </button>
      </header>
      {search}
      {conversations.map((item) => (
        <button
          className="library-row"
          key={item.id}
          onClick={async () => {
            if (await run(() => window.pilion.workspace.selectConversation(item.id))) onOpened();
          }}
        >
          <MessageSquare size={18} />
          <div>
            <strong>
              <span className="library-row-title">{item.title}</span>
              {item.task?.status === 'running' ? (
                <span
                  className="conversation-running"
                  title="Agent 正在后台运行"
                  aria-label="Agent 正在运行"
                >
                  ●
                </span>
              ) : null}
            </strong>
            <span>
              {state.agents.find((agent) => agent.id === item.agentId)?.name ?? 'Agent'} ·{' '}
              {new Date(item.updatedAt).toLocaleDateString()}
            </span>
          </div>
          {(state.pendingApprovalsByConversation?.[item.id] ?? 0) > 0 ? (
            <span
              className="conversation-approval-badge"
              title="有待审批"
              aria-label={`${state.pendingApprovalsByConversation[item.id]} 条待审批`}
            >
              {state.pendingApprovalsByConversation[item.id]}
            </span>
          ) : null}
          <ChevronRight size={16} className="library-row-trailing" />
        </button>
      ))}
      {!state.conversations?.some((item) => item.messages.length) ? (
        <div className="empty-list">
          <MessageSquare size={26} />
          <h2>还没有对话记录</h2>
          <p>发起一个新对话，Agent 会在这里帮你研究、整理和操作网页。</p>
        </div>
      ) : (
        !conversations.length && empty
      )}
    </div>
  );
}
