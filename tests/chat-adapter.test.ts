import { describe, expect, it, vi } from 'vitest';
import { MessageNotSentError } from '@assistant-ui/react';
import { dispatchPrompt, toThreadMessage } from '../src/renderer/chat-adapter';
import type { ConversationMessage, AppState, PromptAttachment } from '../src/shared/contracts';
import type { PilionApi } from '../src/preload/index';

const message: ConversationMessage = {
  id: 'message1',
  role: 'assistant',
  text: 'Partial',
  time: '2026-09-07T10:00:00Z',
  status: 'running',
};
function fixture() {
  const state: AppState = {
    tabs: [],
    agents: [],
    agentStatus: 'ready',
    attachmentStatus: 'attached',
    approvals: [],
    pendingApprovalsByConversation: {},
    conversationAgents: {},
    events: [],
    activeConversationId: 'c1',
    conversations: [{ id: 'c1', title: 'Chat', updatedAt: message.time, messages: [] }],
  };
  const api = {
    getState: vi.fn(async () => state),
    agents: {
      attach: vi.fn(async () => {}),
      task: vi.fn<
        (text: string, attachments?: PromptAttachment[], conversationId?: string) => Promise<void>
      >(async () => {}),
      resume: vi.fn<(text: string) => Promise<void>>(async () => {}),
    },
  };
  return { state, api, send: (text: string) => dispatchPrompt(api as unknown as PilionApi, text) };
}
describe('assistant-ui IPC adapter', () => {
  it('uses a message sent during manual takeover as a continuation note', async () => {
    const { state, api, send } = fixture();
    state.attachmentStatus = 'detached';
    state.conversations![0].task = {
      id: 'task1',
      goal: '原始目标',
      agentId: 'agent1',
      status: 'manual',
      updatedAt: message.time,
    };
    await send('我已登录好了，继续');
    expect(api.agents.resume).toHaveBeenCalledExactlyOnceWith('我已登录好了，继续', 'c1');
    expect(api.agents.task).not.toHaveBeenCalled();
    expect(api.agents.attach).not.toHaveBeenCalled();
  });
  it('retains persisted IDs and maps stream completion, thoughts and tools into library message parts', () => {
    expect(toThreadMessage(message)).toMatchObject({
      id: 'message1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Partial' }],
      status: { type: 'running' },
    });
    expect(toThreadMessage({ ...message, role: 'thought' }).content).toEqual([
      { type: 'reasoning', text: 'Partial' },
    ]);
    expect(toThreadMessage({ ...message, role: 'tool', status: 'failed' })).toMatchObject({
      content: [{ type: 'tool-call', toolCallId: 'message1', result: 'failed', isError: true }],
      status: { type: 'incomplete', reason: 'error' },
    });
    expect(toThreadMessage({ ...message, status: 'cancelled' }).status).toEqual({
      type: 'incomplete',
      reason: 'cancelled',
    });
    expect(toThreadMessage({ ...message, role: 'user' }).status).toBeUndefined();
    expect(toThreadMessage({ ...message, role: 'system' }).role).toBe('system');
  });
  it('attaches when needed and sends exactly once through the existing task IPC', async () => {
    const { state, api, send } = fixture();
    state.attachmentStatus = 'detached';
    await send('Hello');
    expect(api.agents.attach).toHaveBeenCalledExactlyOnceWith('c1');
    expect(api.agents.task).toHaveBeenCalledExactlyOnceWith('Hello', undefined, 'c1');
  });
  it('restores an unsent draft for connection and attach failures', async () => {
    const { state, api, send } = fixture();
    state.agentStatus = 'disconnected';
    await expect(send('Hello')).rejects.toBeInstanceOf(MessageNotSentError);
    expect(api.agents.task).not.toHaveBeenCalled();
    state.agentStatus = 'ready';
    state.attachmentStatus = 'detached';
    api.agents.attach.mockRejectedValue(new Error('Attach failed'));
    await expect(send('Hello')).rejects.toBeInstanceOf(MessageNotSentError);
  });
  it('distinguishes rejected dispatch from an accepted turn that failed after emitting output', async () => {
    const { state, api, send } = fixture();
    state.conversations!.push({
      id: 'older-conversation',
      title: 'Older chat',
      updatedAt: message.time,
      messages: [{ ...message, id: 'older-message', role: 'user', text: 'Hello' }],
    });
    api.agents.task.mockRejectedValue(new Error('Provider failed'));
    await expect(send('Hello')).rejects.toBeInstanceOf(MessageNotSentError);
    api.agents.task.mockImplementation(async (text) => {
      state.conversations![0].messages.push({ ...message, role: 'user', text });
      throw new Error('Provider failed');
    });
    await expect(send('Hello')).rejects.not.toBeInstanceOf(MessageNotSentError);
    expect(state.conversations![0].messages).toHaveLength(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function switchConversation(state: AppState) {
  state.activeConversationId = 'c2';
  state.conversations!.push({ id: 'c2', title: 'Other', updatedAt: message.time, messages: [] });
}

describe('conversation-bound prompt dispatch', () => {
  it('does not send when switching while the initial state request is pending', async () => {
    const { state, api, send } = fixture();
    const snapshot = structuredClone(state);
    const first = deferred<AppState>();
    api.getState.mockReturnValueOnce(first.promise);
    const sending = send('Hello');
    switchConversation(state);
    first.resolve(snapshot);
    await expect(sending).rejects.toBeInstanceOf(MessageNotSentError);
    expect(api.agents.task).not.toHaveBeenCalled();
  });

  it('does not send when switching during attachment', async () => {
    const { state, api, send } = fixture();
    const attaching = deferred<void>();
    state.attachmentStatus = 'detached';
    api.agents.attach.mockReturnValueOnce(attaching.promise);
    const sending = send('Hello');
    await vi.waitFor(() => expect(api.agents.attach).toHaveBeenCalledOnce());
    switchConversation(state);
    attaching.resolve();
    await expect(sending).rejects.toBeInstanceOf(MessageNotSentError);
    expect(api.agents.attach).toHaveBeenCalledExactlyOnceWith('c1');
    expect(api.agents.task).not.toHaveBeenCalled();
  });

  it('uses the caller conversation ID even when the first snapshot is already B', async () => {
    const { state, api } = fixture();
    switchConversation(state);
    await expect(
      dispatchPrompt(api as unknown as PilionApi, 'Hello', [], 'c1'),
    ).rejects.toBeInstanceOf(MessageNotSentError);
    expect(api.agents.attach).not.toHaveBeenCalled();
    expect(api.agents.task).not.toHaveBeenCalled();
    expect(api.agents.resume).not.toHaveBeenCalled();
  });

  it('does not send when the caller unmounts during attachment without switching IDs', async () => {
    const { state, api } = fixture();
    const attaching = deferred<void>();
    state.attachmentStatus = 'detached';
    api.agents.attach.mockReturnValueOnce(attaching.promise);
    let mounted = true;
    const sending = dispatchPrompt(api as unknown as PilionApi, 'Hello', [], 'c1', () => mounted);
    await vi.waitFor(() => expect(api.agents.attach).toHaveBeenCalledOnce());
    mounted = false;
    attaching.resolve();
    await expect(sending).rejects.toBeInstanceOf(MessageNotSentError);
    expect(api.agents.task).not.toHaveBeenCalled();
  });

  it('does not count a matching message accepted in B as acceptance in A', async () => {
    const { state, api, send } = fixture();
    switchConversation(state);
    state.activeConversationId = 'c1';
    api.agents.task.mockImplementation(async () => {
      state.conversations![1].messages.push({
        ...message,
        id: 'B-message',
        role: 'user',
        text: 'Hello',
      });
      throw new Error('A rejected');
    });
    await expect(send('Hello')).rejects.toBeInstanceOf(MessageNotSentError);
    expect(state.conversations![0].messages).toEqual([]);
  });

  it('keeps an accepted failure in A accepted after the active conversation switches to B', async () => {
    const { state, api, send } = fixture();
    const failed = new Error('Provider failed after acceptance');
    api.agents.task.mockImplementation(async () => {
      state.conversations![0].messages.push({ ...message, role: 'user', text: 'Hello' });
      switchConversation(state);
      throw failed;
    });
    await expect(send('Hello')).rejects.toBe(failed);
  });

  it('passes images as the second argument and the captured conversation as the third', async () => {
    const { api } = fixture();
    const attachments: PromptAttachment[] = [
      { mimeType: 'image/png', data: 'aGVsbG8=', name: 'A.png' },
    ];
    await dispatchPrompt(api as unknown as PilionApi, 'Hello', attachments);
    expect(api.agents.task).toHaveBeenCalledExactlyOnceWith('Hello', attachments, 'c1');
  });
});
