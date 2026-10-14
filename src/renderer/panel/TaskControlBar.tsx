import { CircleStop, Play, UserCheck } from 'lucide-react';
import type { ConversationTask } from '../../shared/contracts';

type Props = {
  task?: ConversationTask;
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/**
 * 任务控制条：运行中=接管+停止；人工=继续任务+停止。常驻滚动区外，
 * 与底部浏览器控制条并存（浏览器条继续接管全局动作）。
 */
export function TaskControlBar({ task, busy, run }: Props) {
  if (task?.status !== 'running' && task?.status !== 'manual') return null;
  return (
    <div className="task-controls">
      {task.status === 'running' ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run(() => window.pilion.agents.takeOver())}
        >
          <UserCheck size={14} />
          接管
        </button>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(() => window.pilion.agents.resume())}
          >
            <Play size={14} />
            继续任务
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void run(() => window.pilion.agents.cancel())}
          >
            <CircleStop size={14} />
            停止任务
          </button>
        </>
      )}
    </div>
  );
}
