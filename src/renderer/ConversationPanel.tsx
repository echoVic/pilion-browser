import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import clsx from 'clsx';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  MessageNotSentError,
  type ThreadComposerRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleStop,
  FileText,
  Globe2,
  LayoutGrid,
  Link2,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  MoreVertical,
  PanelRight,
  PictureInPicture2,
  Plug,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AppState,
  ConversationMessage,
  PermissionMode,
  PromptAttachment,
} from '../shared/contracts';
import { InlineApproval } from './InlineApproval';
import { ChatMessage } from './ChatMessage';
import { ComposerInput } from './ComposerInput';
import { dispatchPrompt, groupConversationMessages } from './chat-adapter';
import { QueuedMessages } from './composer/QueuedMessages';
import { SkillProposalPanel } from './composer/SkillProposalPanel';
import { TaskControlBar } from './panel/TaskControlBar';
import { ConversationAgentNotice } from './panel/ConversationAgentNotice';
import { mergeQueue, waitUntilIdle } from './composer/queue';
import {
  blockQueue,
  canAutoFlush,
  enqueueEntry,
  queueHold,
  recallEntry,
  removeQueued as removeQueuedEntry,
  retractSent,
  setAttachments as setEntryAttachments,
  setDraft as setEntryDraft,
  type ComposerEntry,
  type ComposerStore,
  type SentPrompt,
} from './composer/composer-store';
import {
  composerLocked,
  composerPhase,
  IDLE_PHASE,
  type ComposerPhase,
  type ComposerPhaseEvent,
} from './composer/phase';
import { LOCAL_AGENTS, type LocalAgentPreset } from '../shared/local-agents';
import { IconButton, PilionMark, Select, statusCopy } from './ui';
import { AdapterInstallProgress } from './AdapterInstallProgress';
import { useManualWheelScroll } from './useManualWheelScroll';

const noMessages: ConversationMessage[] = [];
const identityMessage = (message: ThreadMessageLike) => message;

function formatTabHost(url?: string, title?: string): string {
  if (!url || url === 'about:blank') return title || '新标签页';
  try {
    return new URL(url).hostname.replace(/^www\./, '') || title || url;
  } catch {
    return title || url;
  }
}

const suggestions = [
  { icon: Sparkles, label: '总结当前页面', text: '总结当前页面的核心内容，列出关键结论和来源。' },
  {
    icon: FileText,
    label: '研究一个主题',
    text: '围绕当前页面的主题展开研究，对比不同来源，整理成有引用的结论。',
  },
  {
    icon: Globe2,
    label: '整理打开的页面',
    text: '整理已打开的标签页，归纳每个页面的用途和待办事项。',
    tag: '技能',
  },
];

type Props = {
  state: AppState;
  settings(preset?: LocalAgentPreset): void;
  close(): void;
  /** 是否运行在独立悬浮窗口模式；支持与右侧停靠一键切换。 */
  floating?: boolean;
  toggleFloat?(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
  /** 按对话保存的草稿、附件与待发队列：面板收起、切换对话都不丢。 */
  composer: ComposerStore;
  /** 打开任务总览（Agent 任务浮层）；测试渲染可以不给。 */
  openTaskOverview?(): void;
};

export function ConversationPanel(props: Props) {
  // A fresh runtime keeps local message repositories and draft state scoped to a conversation.
  return <ConversationThread key={props.state.activeConversationId ?? 'preview'} {...props} />;
}

function ConversationThread({
  state,
  settings,
  close,
  floating = false,
  toggleFloat,
  run,
  composer: composerStore,
  openTaskOverview,
}: Props) {
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [phase, setPhase] = useState<ComposerPhase>(IDLE_PHASE);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [needsAgent, setNeedsAgent] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const agentPicker = useRef<HTMLButtonElement>(null);
  const sessionPopover = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionMenuOpen && !moreMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSessionMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    const onDown = (event: MouseEvent) => {
      if (sessionPopover.current && !sessionPopover.current.contains(event.target as Node))
        setSessionMenuOpen(false);
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node))
        setMoreMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [sessionMenuOpen, moreMenuOpen]);

  // 流式追加与 wheel 同帧竞争时，按当前布局自行结算滚动，避免原生滚动按上一帧边界把上滚钳在半路。
  // callback ref 覆盖视图/会话切换导致 Viewport 卸载重挂的场景。
  const viewportRef = useManualWheelScroll<HTMLDivElement>();
  const conversation = state.conversations?.find((item) => item.id === state.activeConversationId);
  const approvals = conversation
    ? state.approvals.filter((item) => item.conversationId === conversation.id)
    : [];
  const externalApprovals = state.approvals.filter((item) => item.externalClientName);
  const conversationId = conversation?.id;
  const mounted = useRef(true);
  const currentConversationId = useRef(state.activeConversationId);
  useLayoutEffect(() => {
    currentConversationId.current = state.activeConversationId;
  }, [state.activeConversationId]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrentConversation = useCallback(
    () => mounted.current && currentConversationId.current === conversationId,
    [conversationId],
  );
  // 权限模式是会话级的：优先本会话设置，缺省回退全局默认。
  const permissionMode = conversation?.permissionMode ?? state.permissionMode ?? 'full';
  const agent = state.agents.find((item) => item.id === state.connectedAgentId);
  // 打开历史对话正在恢复原 Agent 时，头部必须显示这条对话的 Agent，不能沿用 connectedAgentId
  // （那是上一条对话的连接）；connecting/unavailable 之外的状态保持现有行为。
  const activeAgentView = state.conversationAgents?.[state.activeConversationId ?? ''];
  const pinnedHeader =
    activeAgentView &&
    (activeAgentView.state === 'connecting' || activeAgentView.state === 'unavailable')
      ? {
          state: activeAgentView.state,
          name: activeAgentView.agentName ?? conversation?.agentName ?? '原 Agent',
        }
      : undefined;
  const attached = state.attachmentStatus === 'attached';
  const manual = conversation?.task?.status === 'manual';
  const locked = composerLocked(phase);
  const settling = configuring || switchingAgent || phase.kind !== 'idle';
  const busy =
    ['starting', 'running', 'stopping'].includes(state.agentStatus) ||
    configuring ||
    phase.kind !== 'idle';
  const connecting = switchingAgent || state.agentStatus === 'starting';

  // 草稿、附件与待发队列都存在 App 级的 ComposerStore 里、按对话隔离；这里只订阅本对话的那一份。
  // 面板只订阅附件与队列，草稿的每次按键只让输入框自己重渲染。
  const composerKey = state.activeConversationId ?? 'preview';
  const subscribeEntry = useCallback(
    (listener: () => void) => composerStore.subscribe(composerKey, listener),
    [composerStore, composerKey],
  );
  const readQueue = () => composerStore.get(composerKey).queue;
  const readBlocked = () => composerStore.get(composerKey).queueBlocked;
  const readAttachments = () => composerStore.get(composerKey).attachments;
  const queue = useSyncExternalStore(subscribeEntry, readQueue, readQueue);
  const queueBlocked = useSyncExternalStore(subscribeEntry, readBlocked, readBlocked);
  const attachments = useSyncExternalStore(subscribeEntry, readAttachments, readAttachments);
  const updateEntry = useCallback(
    (change: (entry: ComposerEntry) => ComposerEntry) => composerStore.update(composerKey, change),
    [composerStore, composerKey],
  );
  const setAttachments = useCallback(
    (next: readonly PromptAttachment[]) => updateEntry((entry) => setEntryAttachments(entry, next)),
    [updateEntry],
  );
  const [notice, setNotice] = useState<string | undefined>();

  // 阶段同时留一份在 ref 里：快速连按时回调要同步读到「已经在发」，不能等下一次渲染。
  const phaseRef = useRef<ComposerPhase>(IDLE_PHASE);
  const nextToken = useRef(0);
  const advance = useCallback((event: ComposerPhaseEvent) => {
    phaseRef.current = composerPhase(phaseRef.current, event);
    if (mounted.current) setPhase(phaseRef.current);
  }, []);
  const askForAgent = useCallback(() => {
    setNeedsAgent(true);
    agentPicker.current?.focus();
  }, []);

  /**
   * 把一次提交交给主进程。输入框、附件和队列在主进程收下之前一律不动；收下那一刻才把发出去的部分
   * 移走（面板已卸载也照样移，store 不随面板走）。没被收下时只在输入框上方说一次原因，不进全局横幅。
   */
  const submit = useCallback(
    async (sent: SentPrompt) => {
      const api = window.pilion;
      if (!api || !isCurrentConversation() || phaseRef.current.kind === 'submitting') return;
      const token = (nextToken.current += 1);
      advance({ type: 'submit', token });
      setView('chat');
      setNotice(undefined);
      let notSent: string | undefined;
      try {
        await run(async () => {
          try {
            await dispatchPrompt(
              api,
              sent.text,
              sent.attachments,
              conversationId,
              isCurrentConversation,
              () => {
                updateEntry((entry) => retractSent(entry, sent));
                advance({ type: 'accepted', token });
              },
            );
          } catch (error) {
            // 收下后才失败的回合已在历史里留痕，交给 run 报一次；没收下的留给下面说明。
            if (!(error instanceof MessageNotSentError)) throw error;
            notSent = error.message;
          }
        });
      } finally {
        advance({ type: 'settled', token });
      }
      if (notSent === undefined || !isCurrentConversation()) return;
      const reason = notSent;
      // 卡住的队列不再自动重试，免得同一个原因反复发、反复失败；用户动了队列或发出新消息后再试。
      if (sent.queueIds.length) updateEntry((entry) => blockQueue(entry, reason));
      if (sent.draft !== undefined) setNotice(reason);
    },
    [run, conversationId, isCurrentConversation, advance, updateEntry],
  );

  const groupedMessages = useMemo(
    () => groupConversationMessages(conversation?.messages ?? noMessages),
    [conversation?.messages],
  );
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: groupedMessages,
    convertMessage: identityMessage,
    isRunning: state.agentStatus === 'running' || phase.kind !== 'idle',
    // 发送全部走下面表单的 onSubmit：assistant-ui 自带的 send 会在交给主进程之前先清空输入框。
    isSendDisabled: true,
    onNew: async () => {
      throw new MessageNotSentError();
    },
    onCancel: async () => {
      await run(async () => {
        if (isCurrentConversation()) await window.pilion.agents.cancel(conversationId);
      });
    },
  });

  /** Enter / 发送按钮：只发输入框；没有 Agent、正忙或在途时不发。 */
  const submitDraft = () => {
    if (!agent) {
      // Swapping the page for the settings pane moves the work away from where the
      // draft was written, so the reason is said here and the choice stays in reach.
      askForAgent();
      return;
    }
    if (busy || composerLocked(phaseRef.current)) return;
    const entry = composerStore.get(composerKey);
    const text = entry.draft.trim();
    if (!text) {
      if (entry.attachments.length) setNotice('请补一句文字说明再发送图片');
      return;
    }
    void submit({ text, draft: entry.draft, attachments: entry.attachments, queueIds: [] });
  };

  const enqueue = useCallback(
    (text: string, attachments: readonly PromptAttachment[]) =>
      updateEntry((entry) => enqueueEntry(entry, text, attachments)),
    [updateEntry],
  );
  const recall = useCallback(
    (id: string) => {
      if (!composerLocked(phaseRef.current)) updateEntry((entry) => recallEntry(entry, id));
    },
    [updateEntry],
  );
  const removeQueued = useCallback(
    (id: string) => {
      if (!composerLocked(phaseRef.current)) updateEntry((entry) => removeQueuedEntry(entry, id));
    },
    [updateEntry],
  );

  /**
   * ⌘/Ctrl+Enter：Agent 在跑时先打断（走现有 session/cancel），收尾后把输入框与队列合并成一条发出；
   * 没在跑时和 Enter 一样（正忙就排队）。打断在途时再按不会重复打断；收下之前什么都不清。
   */
  const interruptAndSend = async () => {
    if (composerLocked(phaseRef.current)) return;
    if (!agent) {
      askForAgent();
      return;
    }
    const api = window.pilion;
    const cid = conversationId;
    if (!api || !isCurrentConversation()) return;
    if (state.agentStatus === 'running') {
      advance({ type: 'interrupt' });
      const cancelled = await run(async () => {
        if (isCurrentConversation()) await api.agents.cancel(cid);
      });
      let idleState: AppState | undefined;
      if (cancelled && isCurrentConversation())
        await waitUntilIdle(async () => {
          idleState = undefined;
          if (!isCurrentConversation()) throw new MessageNotSentError();
          const snapshot = await api.getState();
          if (!isCurrentConversation() || snapshot.activeConversationId !== cid)
            throw new MessageNotSentError();
          idleState = snapshot;
          return snapshot;
        });
      if (!idleState || !isCurrentConversation()) {
        advance({ type: 'interrupt-aborted' });
        return;
      }
    } else if (busy) {
      const entry = composerStore.get(composerKey);
      enqueue(entry.draft, entry.attachments);
      updateEntry((current) => setEntryAttachments(setEntryDraft(current, ''), []));
      return;
    }
    // 队列按提交这一刻的内容合并：打断期间用户删掉的条目不会被发出去。
    const entry = composerStore.get(composerKey);
    const pending = mergeQueue(entry.queue);
    const text = [entry.draft.trim(), pending.text].filter(Boolean).join('\n\n');
    const sent: SentPrompt = {
      text,
      draft: entry.draft,
      attachments: [...entry.attachments, ...pending.attachments],
      queueIds: entry.queue.map((item) => item.id),
    };
    if (!text) {
      advance({ type: 'interrupt-aborted' });
      if (sent.attachments.length) setNotice('请补一句文字说明再发送图片');
      return;
    }
    await submit(sent);
  };

  // 队列只在「非空、Agent 空闲就绪、面板没有别的操作在途、没被挡住」时合并成一条发出。
  // 停止或接管后不会在 stopping 的半路发、更不会替用户结束接管；发不出去的队列留在原处。
  const paused = Boolean(state.recording) || state.replay?.status === 'running';
  const hold = queueHold({ queue, queueBlocked }, manual);
  const gate = {
    hasAgent: Boolean(agent),
    agentStatus: state.agentStatus,
    manual,
    settling,
    paused,
  };
  const autoFlush = canAutoFlush({ queue, queueBlocked }, gate);
  const flushQueue = useEffectEvent(() => {
    // 放到下一个微任务里再看一次：条件在这之间变了（又开始提交、被接管）就不发。
    const entry = composerStore.get(composerKey);
    if (!canAutoFlush(entry, gate) || phaseRef.current.kind !== 'idle') return;
    const pending = mergeQueue(entry.queue);
    void submit({
      text: pending.text,
      attachments: pending.attachments,
      queueIds: entry.queue.map((item) => item.id),
    });
  });
  useEffect(() => {
    if (!autoFlush) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) flushQueue();
    });
    return () => {
      cancelled = true;
    };
  }, [autoFlush]);

  useEffect(() => {
    if (manual) composer.current?.focus();
  }, [manual]);
  // 输入框文字以 store 为准：挂载时取回本对话草稿，被撤回、被收下时同步过来；用户打字再写回 store。
  useEffect(() => {
    const thread = runtime.thread.composer;
    const pull = () => {
      const draft = composerStore.get(composerKey).draft;
      if (thread.getState().text !== draft) thread.setText(draft);
    };
    pull();
    const offStore = composerStore.subscribe(composerKey, pull);
    const offRuntime = thread.subscribe(() => {
      const text = thread.getState().text;
      composerStore.update(composerKey, (entry) => setEntryDraft(entry, text));
    });
    return () => {
      offStore();
      offRuntime();
    };
  }, [runtime, composerStore, composerKey]);
  async function configure(action: () => Promise<unknown>) {
    setConfiguring(true);
    try {
      await run(action);
    } finally {
      setConfiguring(false);
    }
  }

  const task = conversation?.task;
  const isActiveStatus =
    manual ||
    task?.status === 'stopped' ||
    task?.status === 'running' ||
    state.agentStatus === 'running';
  const statusText = manual
    ? '等待继续'
    : task?.status === 'stopped'
      ? '任务已停止'
      : task?.status === 'running' || state.agentStatus === 'running'
        ? 'Agent 正在工作'
        : statusCopy[state.agentStatus];
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  const extraTabsCount = Math.max(0, state.tabs.length - (activeTab ? 1 : 0));
  const conversations = state.conversations ?? [];
  const otherApprovalsCount = Object.entries(state.pendingApprovalsByConversation ?? {}).reduce(
    (sum, [id, count]) => (id === state.activeConversationId ? sum : sum + count),
    0,
  );
  const filteredSessions = [...conversations]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .filter((item) => {
      const q = sessionQuery.trim().toLowerCase();
      return !q || item.title.toLowerCase().includes(q);
    });

  const selectConversation = (id: string) => {
    setSessionMenuOpen(false);
    setSessionQuery('');
    void run(() => window.pilion.workspace.selectConversation(id));
  };

  const isEmpty = view === 'chat' && groupedMessages.length === 0;
  const activeTabLabel = activeTab
    ? activeTab.title && activeTab.url !== 'about:blank'
      ? activeTab.title
      : formatTabHost(activeTab.url, activeTab.title)
    : `${state.tabs.length} 个标签页`;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root
        className={clsx('ai-workspace', { 'is-floating': floating, 'is-empty': isEmpty })}
        aria-label="Pilion AI 工作区"
      >
        {externalApprovals[0] && (
          <InlineApproval
            key={externalApprovals[0].approvalId}
            approval={externalApprovals[0]}
            count={externalApprovals.length}
            run={run}
          />
        )}
        <header className={clsx('chat-header', { 'is-installing': Boolean(state.adapterInstall) })}>
          <div className="session-anchor" ref={sessionPopover}>
            <button
              type="button"
              className={clsx('session-trigger', {
                'is-quiet': isEmpty && conversations.length <= 1,
              })}
              aria-label={`切换会话：${conversation?.title || '新对话'}`}
              aria-expanded={sessionMenuOpen}
              onClick={() => {
                setSessionQuery('');
                setMoreMenuOpen(false);
                setSessionMenuOpen((open) => !open);
              }}
            >
              {connecting ? (
                <LoaderCircle size={12} className="connection-spinner spin" />
              ) : (
                <i className={clsx('conn-dot', agent && state.agentStatus, { off: !agent })} />
              )}
              <span className="session-title">{conversation?.title || '新对话'}</span>
              {otherApprovalsCount > 0 && (
                <span className="session-badge" title={`${otherApprovalsCount} 项其他会话待审批`}>
                  {otherApprovalsCount}
                </span>
              )}
              <ChevronDown size={12} className="session-chev" />
            </button>
            {sessionMenuOpen && (
              <div className="session-popover" role="dialog" aria-label="会话切换">
                <div className="session-search-wrap">
                  <Search size={12} />
                  <input
                    autoFocus
                    type="text"
                    aria-label="搜索会话"
                    placeholder="搜索会话…"
                    value={sessionQuery}
                    onChange={(event) => setSessionQuery(event.target.value)}
                  />
                </div>
                <div className="session-list" role="tablist" aria-label="会话列表">
                  {filteredSessions.length === 0 ? (
                    <div className="session-empty">没有匹配的会话</div>
                  ) : (
                    filteredSessions.map((item) => {
                      const badge = state.pendingApprovalsByConversation?.[item.id] ?? 0;
                      const selected = item.id === state.activeConversationId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          className={clsx('session-item', { 'is-current': selected })}
                          onClick={() => selectConversation(item.id)}
                        >
                          <div className="session-item-main">
                            <span className="session-item-title">{item.title || '新对话'}</span>
                            <span className="session-item-meta">
                              {item.agentName ? `${item.agentName} · ` : ''}
                              {item.messages.length > 0
                                ? `${item.messages.length} 条消息`
                                : '空会话'}
                            </span>
                          </div>
                          {badge > 0 && (
                            <span className="session-item-badge" aria-label={`${badge} 项待审批`}>
                              {badge}
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="header-actions">
            <IconButton
              label="新对话"
              title="新对话"
              onClick={() => {
                setView('chat');
                void run(() => window.pilion.workspace.newConversation());
              }}
            >
              <Plus size={15} />
            </IconButton>
            <div className="panel-more-anchor" ref={moreMenuRef}>
              <IconButton
                label="更多操作"
                title="活动审计 · 任务总览 · Agent 设置"
                className={clsx({ 'has-badge': approvals.length > 0 })}
                onClick={() => {
                  setSessionMenuOpen(false);
                  setMoreMenuOpen((open) => !open);
                }}
              >
                <MoreVertical size={15} />
              </IconButton>
              <div className="panel-more-menu" role="menu" hidden={!moreMenuOpen}>
                <div className="seg" role="group" aria-label="视图">
                  <button
                    type="button"
                    aria-pressed={view === 'chat'}
                    onClick={() => {
                      setView('chat');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <MessageSquare size={12} />
                    <span>对话</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === 'activity'}
                    onClick={() => {
                      setView('activity');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <ListFilter size={12} />
                    <span>审计</span>
                    {approvals.length > 0 && <span className="seg-badge">{approvals.length}</span>}
                  </button>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    openTaskOverview?.();
                  }}
                >
                  <LayoutGrid size={13} />
                  <span>任务总览</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    settings();
                  }}
                >
                  <Settings2 size={13} />
                  <span>管理 Agent</span>
                </button>
              </div>
            </div>
            {toggleFloat && (
              <IconButton
                label={floating ? '停靠到右侧' : '切换为悬浮窗'}
                title={floating ? '停靠到主窗口右侧' : '弹出为独立悬浮窗'}
                onClick={toggleFloat}
              >
                {floating ? <PanelRight size={15} /> : <PictureInPicture2 size={15} />}
              </IconButton>
            )}
            <IconButton label="收起协作栏" title="关闭面板" onClick={close}>
              <X size={15} />
            </IconButton>
          </div>
        </header>
        {(state.adapterInstall || connecting) && (
          <AdapterInstallProgress
            install={state.adapterInstall}
            className="agent-selector-status"
            fallback={connecting ? '正在连接 Agent…' : undefined}
          />
        )}
        {isActiveStatus && (
          <div className="statusbar statusbar-live">
            <span
              className={clsx('status-text', {
                'is-run': task?.status === 'running' || state.agentStatus === 'running',
                'is-manual': manual,
              })}
            >
              <span className="dot" />
              <span className="txt">{statusText}</span>
            </span>
          </div>
        )}
        {view === 'activity' ? (
          <div className="transcript activity-view">
            <div className="audit-heading">操作与审批审计</div>
            {approvals.map((item) => (
              <div className="approval-row" key={item.approvalId}>
                <span className="appr-dot" aria-hidden="true" />
                <div className="approval-row-body">
                  <strong>{item.tool || '等待你的确认'}</strong>
                  <p>{item.summary}</p>
                </div>
              </div>
            ))}
            {state.events.length ? (
              [...state.events].reverse().map((event, index) => (
                <div className="activity-row" key={`${index}-${event}`}>
                  {event}
                </div>
              ))
            ) : approvals.length === 0 ? (
              <div className="empty-activity">
                <span className="empty-activity-symbol">
                  <Activity size={18} aria-hidden="true" />
                </span>
                <strong>暂无活动</strong>
                <span className="empty-activity-sub">
                  Agent 操作页面或等待你确认时，过程会实时显示在这里。
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="transcript-wrap">
            <ThreadPrimitive.Viewport ref={viewportRef} className="transcript" autoScroll>
              <ThreadPrimitive.Empty>
                <div className="agent-empty gemini-empty">
                  <div className="gemini-empty-hero">
                    <PilionMark size={34} colorful />
                    <h3 aria-label="新对话">有什么想让我帮你做的？</h3>
                  </div>
                  <div className="pill-suggestions">
                    {suggestions.map(({ icon: Icon, label, text, tag }) => (
                      <button
                        key={label}
                        type="button"
                        className="s-pill"
                        aria-label={label}
                        onClick={() => {
                          runtime.thread.composer.setText(text);
                          // The draft is worth keeping either way, but with nothing connected the
                          // next useful move is choosing an Agent, not typing more.
                          if (agent) composer.current?.focus();
                          else {
                            setNeedsAgent(true);
                            agentPicker.current?.focus();
                          }
                        }}
                      >
                        <Icon size={14} />
                        <span>{label}</span>
                        {tag && <span className="s-pill-tag">{tag}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
              {state.agentStatus === 'running' && (
                <div className="working-pill" role="status" aria-live="polite">
                  <span className="typing-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="working-pill-text">Agent 正在工作</span>
                </div>
              )}
            </ThreadPrimitive.Viewport>
            <div className="fade-top" aria-hidden="true" />
            <div className="fade-bottom" aria-hidden="true" />
            <ThreadPrimitive.ScrollToBottom
              className="scroll-fab"
              aria-label="回到最新消息"
              title="回到最新消息"
            >
              <ArrowDown size={16} />
            </ThreadPrimitive.ScrollToBottom>
          </div>
        )}
        {approvals[0] && (
          <InlineApproval
            key={approvals[0].approvalId}
            approval={approvals[0]}
            count={approvals.length}
            run={run}
          />
        )}
        <TaskControlBar task={task} conversationId={conversationId} busy={busy} run={run} />
        <div className="composer-area">
          <QueuedMessages
            queue={queue}
            hold={hold}
            locked={locked}
            onRecall={recall}
            onRemove={removeQueued}
          />
          <SkillProposalPanel
            proposals={state.skillProposals ?? []}
            conversationId={conversationId}
            skills={state.skills ?? []}
            run={run}
          />
          <ConversationAgentNotice
            view={state.conversationAgents?.[state.activeConversationId ?? '']}
            agents={state.agents}
            busy={busy}
            run={run}
          />
          {notice && (
            <div className="composer-notice" role="status">
              <span>{notice}</span>
              <button
                type="button"
                className="composer-notice-action"
                onClick={() => setNotice(undefined)}
              >
                知道了
              </button>
            </div>
          )}
          {manual && (
            <div className="composer-notice" role="status">
              <MessageSquare size={13} />
              <span>补充一句你刚才做了什么，Agent 就不用重新摸索；也可以直接继续。</span>
            </div>
          )}
          {!agent && needsAgent && (
            <div className="composer-notice" role="status">
              <Plug size={13} />
              <span>还没有连接 Agent，先在下方选择一个</span>
              <button type="button" className="composer-notice-action" onClick={() => settings()}>
                连接设置
              </button>
            </div>
          )}
          <ComposerPrimitive.Root
            className="composer"
            onSubmit={(event) => {
              // 拦下 assistant-ui 自带的 send，改走「主进程收下才清」的 submitDraft。
              event.preventDefault();
              submitDraft();
            }}
          >
            <ComposerInput
              runtime={runtime.thread.composer}
              inputRef={composer}
              busy={busy}
              locked={locked}
              imageCapable={Boolean(state.agentImageCapable)}
              skills={state.skills ?? []}
              tabs={state.tabs}
              attachments={attachments}
              setAttachments={setAttachments}
              onNotice={setNotice}
              onEnqueue={enqueue}
              onInterruptAndSend={interruptAndSend}
              placeholder={
                conversation?.task?.status === 'manual'
                  ? '补充说明后发送，继续任务…'
                  : agent
                    ? '输入任务，@ 引用标签页、/ 调用技能…'
                    : '输入任务，或先选择下方 Agent…'
              }
              contextStrip={
                agent ? (
                  <div className="share-strip">
                    {attached ? (
                      <>
                        <span className="context-chip-dot" aria-hidden="true" />
                        <span
                          className="share-strip-text"
                          title={`正在分享“${activeTabLabel}”标签页（共 ${state.tabs.length} 个标签页）`}
                        >
                          正在分享“{activeTabLabel}”标签页
                          {extraTabsCount > 0 ? ` +${extraTabsCount}` : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <Link2 size={12} />
                        <span className="share-strip-text is-muted">浏览器由你掌控</span>
                      </>
                    )}
                    <IconButton
                      label={attached ? '暂停浏览器权限' : '共享浏览器'}
                      title={attached ? '停止分享标签页' : '恢复分享标签页'}
                      onClick={() =>
                        void run(async () => {
                          if (!isCurrentConversation()) return;
                          if (attached) await window.pilion.agents.detach(conversationId);
                          else await window.pilion.agents.attach(conversationId);
                        })
                      }
                    >
                      {attached ? <X size={13} /> : <Link2 size={12} />}
                    </IconButton>
                  </div>
                ) : null
              }
              footerLeft={
                <>
                  <label className="control-chip" title="权限类型">
                    <ShieldCheck size={12} />
                    <Select
                      ariaLabel="权限类型"
                      value={permissionMode}
                      disabled={busy || !window.pilion}
                      onValueChange={(value) =>
                        void configure(() =>
                          window.pilion.agents.setMode(value as PermissionMode, conversation?.id),
                        )
                      }
                      options={[
                        { value: 'full', label: '完全访问' },
                        { value: 'ask', label: '操作前确认' },
                      ]}
                    />
                  </label>
                  <label className="control-chip control-chip-ghost" title="选择 Agent">
                    <Select
                      triggerRef={agentPicker}
                      ariaLabel={
                        pinnedHeader
                          ? `当前对话的 Agent：${pinnedHeader.name}（${pinnedHeader.state === 'connecting' ? '连接中' : '不可用'}）`
                          : '选择 Agent'
                      }
                      value={pinnedHeader ? '__pinned__' : (state.connectedAgentId ?? '')}
                      placeholder="选择 Agent"
                      disabled={busy || Boolean(pinnedHeader)}
                      className="agent-picker"
                      onValueChange={(value) => {
                        if (value.startsWith('preset:'))
                          settings(value.slice(7) as LocalAgentPreset);
                        else if (value === 'add') settings();
                        else if (value) {
                          setSwitchingAgent(true);
                          void run(async () => {
                            try {
                              await window.pilion.agents.connect(value);
                            } finally {
                              setSwitchingAgent(false);
                            }
                          });
                        }
                      }}
                      options={[
                        ...(pinnedHeader
                          ? [
                              {
                                value: '__pinned__',
                                label: `${pinnedHeader.name}（${pinnedHeader.state === 'connecting' ? '连接中' : '不可用'}）`,
                                disabled: true,
                              },
                            ]
                          : []),
                        ...state.agents.map((item) => ({ value: item.id, label: item.name })),
                        ...LOCAL_AGENTS.filter(
                          (preset) => !state.agents.some((item) => item.preset === preset.id),
                        ).map((preset) => ({ value: `preset:${preset.id}`, label: preset.name })),
                        { value: 'add', label: '添加 Agent…' },
                      ]}
                    />
                  </label>
                  {agent && (state.agentModels?.length ?? 0) > 0 && (
                    <label className="control-chip control-chip-ghost" title="模型">
                      <Select
                        ariaLabel="模型"
                        value={state.agentModel ?? ''}
                        placeholder="默认模型"
                        disabled={busy || !state.agentModels?.length}
                        onValueChange={(value) =>
                          void configure(() => window.pilion.agents.setModel(value))
                        }
                        options={
                          state.agentModels?.map((item) => ({
                            value: item.value,
                            label: item.name,
                          })) ?? []
                        }
                      />
                    </label>
                  )}
                </>
              }
              footerRight={
                state.agentStatus === 'running' ? (
                  <ComposerPrimitive.Cancel
                    className="send-button"
                    aria-label="停止任务"
                    title="停止任务（⌘/Ctrl+Enter 打断并发送）"
                  >
                    <CircleStop size={16} />
                  </ComposerPrimitive.Cancel>
                ) : agent ? (
                  <SendButton
                    runtime={runtime.thread.composer}
                    hasAttachments={attachments.length > 0}
                    disabled={busy}
                  />
                ) : (
                  <button
                    type="button"
                    className="send-button connect-button"
                    aria-label="连接 Agent"
                    title="连接 Agent"
                    disabled={busy}
                    onClick={() => {
                      setNeedsAgent(true);
                      agentPicker.current?.focus();
                    }}
                  >
                    <Plug size={15} />
                  </button>
                )
              }
            />
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

/** 发送按钮自己订阅输入框文字，按键时不必让整个面板重渲染。 */
function SendButton({
  runtime,
  hasAttachments,
  disabled,
}: {
  runtime: ThreadComposerRuntime;
  hasAttachments: boolean;
  disabled: boolean;
}) {
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const readText = () => runtime.getState().text;
  const text = useSyncExternalStore(subscribe, readText, readText);
  return (
    <button
      type="submit"
      className="send-button"
      aria-label="发送"
      title="发送"
      disabled={disabled || (!text.trim() && !hasAttachments)}
    >
      <ArrowUp size={15} />
    </button>
  );
}
