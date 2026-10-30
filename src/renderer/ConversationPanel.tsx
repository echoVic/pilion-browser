import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  MessageNotSentError,
} from '@assistant-ui/react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircleStop,
  FileText,
  Globe2,
  Link2,
  LoaderCircle,
  MessageSquare,
  PanelRight,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  Unplug,
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
import { dispatchPrompt, toThreadMessage } from './chat-adapter';
import { QueuedMessages } from './composer/QueuedMessages';
import { SkillProposalPanel } from './composer/SkillProposalPanel';
import { ConversationTabs } from './panel/ConversationTabs';
import { TaskControlBar } from './panel/TaskControlBar';
import { ConversationAgentNotice } from './panel/ConversationAgentNotice';
import {
  enqueue as queueEnqueue,
  mergeQueue,
  recall as queueRecall,
  remove as queueRemove,
  waitUntilIdle,
  type QueuedMessage,
} from './composer/queue';
import { LOCAL_AGENTS, type LocalAgentPreset } from '../shared/local-agents';
import { IconButton, Select, statusCopy } from './ui';
import { AdapterInstallProgress } from './AdapterInstallProgress';
import { useManualWheelScroll } from './useManualWheelScroll';

const noMessages: ConversationMessage[] = [];
const suggestions = [
  { icon: FileText, label: '总结当前页面', text: '总结当前页面的核心内容，列出关键结论和来源。' },
  {
    icon: Search,
    label: '研究一个主题',
    text: '围绕当前页面的主题展开研究，对比不同来源，整理成有引用的结论。',
  },
  {
    icon: Globe2,
    label: '整理打开的页面',
    text: '整理已打开的标签页，归纳每个页面的用途和待办事项。',
  },
];
type Props = {
  state: AppState;
  settings(preset?: LocalAgentPreset): void;
  close(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
  draft: string;
  setDraft(text: string): void;
};

export function ConversationPanel(props: Props) {
  // A fresh runtime keeps local message repositories and draft state scoped to a conversation.
  return <ConversationThread key={props.state.activeConversationId ?? 'preview'} {...props} />;
}

function ConversationThread({ state, settings, close, run, draft, setDraft }: Props) {
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const [configuring, setConfiguring] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [needsAgent, setNeedsAgent] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const agentPicker = useRef<HTMLButtonElement>(null);
  // 流式追加与 wheel 同帧竞争时，按当前布局自行结算滚动，避免原生滚动按上一帧边界把上滚钳在半路。
  // callback ref 覆盖视图/会话切换导致 Viewport 卸载重挂的场景。
  const viewportRef = useManualWheelScroll<HTMLDivElement>();
  const [initialDraft] = useState(draft);
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
  const busy =
    ['starting', 'running', 'stopping'].includes(state.agentStatus) || configuring || dispatching;
  const connecting = switchingAgent || state.agentStatus === 'starting';

  // 运行中排队的消息与当前输入框附件：用 ref 让一次性创建的 runtime 回调永远读到最新值。
  const queuedRef = useRef<QueuedMessage[]>([]);
  const [queuedView, setQueuedView] = useState<QueuedMessage[]>([]);
  const attachmentsRef = useRef<PromptAttachment[]>([]);
  const [attachmentsView, setAttachmentsView] = useState<PromptAttachment[]>([]);
  const [notice, setNotice] = useState<string | undefined>();
  const syncQueue = (next: QueuedMessage[]) => {
    queuedRef.current = next;
    setQueuedView(next);
  };
  const syncAttachments = (next: PromptAttachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsView(next);
  };

  const sendNow = useCallback(
    async (text: string, attachments: PromptAttachment[]) => {
      const api = window.pilion;
      if (!api || !isCurrentConversation()) return;
      setDispatching(true);
      setView('chat');
      try {
        await run(async () => {
          if (!isCurrentConversation()) return;
          try {
            await dispatchPrompt(api, text, attachments, conversationId, isCurrentConversation);
          } catch (error) {
            if (isCurrentConversation() && error instanceof MessageNotSentError)
              setNotice(error.message);
            throw error;
          }
        });
      } catch {
        /* 失败已在历史里留痕，不自动重发 */
      } finally {
        if (isCurrentConversation()) setDispatching(false);
      }
    },
    [run, conversationId, isCurrentConversation, setNotice],
  );

  const runtime = useExternalStoreRuntime<ConversationMessage>({
    messages: conversation?.messages ?? noMessages,
    convertMessage: toThreadMessage,
    isRunning: state.agentStatus === 'running' || dispatching,
    isSendDisabled: busy || !agent,
    onNew: async (message) => {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
      const attachments = attachmentsRef.current;
      if ((!text && attachments.length === 0) || !window.pilion) throw new MessageNotSentError();
      if (!isCurrentConversation()) throw new MessageNotSentError('对话已切换，消息未发送');
      syncAttachments([]);
      await sendNow(text, attachments);
    },
    onCancel: async () => {
      await run(async () => {
        if (isCurrentConversation()) await window.pilion.agents.cancel(conversationId);
      });
    },
  });

  const enqueue = useCallback((text: string, attachments: PromptAttachment[]) => {
    syncQueue(queueEnqueue(queuedRef.current, text, attachments));
  }, []);

  const recall = useCallback(
    (id: string) => {
      const { queue, item } = queueRecall(queuedRef.current, id);
      syncQueue(queue);
      if (!item) return;
      // 撤回回输入框：文本前置拼接，附件并到当前附件上。
      const current = runtime.thread.composer.getState().text;
      runtime.thread.composer.setText([item.text, current].filter(Boolean).join('\n'));
      syncAttachments([...item.attachments, ...attachmentsRef.current]);
    },
    [runtime],
  );

  const removeQueued = useCallback(
    (id: string) => syncQueue(queueRemove(queuedRef.current, id)),
    [],
  );

  /** ⌘/Ctrl+Enter：打断当前回合（走现有 session/cancel），收尾后立即发送当前输入并并入队列。 */
  const interruptAndSend = useCallback(
    async (text: string, attachments: PromptAttachment[]) => {
      const api = window.pilion;
      const cid = conversationId;
      if (!api || !isCurrentConversation()) return;
      const finish = (pendingText: string, pendingAttachments: PromptAttachment[]) => {
        if (!isCurrentConversation()) return;
        const finalText = [text.trim(), pendingText].filter(Boolean).join('\n\n');
        const finalAttachments = [...attachments, ...pendingAttachments];
        syncQueue([]);
        syncAttachments([]);
        runtime.thread.composer.setText('');
        if (!finalText && finalAttachments.length === 0) return;
        return sendNow(finalText, finalAttachments);
      };
      if (state.agentStatus !== 'running') {
        const pending = mergeQueue(queuedRef.current);
        return finish(pending.text, pending.attachments);
      }
      // 先把队列认领下来并清空：打断后回到 idle 时，回合结束自动 flush 的 effect 看到空队列就不会再发一遍，
      // 由本函数统一合并当前输入与队列，消除「effect 先把队列 flush 掉、这里 merge 到空队列」的竞态。
      const pending = mergeQueue(queuedRef.current);
      syncQueue([]);
      const cancelled = await run(async () => {
        if (isCurrentConversation()) await api.agents.cancel(cid);
      });
      if (!cancelled || !isCurrentConversation()) return;
      let idleState: AppState | undefined;
      await waitUntilIdle(async () => {
        idleState = undefined;
        if (!isCurrentConversation()) throw new MessageNotSentError();
        const snapshot = await api.getState();
        if (!isCurrentConversation() || snapshot.activeConversationId !== cid)
          throw new MessageNotSentError();
        idleState = snapshot;
        return snapshot;
      });
      if (!idleState || !isCurrentConversation()) return;
      return finish(pending.text, pending.attachments);
    },
    [state.agentStatus, run, sendNow, runtime, conversationId, isCurrentConversation],
  );

  // 回合结束（无论成功、失败还是取消）回到非 running：把排队消息合并成一条发出。
  // 失败/取消也照常发——它们是用户的意图，主进程在 ready 时会把它当新任务收下。
  const prevRunning = useRef(false);
  useEffect(() => {
    const running = state.agentStatus === 'running';
    if (prevRunning.current && !running && queuedRef.current.length > 0) {
      const merged = mergeQueue(queuedRef.current);
      syncQueue([]);
      void sendNow(merged.text, merged.attachments);
    }
    prevRunning.current = running;
  }, [state.agentStatus, sendNow]);

  useEffect(() => {
    if (manual) composer.current?.focus();
  }, [manual]);
  useEffect(() => {
    runtime.thread.composer.setText(initialDraft);
    return runtime.thread.composer.subscribe(() =>
      setDraft(runtime.thread.composer.getState().text),
    );
  }, [runtime, initialDraft, setDraft]);
  async function configure(action: () => Promise<unknown>) {
    setConfiguring(true);
    try {
      await run(action);
    } finally {
      setConfiguring(false);
    }
  }

  const task = conversation?.task;
  const statusText = manual
    ? '等待继续'
    : task?.status === 'stopped'
      ? '任务已停止'
      : task?.status === 'running' || state.agentStatus === 'running'
        ? 'Agent 正在工作'
        : statusCopy[state.agentStatus];

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ai-workspace" aria-label="Pilion AI 工作区">
        {externalApprovals[0] && (
          <InlineApproval
            key={externalApprovals[0].approvalId}
            approval={externalApprovals[0]}
            count={externalApprovals.length}
            run={run}
          />
        )}
        <ConversationTabs
          conversations={state.conversations ?? []}
          activeId={state.activeConversationId}
          approvalsByConversation={state.pendingApprovalsByConversation}
          run={run}
        />
        <header className={clsx('chat-header', { 'is-installing': Boolean(state.adapterInstall) })}>
          <div className="agent-identity">
            <span className="agent-avatar">
              <MessageSquare size={13} />
            </span>
            {connecting ? (
              <LoaderCircle size={13} className="connection-spinner spin" />
            ) : (
              <i className={clsx('conn-dot', agent && state.agentStatus, { off: !agent })} />
            )}
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
                if (value.startsWith('preset:')) settings(value.slice(7) as LocalAgentPreset);
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
          </div>
          <IconButton label="管理 Agent" title="管理 Agent" onClick={() => settings()}>
            <Settings2 size={15} />
          </IconButton>
          <IconButton label="收起面板" title="收起面板" onClick={close}>
            <PanelRight size={16} />
          </IconButton>
          <AdapterInstallProgress
            install={state.adapterInstall}
            className="agent-selector-status"
            fallback={connecting ? '正在连接 Agent…' : undefined}
          />
        </header>
        <div className="statusbar">
          <div className="seg" role="group" aria-label="视图">
            <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>
              对话
            </button>
            <button aria-pressed={view === 'activity'} onClick={() => setView('activity')}>
              活动
              {approvals.length > 0 && <span className="seg-badge">{approvals.length}</span>}
            </button>
          </div>
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
        {view === 'activity' ? (
          <div className="transcript activity-view">
            {approvals.map((item) => (
              <div className="approval-row" key={item.approvalId}>
                <ShieldCheck size={16} />
                <div>
                  <strong>等待你的确认</strong>
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
            ) : (
              <div className="empty-activity">
                <span className="empty-activity-symbol">
                  <Activity size={18} aria-hidden="true" />
                </span>
                <strong>暂无活动</strong>
                <span className="empty-activity-sub">
                  Agent 操作页面或等待你确认时，过程会实时显示在这里。
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="transcript-wrap">
            <ThreadPrimitive.Viewport ref={viewportRef} className="transcript" autoScroll>
              <ThreadPrimitive.Empty>
                <div className="agent-empty">
                  <span className="empty-agent-symbol">
                    <MessageSquare size={22} strokeWidth={1.5} />
                  </span>
                  <h3>新对话</h3>
                  <p className="empty-sub">让 Agent 在当前网页上替你完成任务，或从下面开始：</p>
                  <div className="suggestion-list">
                    {suggestions.map(({ icon: Icon, label, text }) => (
                      <button
                        key={label}
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
                        <Icon size={15} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
              {state.agentStatus === 'running' && (
                <div className="working-pill" role="status" aria-live="polite">
                  <LoaderCircle size={12} className="ic-spin" />
                  Agent 正在工作
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
          <QueuedMessages queue={queuedView} onRecall={recall} onRemove={removeQueued} />
          <SkillProposalPanel
            proposals={state.skillProposals ?? []}
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
              <button type="button" onClick={() => setNotice(undefined)}>
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
              <span>还没有连接 Agent，先在上方选择一个</span>
              <button type="button" onClick={() => settings()}>
                连接设置
              </button>
            </div>
          )}
          {agent && (
            <div className="page-context">
              <Link2 size={13} />
              <span>{attached ? `已共享 ${state.tabs.length} 个标签页` : '浏览器由你掌控'}</span>
              <IconButton
                label={attached ? 'Detach' : 'Attach'}
                onClick={() =>
                  void run(async () => {
                    if (!isCurrentConversation()) return;
                    if (attached) await window.pilion.agents.detach(conversationId);
                    else await window.pilion.agents.attach(conversationId);
                  })
                }
              >
                {attached ? <Unplug size={14} /> : <Link2 size={14} />}
              </IconButton>
            </div>
          )}
          <ComposerPrimitive.Root
            className="composer"
            onSubmit={(event) => {
              if (!agent) {
                // Swapping the page for the settings pane moves the work away from where the
                // draft was written, so the reason is said here and the choice stays in reach.
                event.preventDefault();
                setNeedsAgent(true);
                agentPicker.current?.focus();
              }
            }}
          >
            <ComposerInput
              runtime={runtime.thread.composer}
              inputRef={composer}
              busy={busy}
              imageCapable={Boolean(state.agentImageCapable)}
              skills={state.skills ?? []}
              attachments={attachmentsView}
              setAttachments={syncAttachments}
              onNotice={setNotice}
              onEnqueue={enqueue}
              onInterruptAndSend={interruptAndSend}
              placeholder={
                conversation?.task?.status === 'manual'
                  ? '补充说明后发送，继续任务…'
                  : agent
                    ? '输入任务'
                    : '今天想完成什么？'
              }
            />
            <div className="composer-toolbar">
              <div className="composer-options">
                <label className="control-chip" title="权限类型">
                  <ShieldCheck size={13} />
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
                <label className="control-chip" title="模型">
                  <Select
                    ariaLabel="模型"
                    value={state.agentModel ?? ''}
                    placeholder={agent ? '默认模型' : '连接后选择模型'}
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
              </div>
              {state.agentStatus === 'running' ? (
                <ComposerPrimitive.Cancel
                  className="send-button"
                  aria-label="停止任务"
                  title="停止任务（⌘/Ctrl+Enter 打断并发送）"
                >
                  <CircleStop size={18} />
                </ComposerPrimitive.Cancel>
              ) : agent ? (
                <ComposerPrimitive.Send className="send-button" aria-label="发送" title="发送">
                  <ArrowUp size={18} />
                </ComposerPrimitive.Send>
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
                  <Plug size={16} />
                </button>
              )}
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
