import type { AgentStatus, ConversationAgentView } from '../../shared/contracts.js';

/**
 * 一条对话和它的 Agent 之间，「连接」这件事的状态机。
 *
 *   （没有记录）──connect──▶ connecting ──成功──▶ （连接登记进会话表，记录清掉）
 *                               │
 *                               ├──失败──▶ failed ──重试──▶ connecting
 *                               └──名额满─▶ capacity ─重试─▶ connecting
 *
 * 连上之后是就绪还是运行，由会话表里的连接说了算；这里只记连接之外的那一半。
 * 两半合起来，`conversationLinkState` 给出面板要画的唯一状态——不会再出现
 * 「没有人在连，界面却一直显示正在连接」这种只能靠缺省值表达的情况。
 */
export type ConnectAttempt =
  { phase: 'connecting' } | { phase: 'failed'; error: string } | { phase: 'capacity' };

export interface ConversationLinkInput {
  /** 这条对话绑定的 Agent；没绑就是 undefined。 */
  agentId?: string;
  /** 绑定的 Agent 配置还在、且没有被停用。 */
  agentEnabled: boolean;
  /** 会话表里有存活连接时给出；running 表示这一回合（或 goal）还在跑。 */
  live?: { running: boolean };
  attempt?: ConnectAttempt;
}

export function conversationLinkState(input: ConversationLinkInput): {
  state: ConversationAgentView['state'];
  error?: string;
} {
  if (!input.agentId) return { state: 'none' };
  if (!input.agentEnabled) return { state: 'unavailable' };
  if (input.live) return { state: input.live.running ? 'running' : 'ready' };
  switch (input.attempt?.phase) {
    case 'connecting':
      return { state: 'connecting' };
    case 'capacity':
      return { state: 'capacity' };
    case 'failed':
      return { state: 'failed', error: input.attempt.error };
    default:
      return { state: 'disconnected' };
  }
}

/** 同一份事实在状态栏上的说法：界面焦点所在的那条对话用它。 */
export function focusedAgentStatus(input: {
  live?: { running: boolean };
  attempt?: ConnectAttempt;
}): AgentStatus {
  if (input.live) return input.live.running ? 'running' : 'ready';
  if (input.attempt?.phase === 'connecting') return 'starting';
  return input.attempt ? 'error' : 'disconnected';
}
