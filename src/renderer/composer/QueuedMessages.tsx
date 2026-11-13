import { Clock, CornerUpLeft, Trash2 } from 'lucide-react';
import type { QueuedMessage } from './queue.js';
import { IconButton } from '../ui';

type Props = {
  queue: readonly QueuedMessage[];
  /** 队列停着不会自动发出的原因；没有时表示等本回合结束。 */
  hold?: string;
  /** 正在把队列交给主进程：这期间不能撤回或删除，免得发出去的和留下的对不上。 */
  locked?: boolean;
  onRecall(id: string): void;
  onRemove(id: string): void;
};

/** 输入框上方的待发队列：运行中攒下的消息，Agent 空闲就绪后合并成一条发出。 */
export function QueuedMessages({ queue, hold, locked = false, onRecall, onRemove }: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="queued-messages" role="status" aria-label={`${queue.length} 条待发消息`}>
      <div className="queued-label">
        <Clock size={11} />
        {hold ?? '待发队列 · 本回合结束后自动合并发出'}
      </div>
      {queue.map((item, index) => (
        <div className="queued-message" key={item.id}>
          <span className="queued-index">{index + 1}</span>
          {item.text ? (
            <span className="queued-text">
              {item.text}
              {item.attachments.length > 0 && <em> · {item.attachments.length} 张图</em>}
            </span>
          ) : (
            <span className="queued-text is-image-only">
              （仅 {item.attachments.length} 张图片）
            </span>
          )}
          <IconButton
            label="撤回回输入框"
            title="撤回回输入框"
            disabled={locked}
            onClick={() => onRecall(item.id)}
          >
            <CornerUpLeft size={13} />
          </IconButton>
          <IconButton label="删除" title="删除" disabled={locked} onClick={() => onRemove(item.id)}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
