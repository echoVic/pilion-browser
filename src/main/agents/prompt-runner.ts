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
  onRecovery(): void;
};

/** Continue an empty successful turn once in the same session; never replay the original request. */
export async function runPrompt(text: string, options: Options): Promise<PromptResponse> {
  let prompt = text;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.cancelled()) return { stopReason: 'cancelled' };
    const start = options.messages().length;
    const result = await options.prompt(prompt);
    options.onResult(result);
    if (options.cancelled() || result.stopReason === 'cancelled')
      return { stopReason: 'cancelled' };
    if (result.stopReason !== 'end_turn')
      throw new Error(`Agent 提前结束（${result.stopReason}），请继续任务或切换模型。`);
    const messages = options.messages().slice(start);
    let lastTool = -1;
    messages.forEach((message, index) => {
      if (message.role === 'tool') lastTool = index;
    });
    const reply = messages
      .slice(lastTool + 1)
      .filter((message) => message.role === 'assistant')
      .map((message) => message.text)
      .join('');
    if (!isEmptyAgentReply(reply)) return result;
    if (attempt > 0)
      throw new Error(
        'Agent 连续返回空回复（end_turn），任务尚未完成。已停止自动续接，请切换模型或继续任务。',
      );
    options.onRecovery();
    prompt =
      '上一轮已结束，但没有返回有效答复。请在同一会话中继续完成用户尚未完成的请求，然后给出实际结果。先检查已有工具结果和当前页面；不要重新执行已经成功的操作，尤其不要重复提交、发送、购买或删除。若用户要求整理网页，请读取当前页面并给出带来源的整理结果；若任务已完成，请直接说明结果。不要输出省略号或 (no content)。';
  }
  throw new Error('Agent 未完成任务');
}
