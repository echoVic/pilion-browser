/**
 * 多会话并行的核心：按 conversationId 维护一份独立的运行时状态。
 *
 * 历史上主进程只有一个「活跃 Agent / 一个 prompt」：connection、attachmentLease、agentTabId、
 * promptActive 全是模块级单例。要让多个对话各连一个 ACP Agent 同时跑，就得把这些原本
 * 隐式共享的状态按会话拆开。本模块只持有「与谁隔离」的纯数据：并发名额与每个会话的 Agent
 * 标签，不碰 Electron、不碰真实 ACP。真正的 transport、MCP socket、attachment 台账仍由主进程
 * 在自己那一层持有。
 *
 * 安全模型不变：跨会话 ACL 的裁决在 TabRegistry.require（按 principal 抛 PERMISSION_DENIED
 * 并留审计），这里不做判定。
 */

/** 同时允许并行运行的会话上限。超过即拒绝新开任务。 */
export const MAX_CONCURRENT_SESSIONS = 4;

/** 登记着的会话都在跑 prompt 或 goal；停止、接管、断开都由主进程 end() 摘除。 */
export type SessionRuntimeStatus = 'running';

export interface SessionRuntimeState {
  conversationId: string;
  /** 这个会话的 Agent 在 Host 台账里的 principal（每个会话唯一）。 */
  principal: string;
  agentId: string;
  status: SessionRuntimeStatus;
  /**
   * 本会话 Agent 正在操作的标签（侧栏「AI 操作中」标识的归属）。人切走不影响它；
   * 不同会话各记各的。回合结束、接管、断开时清空。
   */
  agentTabId?: string;
}

export interface SessionRuntimeOptions {
  maxConcurrent?: number;
}

export class SessionRuntimeRegistry {
  private readonly sessions = new Map<string, SessionRuntimeState>();
  private readonly maxConcurrent: number;

  constructor(options: SessionRuntimeOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SESSIONS;
  }

  /** 一个会话开始跑 Agent。重复登记同一会话返回既有状态；超出并发上限抛错。 */
  begin(conversationId: string, principal: string, agentId: string): SessionRuntimeState {
    const existing = this.sessions.get(conversationId);
    if (!existing && this.runningCount() >= this.maxConcurrent) {
      throw new Error(`最多同时 ${this.maxConcurrent} 个会话在运行，请先结束其中一个`);
    }
    if (existing) {
      existing.principal = principal;
      existing.agentId = agentId;
      return existing;
    }
    const state: SessionRuntimeState = {
      conversationId,
      principal,
      agentId,
      status: 'running',
    };
    this.sessions.set(conversationId, state);
    return state;
  }

  list(): SessionRuntimeState[] {
    return [...this.sessions.values()];
  }

  /** 正在运行的会话数，即占用的并发名额。 */
  runningCount(): number {
    return this.sessions.size;
  }

  /** 记录本会话 Agent 正在操作的标签；传 undefined 清空。 */
  setAgentTab(conversationId: string, tabId: string | undefined): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.agentTabId = tabId;
    if (tabId === undefined) delete session.agentTabId;
  }

  agentTab(conversationId: string): string | undefined {
    return this.sessions.get(conversationId)?.agentTabId;
  }

  /** 会话彻底结束 / 断开：从注册表摘除。 */
  end(conversationId: string): void {
    this.sessions.delete(conversationId);
  }
}
