import { ATTACHMENT_IDLE_MS } from '../host/attachment-lease.js';

/**
 * 多会话并行的核心：按 conversationId 维护一份独立的运行时状态。
 *
 * 历史上主进程只有一个「活跃 Agent / 一个 prompt」：connection、attachmentLease、agentTabId、
 * promptActive 全是模块级单例。要让多个对话各连一个 ACP Agent 同时跑，就得把这些原本
 * 隐式共享的状态按会话拆开。本模块只持有「与谁隔离」的纯数据与判定规则，不碰 Electron、
 * 不碰真实 ACP：真正的 transport、MCP socket、attachment 台账仍由主进程在自己那一层持有，
 * 通过构造时注入的 hooks 回调过来操作。这样规则可以在不启动 Electron 的情况下单测。
 *
 * 安全模型不变：跨会话 ACL 的最终裁决仍在 TabRegistry.require（按 principal 抛
 * PERMISSION_DENIED 并留审计），这里的 canOperateTab 只是把「一个会话的 Agent 不许碰另一个
 * 会话标签」这条规则显式化，供主进程在记账与审计前先判一道。
 */

/** 同时允许并行运行的会话上限。超过即拒绝新开任务。 */
export const MAX_CONCURRENT_SESSIONS = 4;

export type SessionInterruptMode = 'manual' | 'stopped';

export type SessionRuntimeStatus =
  /** 已登记、正在跑 prompt 或 goal。 */
  | 'running'
  /** 已交还给人（接管 / 沉默 / request_human），可继续。 */
  | 'manual'
  /** 已被停止，不再提供继续入口。 */
  | 'stopped';

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
  /** 本会话 attachment 的空闲租约截止时间戳（毫秒）。各会话独立续租、独立过期。 */
  leaseExpiresAt: number;
  /** 是否有 prompt / 工具调用在飞。lease 只在「忙」时才算在续租。 */
  busy: boolean;
}

export interface SessionRuntimeHooks {
  /**
   * 停止 / 接管 / 沉默最终要落到某个会话上：取消它自己的 ACP 请求、撤销它自己的 attachment、
   * 清它自己的在途审批与光标。实现里必须只操作 conversationId 这一个会话，不波及兄弟会话。
   */
  interrupt(conversationId: string, mode: SessionInterruptMode): void;
}

export interface SessionRuntimeOptions {
  now?: () => number;
  /** 人工回放与本地 principal；只有它能跨标签操作。 */
  userPrincipal?: string;
  maxConcurrent?: number;
  /** 空闲 lease 时长，默认 60 分钟。 */
  leaseMs?: number;
}

export class SessionRuntimeRegistry {
  private readonly sessions = new Map<string, SessionRuntimeState>();
  private readonly now: () => number;
  private readonly userPrincipal: string;
  private readonly maxConcurrent: number;
  private readonly leaseMs: number;

  constructor(
    private readonly hooks: SessionRuntimeHooks,
    options: SessionRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.userPrincipal = options.userPrincipal ?? 'local-user';
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SESSIONS;
    this.leaseMs = options.leaseMs ?? ATTACHMENT_IDLE_MS;
  }

  /** 一个会话开始跑 Agent。重复登记同一会话返回既有状态；超出并发上限抛错。 */
  begin(conversationId: string, principal: string, agentId: string): SessionRuntimeState {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.status = 'running';
      existing.busy = true;
      existing.principal = principal;
      existing.agentId = agentId;
      existing.leaseExpiresAt = this.now() + this.leaseMs;
      return existing;
    }
    if (this.runningCount() >= this.maxConcurrent) {
      throw new Error(`最多同时 ${this.maxConcurrent} 个会话在运行，请先结束其中一个`);
    }
    const state: SessionRuntimeState = {
      conversationId,
      principal,
      agentId,
      status: 'running',
      busy: true,
      leaseExpiresAt: this.now() + this.leaseMs,
    };
    this.sessions.set(conversationId, state);
    return state;
  }

  get(conversationId: string): SessionRuntimeState | undefined {
    return this.sessions.get(conversationId);
  }

  /** 这个会话对应的 principal（没有登记过返回 undefined）。 */
  principalOf(conversationId: string): string | undefined {
    return this.sessions.get(conversationId)?.principal;
  }

  /** principal → 会话，供跨会话审计。 */
  conversationOfPrincipal(principal: string): SessionRuntimeState | undefined {
    for (const session of this.sessions.values())
      if (session.principal === principal) return session;
    return undefined;
  }

  list(): SessionRuntimeState[] {
    return [...this.sessions.values()];
  }

  /** status=running 的会话数（manual/stopped 的占位不算占并发名额）。 */
  runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.status === 'running') count += 1;
    return count;
  }

  /** 一次 Agent 活动（prompt 收发或工具调用）：续租本会话 lease、标记忙碌。 */
  touch(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.busy = true;
    session.leaseExpiresAt = this.now() + this.leaseMs;
  }

  /** 本会话当前回合暂时没有在飞的调用（Agent 在思考）。 */
  settleBusy(conversationId: string, busy: boolean): void {
    const session = this.sessions.get(conversationId);
    if (session) session.busy = busy;
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

  /**
   * 跨会话标签 ACL 的显式判定。真正拒执行力在 TabRegistry；这里把规则前置，便于审计与单测：
   * - 人工（user principal）永远可以操作任何标签；
   * - Agent 只能操作归自己这个会话（principal 相同）的标签；
   * - 一个会话的 Agent 想动另一个会话的标签，直接 false。
   */
  canOperateTab(operatorPrincipal: string, tabOwnerPrincipal: string): boolean {
    if (operatorPrincipal === this.userPrincipal) return true;
    return operatorPrincipal === tabOwnerPrincipal;
  }

  /**
   * 停止 / 接管：只作用于这一个会话，把它置成 manual 或 stopped，清空它的在途标记，
   * 再让宿主取消它自己的 ACP 与 attachment。兄弟会话的状态与 lease 一律不动。
   * 会话没登记过时静默返回（可能已经自己结束了）。
   */
  interrupt(conversationId: string, mode: SessionInterruptMode): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.status = mode;
    session.busy = false;
    delete session.agentTabId;
    this.hooks.interrupt(conversationId, mode);
  }

  /** 沉默检测：只有仍在 running 的会话才请它停下；已经 manual/stopped 的不再打扰。 */
  onSilent(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session || session.status !== 'running') return;
    this.interrupt(conversationId, 'manual');
  }

  /**
   * 找出 lease 已空闲过期的会话。各会话独立计时：A 一直在活动就不过期，B 静置够久就过期。
   * 返回后由主进程各自撤销 attachment。只看「不忙」的会话——忙的会话即使跨过旧 deadline，
   * 下一次 touch 会把它续回来，不在过期名单里制造抖动。
   */
  expiredSessions(now: number): SessionRuntimeState[] {
    const current = this.now();
    const at = now ?? current;
    const expired: SessionRuntimeState[] = [];
    for (const session of this.sessions.values()) {
      if (!session.busy && session.leaseExpiresAt <= at) expired.push(session);
    }
    return expired;
  }

  /** 会话彻底结束 / 断开：从注册表摘除。 */
  end(conversationId: string): void {
    this.sessions.delete(conversationId);
  }
}

/**
 * 「后台以编程方式创建对话并运行 prompt、拿到完成事件」的主进程函数签名。
 *
 * 后续「定时 prompt」功能会在没有用户点按钮的情况下新建对话并起跑。把它抽成这一个清晰入口，
 * 主进程在 init 时绑定真实实现：内部走与手动发 prompt 相同的会话登记、lease、审批与消息回写，
 * 完成（或失败、取消）时 resolve 这个 Promise。测试与调用方都只依赖这层契约。
 */
export interface BackgroundPromptInput {
  agentId: string;
  text: string;
  /** 可选：复用已有对话而不是新建（默认新建）。 */
  conversationId?: string;
  /** 完成后是否保持 attachment 以便继续；默认跑完即交还。 */
}

export interface BackgroundPromptResult {
  conversationId: string;
  stopReason: 'end_turn' | 'cancelled' | 'failed' | 'error';
  messageCount: number;
}

export type RunBackgroundPrompt = (input: BackgroundPromptInput) => Promise<BackgroundPromptResult>;
