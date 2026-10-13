/**
 * 调度器与「真正去跑这个 prompt」的解耦接口。
 *
 * 当前 main 是单活跃 Agent / 单活跃 prompt 的模型：适配器要复用「新建对话 + 连接绑定的 Agent +
 * executeAgentTask」这条路，跑不动（用户正在忙）就返回 skipped。feat/multi-session 分支合并后，
 * 会换成一个能并行跑多条会话的实现，调度器不关心细节——它只依赖这个接口，保持很薄。
 */
export interface ScheduledPromptRunInput {
  /** 后台新建对话的标题，形如「任务名 · 触发时间」。 */
  conversationTitle: string;
  agentId: string;
  prompt: string;
  origin: 'scheduled';
  scheduleId: string;
}

export type ScheduledPromptOutcome =
  | { status: 'ok'; conversationId: string }
  | { status: 'failed'; conversationId?: string; reason: string }
  | { status: 'skipped'; reason: 'busy' | 'no_agent' | string };

export interface ScheduledPromptRunner {
  run(input: ScheduledPromptRunInput): Promise<ScheduledPromptOutcome>;
  /** 该任务是否还有一次运行在进行中（用于重叠跳过）。 */
  isRunning(scheduleId: string): boolean;
}
