import { describe, expect, it, vi } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { ConversationMessage } from '../src/shared/contracts';
import { isEmptyAgentReply, runPrompt } from '../src/main/agents/prompt-runner';

function fixture() {
  const messages: ConversationMessage[] = [];
  let cancelled = false;
  const append = (role: ConversationMessage['role'], text: string) =>
    messages.push({ id: String(messages.length), role, text, time: new Date().toISOString() });
  const options = {
    prompt: vi.fn<(text: string) => Promise<PromptResponse>>(),
    messages: () => messages,
    cancelled: () => cancelled,
    onResult: vi.fn(),
    diagnostics: () => ({ agent: 'fixture' }),
  };
  return {
    append,
    options,
    cancel: () => {
      cancelled = true;
    },
  };
}
describe('protocol-transparent ACP prompt runner', () => {
  it('recognizes only empty placeholder replies', () => {
    for (const text of ['', ' ', '...(no content)', '(no content)...', '…'])
      expect(isEmptyAgentReply(text)).toBe(true);
    for (const text of ['完成', 'The result is (no content)', '...done'])
      expect(isEmptyAgentReply(text)).toBe(false);
  });
  it('sends exactly one prompt and accepts displayable Agent output', async () => {
    const { append, options } = fixture();
    options.prompt.mockImplementationOnce(async () => {
      append('tool', 'browser.navigate');
      append('assistant', '今日资讯：...');
      return { stopReason: 'end_turn' };
    });
    await expect(runPrompt('打开 Hacker News 并整理资讯', options)).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(options.prompt).toHaveBeenCalledExactlyOnceWith('打开 Hacker News 并整理资讯');
  });
  it('reports an empty end_turn without sending a hidden retry', async () => {
    const { append, options } = fixture();
    options.prompt.mockImplementation(async () => {
      append('tool', 'browser.navigate');
      append('assistant', '(no content)');
      return { stopReason: 'end_turn' };
    });
    await expect(runPrompt('Task', options)).rejects.toMatchObject({
      code: 'AGENT_EMPTY_RESPONSE',
      details: { agent: 'fixture', tools: ['browser.navigate'] },
    });
    expect(options.prompt).toHaveBeenCalledOnce();
  });
  it('does not retry provider errors, output limits or user cancellation', async () => {
    for (const reason of ['max_tokens', 'max_turn_requests', 'refusal'] as const) {
      const { options } = fixture();
      options.prompt.mockResolvedValue({ stopReason: reason });
      await expect(runPrompt('Task', options)).rejects.toThrow(reason);
      expect(options.prompt).toHaveBeenCalledOnce();
    }
    const { options, cancel } = fixture();
    options.prompt.mockImplementation(async () => {
      cancel();
      return { stopReason: 'end_turn' };
    });
    await expect(runPrompt('Task', options)).resolves.toEqual({ stopReason: 'cancelled' });
    expect(options.prompt).toHaveBeenCalledOnce();
    const failed = fixture();
    failed.options.prompt.mockRejectedValue(new Error('Connection lost'));
    await expect(runPrompt('Task', failed.options)).rejects.toThrow('Connection lost');
    expect(failed.options.prompt).toHaveBeenCalledOnce();
  });
});
