import { useEffect, useRef, useState } from 'react';
import { Clock, Plus } from 'lucide-react';
import type { Conversation } from '../../shared/contracts';
import { IconButton } from '../ui';

type Props = {
  conversations: readonly Conversation[];
  activeId?: string;
  approvalsByConversation: Record<string, number>;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * 会话标签行：标签只保留最近活跃会话；「历史对话」按时间倒序列出全部会话。
 * 切换一律走主进程（workspace.selectConversation），前端不猜 Agent。
 */
export function ConversationTabs({ conversations, activeId, approvalsByConversation, run }: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const sorted = [...conversations]
    .filter((item) => item.messages.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (popover.current && !popover.current.contains(event.target as Node)) setHistoryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [historyOpen]);

  const select = (id: string) => {
    setHistoryOpen(false);
    void run(() => window.pilion.workspace.selectConversation(id));
  };

  return (
    <nav className="chat-tabs" aria-label="会话标签">
      <div className="tabs-scroll" role="tablist" aria-label="最近会话">
        {conversations.map((item) => {
          const badge = approvalsByConversation[item.id] ?? 0;
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === activeId}
              className="tab"
              title={item.title}
              onClick={() => select(item.id)}
            >
              {item.title}
              {badge > 0 && (
                <span className="tab-badge" aria-label={`${badge} 项待审批`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div ref={popover} className="history-anchor">
        <IconButton
          label="历史对话"
          title="历史对话"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <Clock size={14} />
        </IconButton>
        {historyOpen && (
          <div className="history-popover" role="menu" aria-label="历史对话">
            {sorted.length === 0 ? (
              <p className="history-empty">还没有可回看的对话</p>
            ) : (
              sorted.map((item) => (
                <button
                  key={item.id}
                  role="menuitem"
                  aria-current={item.id === activeId}
                  title={item.title}
                  onClick={() => select(item.id)}
                >
                  <span className="history-title">{item.title}</span>
                  <span className="history-time">
                    {new Date(item.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <IconButton
        label="新对话"
        title="新对话"
        onClick={() => void run(() => window.pilion.workspace.newConversation())}
      >
        <Plus size={15} />
      </IconButton>
    </nav>
  );
}
