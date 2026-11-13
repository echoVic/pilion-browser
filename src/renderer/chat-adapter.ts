import { MessageNotSentError, type ThreadMessageLike } from '@assistant-ui/react';
import type { AppState, ConversationMessage, PromptAttachment } from '../shared/contracts';
import type { PilionApi } from '../preload/index';
import { failureText } from './ui';

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

/**
 * 把一条消息交给主进程。主进程没收下（还没把用户消息记进历史）时抛 MessageNotSentError，
 * 调用方据此原样保留输入；收下后再失败则抛原错误。onAccepted 在主进程收下的那一刻调用一次——
 * task/resume 要等整个回合结束才返回，输入框不能干等到那时才清。
 */
export async function dispatchPrompt(
  api: PilionApi,
  text: string,
  attachments: readonly PromptAttachment[] = [],
  conversationId?: string,
  isCurrent: () => boolean = () => true,
  onAccepted?: () => void,
): Promise<void> {
  if (!isCurrent()) throw new MessageNotSentError('对话已切换，消息未发送');
  let before;
  try {
    before = await api.getState();
  } catch (error) {
    throw new MessageNotSentError(failureText(error));
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
      throw new MessageNotSentError(failureText(error));
    }
    checkCurrent(snapshot);
    return snapshot;
  };
  checkCurrent(before);
  const previousIds = new Set(
    before.conversations?.find((item) => item.id === cid)?.messages.map((message) => message.id),
  );
  // A submitted turn still belongs to cid, even if its acceptance arrives while viewing B.
  const acceptedIn = (snapshot: AppState) =>
    snapshot.conversations
      ?.find((item) => item.id === cid)
      ?.messages.some(
        (message) =>
          message.role === 'user' &&
          message.text.trim() === text.trim() &&
          !previousIds.has(message.id),
      ) ?? false;
  const current = await readCurrent();
  checkCurrent(current);
  if (current.agentStatus !== 'ready') throw new MessageNotSentError('Agent 尚未就绪');
  const resuming =
    current.conversations?.find((item) => item.id === cid)?.task?.status === 'manual';
  // 继续人工任务（resume）只收文字补充说明：主进程不接图片，发出去会被静默丢掉，所以先拦下。
  if (resuming && attachments.length)
    throw new MessageNotSentError('继续任务时不能附带图片，请先移除图片再发送');
  if (current.attachmentStatus !== 'attached' && !resuming) {
    try {
      checkCurrent(current);
      await api.agents.attach(cid);
      checkCurrent();
    } catch (error) {
      throw new MessageNotSentError(failureText(error));
    }
    const attached = await readCurrent();
    checkCurrent(attached);
    if (attached.agentStatus !== 'ready') throw new MessageNotSentError('Agent 尚未就绪');
  }
  checkCurrent();
  let accepted = false;
  const accept = () => {
    if (accepted) return;
    accepted = true;
    onAccepted?.();
  };
  // 主进程记下用户消息后会立刻广播一次状态；从那一刻起算「已收下」，不等回合结束。
  const stopWatching =
    onAccepted && typeof api.onState === 'function'
      ? api.onState((snapshot) => {
          if (acceptedIn(snapshot)) accept();
        })
      : undefined;
  try {
    if (resuming) await api.agents.resume(text, cid);
    else await api.agents.task(text, attachments.length ? [...attachments] : undefined, cid);
    accept();
  } catch (error) {
    let after: AppState | undefined;
    try {
      after = await api.getState();
    } catch {
      after = undefined;
    }
    if (!accepted && !(after && acceptedIn(after)))
      throw new MessageNotSentError(failureText(error));
    accept();
    throw error;
  } finally {
    stopWatching?.();
  }
}
