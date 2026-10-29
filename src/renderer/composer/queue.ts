import type { PromptAttachment } from '../../shared/contracts.js';

/**
 * 运行中排队的消息。Assistant-ui 在 Agent 运行时禁用了发送，所以这些消息先攒在渲染层：
 * 回合结束（无论成功、失败还是被取消）后由 ConversationPanel 观察 agentStatus 回到非 running，
 * 再把队列合并成一条 dispatchPrompt 发出去。队列状态只放在组件里、按 activeConversationId
 * 隔离（ConversationThread 用 key 重挂载），不落工作区——刷新页面就丢掉，和草稿的命运一致。
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: PromptAttachment[];
}

let nextId = 0;
export function queueId(): string {
  nextId += 1;
  return `q${Date.now().toString(36)}${nextId}`;
}

export function enqueue(
  queue: readonly QueuedMessage[],
  text: string,
  attachments: readonly PromptAttachment[],
): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0) return [...queue];
  return [...queue, { id: queueId(), text: trimmed, attachments: [...attachments] }];
}

/** 撤回：把某条消息退回输入框（从队列删掉），由调用方把文本塞回输入框并保留其附件。 */
export function recall(
  queue: readonly QueuedMessage[],
  id: string,
): { queue: QueuedMessage[]; item?: QueuedMessage } {
  const item = queue.find((entry) => entry.id === id);
  return { queue: queue.filter((entry) => entry.id !== id), item };
}

export function remove(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((entry) => entry.id !== id);
}

/**
 * 合并队列：多条消息用空行接成一条；附件按顺序并起来（主进程会再限一次 ≤5）。
 * 空文本消息只贡献附件。这是回合结束后发送的那条 prompt。
 */
export function mergeQueue(queue: readonly QueuedMessage[]): {
  text: string;
  attachments: PromptAttachment[];
} {
  return {
    text: queue
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join('\n\n'),
    attachments: queue.flatMap((entry) => entry.attachments),
  };
}

/**
 * 等 Agent 从 running 收尾（ready / manual 后的 ready / error）。Cmd+Enter「打断并发送」用它：
 * 先 cancel，再轮询 getState，直到 agentStatus 不再是 running/stopping，才把待发内容交出去。
 * 给一个上限，避免 Agent 死活不收尾时界面永远卡着。
 */
export async function waitUntilIdle(
  getState: () => Promise<{ agentStatus: string }>,
  { timeoutMs = 15_000, intervalMs = 150 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: string;
    try {
      status = (await getState()).agentStatus;
    } catch {
      return;
    }
    if (status !== 'running' && status !== 'stopping') return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
