import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { ConversationMessage } from '../../shared/contracts.js';

export function isEmptyAgentReply(text: string): boolean {
  return /^(?:\s|\.\.\.|…|\(no content\))*$/i.test(text);
}

type Options = {
  prompt(text: string): Promise<PromptResponse>;
  messages(): readonly ConversationMessage[];
  cancelled(): boolean;
  onResult(result: PromptResponse): void;
  diagnostics?(): Readonly<Record<string, unknown>>;
};

export class AgentEmptyResponseError extends Error {
  readonly name = 'AgentEmptyResponseError';
  readonly code = 'AGENT_EMPTY_RESPONSE';

  constructor(readonly details: Readonly<Record<string, unknown>> = {}) {
    super(
      'AGENT_EMPTY_RESPONSE：Agent 以 end_turn 结束，但没有返回可展示内容。Pilion 未自动重试。',
    );
  }
}

/** Run exactly one ACP prompt. Planning and continuation remain owned by the Agent. */
export async function runPrompt(text: string, options: Options): Promise<PromptResponse> {
  if (options.cancelled()) return { stopReason: 'cancelled' };
  const start = options.messages().length;
  const result = await options.prompt(text);
  options.onResult(result);
  if (options.cancelled() || result.stopReason === 'cancelled') return { stopReason: 'cancelled' };
  if (result.stopReason !== 'end_turn')
    throw new Error(`Agent 提前结束（${result.stopReason}），请继续任务或切换模型。`);
  const turn = options.messages().slice(start);
  const reply = turn
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
    .join('');
  if (isEmptyAgentReply(reply))
    throw new AgentEmptyResponseError({
      tools: turn.filter((message) => message.role === 'tool').map((message) => message.text),
      ...options.diagnostics?.(),
    });
  return result;
}
