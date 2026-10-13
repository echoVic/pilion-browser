import { CornerUpLeft, Trash2 } from 'lucide-react';
import type { QueuedMessage } from './queue.js';

type Props = {
  queue: readonly QueuedMessage[];
  onRecall(id: string): void;
  onRemove(id: string): void;
};

/** 输入框上方的待发队列：运行中攒下的消息，回合结束合并成一条发出。 */
export function QueuedMessages({ queue, onRecall, onRemove }: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="queued-messages" role="status" aria-label={`${queue.length} 条待发消息`}>
      {queue.map((item, index) => (
        <div className="queued-message" key={item.id}>
          <span className="queued-index">{index + 1}</span>
          <span className="queued-text">
            {item.text || '(仅图片)'}
            {item.attachments.length > 0 && (
              <em> · {item.attachments.length} 张图</em>
            )}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="撤回回输入框"
            title="撤回回输入框"
            onClick={() => onRecall(item.id)}
          >
            <CornerUpLeft size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="删除"
            title="删除"
            onClick={() => onRemove(item.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
