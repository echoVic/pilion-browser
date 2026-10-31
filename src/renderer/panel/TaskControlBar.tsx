import { useLayoutEffect, useRef, useState } from 'react';
import { CircleStop, MousePointer2, Play } from 'lucide-react';
import type { ConversationTask } from '../../shared/contracts';

type Props = {
  task?: ConversationTask;
  conversationId?: string;
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * 任务控制条：运行中=接管（停止由输入框打断钮与浏览器底条承担，避免两个同名「停止任务」）；
 * 人工=继续任务+停止。常驻滚动区外，与底部浏览器控制条并存（浏览器条继续接管全局动作）。
 */
export function TaskControlBar({ task, conversationId, busy, run }: Props) {
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const control = (action: () => Promise<unknown>) =>
    run(async () => {
      if (!mounted.current || pending) return;
      setPending(true);
      try {
        await action();
      } finally {
        if (mounted.current) setPending(false);
      }
    });
  if (task?.status !== 'running' && task?.status !== 'manual') return null;
  return (
    <div className="task-controls">
      {task.status === 'running' ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => void control(() => window.pilion.agents.takeOver(conversationId))}
        >
          <MousePointer2 size={14} />
          接管
        </button>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || pending}
            onClick={() => void control(() => window.pilion.agents.resume('', conversationId))}
          >
            <Play size={14} />
            继续任务
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || pending}
            onClick={() => void control(() => window.pilion.agents.cancel(conversationId))}
          >
            <CircleStop size={14} />
            停止任务
          </button>
        </>
      )}
    </div>
  );
}
