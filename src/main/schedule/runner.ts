import type { PermissionMode } from '../../shared/contracts.js';

/**
 * 调度器与「真正去跑这个 prompt」的解耦接口。
 *
 * main.ts 的实现为每次触发新建一条后台对话、各自连接绑定的 Agent，多条定时任务可以并行跑；
 * 跑不了时返回 skipped 并说明原因（同一任务还在跑、并行名额已满、找不到 Agent 等）。
 * 调度器不关心这些细节——它只依赖这个接口，保持很薄。
 */
export interface ScheduledPromptRunInput {
  /** 后台新建对话的标题，形如「任务名 · 触发时间」。 */
  conversationTitle: string;
  agentId: string;
  prompt: string;
  origin: 'scheduled';
  scheduleId: string;
  /** 本任务后台对话的权限模式（任务自带，默认 ask）。 */
  permissionMode: PermissionMode;
}

export type ScheduledPromptOutcome =
  | { status: 'ok'; conversationId: string; unattendedDenied?: boolean }
  | { status: 'failed'; conversationId?: string; reason: string }
  | { status: 'skipped'; reason: 'busy' | 'no_agent' | string };

export interface ScheduledPromptRunner {
  run(input: ScheduledPromptRunInput): Promise<ScheduledPromptOutcome>;
  /** 该任务是否还有一次运行在进行中（用于重叠跳过）。 */
  isRunning(scheduleId: string): boolean;
}
