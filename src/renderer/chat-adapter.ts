import { MessageNotSentError, type ThreadMessageLike } from '@assistant-ui/react';
import type { AppState, ConversationMessage, PromptAttachment } from '../shared/contracts';
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
  conversationId?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) throw new MessageNotSentError('对话已切换，消息未发送');
  let before;
  try {
    before = await api.getState();
  } catch (error) {
    throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
  }
  const cid = conversationId ?? before.activeConversationId;
  const checkCurrent = (snapshot?: AppState) => {
    if (!isCurrent() || (snapshot && snapshot.activeConversationId !== cid))
      throw new MessageNotSentError('对话已切换，消息未发送');
  };
  const readCurrent = async () => {
    checkCurrent();
    let snapshot;
    try {
      snapshot = await api.getState();
    } catch (error) {
      throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
    }
    checkCurrent(snapshot);
    return snapshot;
  };
  checkCurrent(before);
  const previousIds = new Set(
    before.conversations?.find((item) => item.id === cid)?.messages.map((message) => message.id),
  );
  const current = await readCurrent();
  checkCurrent(current);
  if (current.agentStatus !== 'ready') throw new MessageNotSentError('Agent 尚未就绪');
  const resuming =
    current.conversations?.find((item) => item.id === cid)?.task?.status === 'manual';
  if (current.attachmentStatus !== 'attached' && !resuming) {
    try {
      checkCurrent(current);
      await api.agents.attach(cid);
      checkCurrent();
    } catch (error) {
      throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
    }
    const attached = await readCurrent();
    checkCurrent(attached);
    if (attached.agentStatus !== 'ready') throw new MessageNotSentError('Agent 尚未就绪');
  }
  checkCurrent();
  try {
    // 附件只随新任务发送；继续人工任务（resume）沿用纯文字补充说明，图片不附。
    if (resuming) await api.agents.resume(text, cid);
    else await api.agents.task(text, attachments.length ? [...attachments] : undefined, cid);
  } catch (error) {
    // A submitted turn still belongs to cid, even if its completion arrives while viewing B.
    const after = await api.getState();
    const accepted = after.conversations
      ?.find((item) => item.id === cid)
      ?.messages.some(
        (message) =>
          message.role === 'user' && message.text === text && !previousIds.has(message.id),
      );
    if (!accepted)
      throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
