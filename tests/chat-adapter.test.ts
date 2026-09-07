import { describe, expect, it, vi } from 'vitest';
import { MessageNotSentError } from '@assistant-ui/react';
import { dispatchPrompt, toThreadMessage } from '../src/renderer/chat-adapter';
import type { ConversationMessage, AppState } from '../src/shared/contracts';
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
    events: [],
    activeConversationId: 'c1',
    conversations: [{ id: 'c1', title: 'Chat', updatedAt: message.time, messages: [] }],
  };
  const api = {
    getState: vi.fn(async () => state),
    agents: {
      attach: vi.fn(async () => {}),
      task: vi.fn<(text: string) => Promise<void>>(async () => {}),
    },
  };
  return { state, api, send: (text: string) => dispatchPrompt(api as unknown as PilionApi, text) };
}
describe('assistant-ui IPC adapter', () => {
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
    expect(api.agents.attach).toHaveBeenCalledOnce();
    expect(api.agents.task).toHaveBeenCalledExactlyOnceWith('Hello');
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
