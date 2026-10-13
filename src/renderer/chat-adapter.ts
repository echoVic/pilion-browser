import { MessageNotSentError, type ThreadMessageLike } from '@assistant-ui/react';
import type { ConversationMessage, PromptAttachment } from '../shared/contracts';
import type { PilionApi } from '../preload/index';

export function toThreadMessage(message: ConversationMessage): ThreadMessageLike {
  const common = {
    id: message.id,
    createdAt: new Date(message.time),
    metadata: { custom: { kind: message.role, status: message.status } },
  };
  if (message.role === 'user' || message.role === 'system')
    return { ...common, role: message.role, content: message.text };
  const status: ThreadMessageLike['status'] =
    message.status === 'running'
      ? { type: 'running' }
      : message.status === 'failed'
        ? { type: 'incomplete', reason: 'error' }
        : message.status === 'cancelled'
          ? { type: 'incomplete', reason: 'cancelled' }
          : { type: 'complete', reason: 'stop' };
  const content: ThreadMessageLike['content'] =
    message.role === 'thought'
      ? [{ type: 'reasoning', text: message.text }]
      : message.role === 'tool'
        ? [
            {
              type: 'tool-call',
              toolCallId: message.id,
              toolName: message.text,
              args: {},
              ...(message.status && message.status !== 'running'
                ? { result: message.status, isError: message.status === 'failed' }
                : {}),
            },
          ]
        : [{ type: 'text', text: message.text }];
  return { ...common, role: 'assistant', content, status };
}

/** Only restore drafts when the main process never accepted the user message. */
export async function dispatchPrompt(
  api: PilionApi,
  text: string,
  attachments: readonly PromptAttachment[] = [],
): Promise<void> {
  let before;
  try {
    before = await api.getState();
  } catch (error) {
    throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
  }
  const previousIds = new Set(
    before.conversations?.flatMap((item) => item.messages.map((message) => message.id)),
  );
  if (before.agentStatus !== 'ready') throw new MessageNotSentError('Agent 尚未就绪');
  const resuming =
    before.conversations?.find((item) => item.id === before.activeConversationId)?.task?.status ===
    'manual';
  if (before.attachmentStatus !== 'attached' && !resuming) {
    try {
      await api.agents.attach();
    } catch (error) {
      throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    // 附件只随新任务发送；继续人工任务（resume）沿用纯文字补充说明，图片不附。
    // 附件只随新任务发送；没有附件时不传第二参，保持既有调用形状。
    if (resuming) await api.agents.resume(text);
    else if (attachments.length) await api.agents.task(text, [...attachments]);
    else await api.agents.task(text);
  } catch (error) {
    const after = await api.getState();
    const accepted = after.conversations?.some((item) =>
      item.messages.some(
        (message) =>
          message.role === 'user' && message.text === text && !previousIds.has(message.id),
      ),
    );
    if (!accepted)
      throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
