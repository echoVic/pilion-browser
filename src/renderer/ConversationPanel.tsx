import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  MessageNotSentError,
} from '@assistant-ui/react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleStop,
  FileText,
  Globe2,
  Link2,
  LoaderCircle,
  MessageSquare,
  Plug,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SquarePen,
  Unplug,
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
import { dispatchPrompt, toThreadMessage } from './chat-adapter';
import { QueuedMessages } from './composer/QueuedMessages';
import { SkillProposalPanel } from './composer/SkillProposalPanel';
import {
  enqueue as queueEnqueue,
  mergeQueue,
  recall as queueRecall,
  remove as queueRemove,
  waitUntilIdle,
  type QueuedMessage,
} from './composer/queue';
import { LOCAL_AGENTS, type LocalAgentPreset } from '../shared/local-agents';
import { IconButton, hostname, statusCopy } from './ui';
import { AdapterInstallProgress } from './AdapterInstallProgress';

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
  const agentPicker = useRef<HTMLSelectElement>(null);
  const [initialDraft] = useState(draft);
  const conversation = state.conversations?.find((item) => item.id === state.activeConversationId);
  const agent = state.agents.find((item) => item.id === state.connectedAgentId);
  const active = state.tabs.find((item) => item.id === state.activeTabId);
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
      if (!window.pilion) return;
      setDispatching(true);
      setView('chat');
      try {
        await run(async () => {
          try {
            await dispatchPrompt(window.pilion!, text, attachments);
          } catch (error) {
            if (error instanceof MessageNotSentError) setNotice(error.message);
            throw error;
          }
        });
      } catch {
        /* 失败已在历史里留痕，不自动重发 */
      } finally {
        setDispatching(false);
      }
    },
    [run],
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
      syncAttachments([]);
      await sendNow(text, attachments);
    },
    onCancel: async () => {
      await run(() => window.pilion.agents.cancel());
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
      if (!window.pilion) return;
      if (state.agentStatus === 'running') {
        await run(() => window.pilion!.agents.cancel());
        await waitUntilIdle(() => window.pilion!.getState());
      }
      const merged = mergeQueue(queuedRef.current);
      const finalText = [text.trim(), merged.text].filter(Boolean).join('\n\n');
      const finalAttachments = [...attachments, ...merged.attachments];
      syncQueue([]);
      syncAttachments([]);
      runtime.thread.composer.setText('');
      if (!finalText && finalAttachments.length === 0) return;
      await sendNow(finalText, finalAttachments);
    },
    [state.agentStatus, run, sendNow, runtime],
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
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ai-workspace" aria-label="Pilion AI 工作区">
        <header className="agent-header">
          <div className="agent-heading">
            <span className="agent-avatar">
              <MessageSquare size={15} />
            </span>
            <h2>Agent</h2>
          </div>
          <div>
            <IconButton
              label="新对话"
              disabled={busy || !window.pilion}
              onClick={() => void run(() => window.pilion.workspace.newConversation())}
            >
              <SquarePen size={17} />
            </IconButton>
            <IconButton label="隐藏 Agent 面板" onClick={close}>
              <X size={17} />
            </IconButton>
          </div>
        </header>
        <div
          className={clsx('agent-selector', {
            'is-connecting': connecting,
            'is-installing': Boolean(state.adapterInstall),
          })}
        >
          <div>
            {connecting ? (
              <LoaderCircle size={13} className="connection-spinner spin" />
            ) : (
              <i className={clsx('connection-dot', agent && state.agentStatus)} />
            )}
            <select
              ref={agentPicker}
              aria-label="选择 Agent"
              value={state.connectedAgentId ?? ''}
              disabled={busy}
              onChange={(event) => {
                if (event.target.value.startsWith('preset:'))
                  settings(event.target.value.slice(7) as LocalAgentPreset);
                else if (event.target.value === 'add') settings();
                else if (event.target.value) {
                  setSwitchingAgent(true);
                  void run(async () => {
                    try {
                      await window.pilion.agents.connect(event.target.value);
                    } finally {
                      setSwitchingAgent(false);
                    }
                  });
                }
              }}
            >
              <option value="" disabled>
                选择 Agent
              </option>
              {state.agents.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
              {LOCAL_AGENTS.filter(
                (preset) => !state.agents.some((item) => item.preset === preset.id),
              ).map((preset) => (
                <option value={`preset:${preset.id}`} key={preset.id}>
                  {preset.name}
                </option>
              ))}
              <option value="add">添加 Agent…</option>
            </select>
            <ChevronDown size={13} />
          </div>
          <AdapterInstallProgress
            install={state.adapterInstall}
            className="agent-selector-status"
            fallback={connecting ? '正在连接 Agent…' : undefined}
          />
          {(() => {
            const cid = state.activeConversationId;
            if (!cid) return null;
            const ca = state.conversationAgents?.[cid];
            if (!ca || ca.state === 'none' || ca.state === 'ready' || ca.state === 'running')
              return null;
            const text =
              ca.state === 'connecting'
                ? '正在连接 Agent…'
                : ca.state === 'unavailable'
                  ? `原 Agent「${ca.agentName ?? ''}」不可用，请选用其他 Agent`
                  : ca.state === 'capacity'
                    ? '会话已满，请先结束一些任务'
                    : `连接失败：${ca.error ?? ''}（可重试）`;
            return <div className="agent-conversation-status">{text}</div>;
          })()}
          <IconButton label="管理 Agent" onClick={() => settings()}>
            <Settings2 size={15} />
          </IconButton>
        </div>
        <div className="panel-tabs">
          <button className={clsx({ selected: view === 'chat' })} onClick={() => setView('chat')}>
            对话
          </button>
          <button
            className={clsx({ selected: view === 'activity' })}
            onClick={() => setView('activity')}
          >
            活动
            {state.approvals.length > 0 && <span className="count">{state.approvals.length}</span>}
          </button>
          <span>
            {conversation?.task?.status === 'manual'
              ? '等待继续'
              : conversation?.task?.status === 'stopped'
                ? '任务已停止'
                : statusCopy[state.agentStatus]}
          </span>
        </div>
        {view === 'activity' ? (
          <div className="transcript">
            <div className="activity-list">
              {state.approvals.map((item) => (
                <div className="approval-row" key={item.approvalId}>
                  <ShieldCheck size={17} />
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
                <div className="empty-activity">暂无活动</div>
              )}
            </div>
          </div>
        ) : (
          <ThreadPrimitive.Viewport className="transcript" autoScroll>
            <ThreadPrimitive.Empty>
              <div className="agent-empty">
                <span className="empty-agent-symbol">
                  <MessageSquare size={24} strokeWidth={1.5} />
                </span>
                <h3>新对话</h3>
                <div className="suggestion-list">
                  {suggestions.map(({ icon: Icon, label, text }) => (
                    <button
                      key={label}
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
                      <Icon size={16} />
                      <span>{label}</span>
                      <Plus size={14} />
                    </button>
                  ))}
                </div>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
            {state.agentStatus === 'running' && (
              <div className="working">
                <LoaderCircle size={14} className="spin" />
                Agent 正在工作
              </div>
            )}
            <ThreadPrimitive.ScrollToBottom
              className="scroll-latest icon-button"
              aria-label="回到最新消息"
              title="回到最新消息"
            >
              <ArrowDown size={16} />
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>
        )}
        {state.approvals[0] && (
          <InlineApproval
            key={state.approvals[0].approvalId}
            approval={state.approvals[0]}
            count={state.approvals.length}
            run={run}
          />
        )}
        <div className="composer-area">
          <QueuedMessages queue={queuedView} onRecall={recall} onRemove={removeQueued} />
          <SkillProposalPanel
            proposals={state.skillProposals ?? []}
            skills={state.skills ?? []}
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
            <div className={clsx('page-context', { attached })}>
              <Link2 size={13} />
              <span>{attached ? `已共享 ${state.tabs.length} 个标签页` : '浏览器权限已暂停'}</span>
              <IconButton
                label={attached ? 'Detach' : 'Attach'}
                onClick={() =>
                  void run(() =>
                    attached ? window.pilion.agents.detach() : window.pilion.agents.attach(),
                  )
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
            <div className="composer-options">
              <label title="权限类型">
                <ShieldCheck size={13} />
                <select
                  aria-label="权限类型"
                  value={state.permissionMode ?? 'full'}
                  disabled={busy || !window.pilion}
                  onChange={(event) =>
                    void configure(() =>
                      window.pilion.agents.setMode(event.target.value as PermissionMode),
                    )
                  }
                >
                  <option value="full">完全访问</option>
                  <option value="ask">操作前确认</option>
                </select>
              </label>
              <label title="模型">
                <select
                  aria-label="模型"
                  value={state.agentModel ?? ''}
                  disabled={busy || !state.agentModels?.length}
                  onChange={(event) =>
                    void configure(() => window.pilion.agents.setModel(event.target.value))
                  }
                >
                  {!state.agentModels?.length && (
                    <option value="">{agent ? 'Agent 默认模型' : '连接后选择模型'}</option>
                  )}
                  {state.agentModels?.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="composer-toolbar">
              <span>
                <Globe2 size={13} />
                {hostname(active?.url)}
              </span>
              {state.agentStatus === 'running' ? (
                <ComposerPrimitive.Cancel
                  className="send-button"
                  aria-label="停止任务"
                  title="停止任务"
                >
                  <CircleStop size={20} />
                </ComposerPrimitive.Cancel>
              ) : agent ? (
                <ComposerPrimitive.Send className="send-button" aria-label="发送" title="发送">
                  <ArrowUp size={19} />
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
                  <Plug size={17} />
                </button>
              )}
            </div>
          </ComposerPrimitive.Root>
          <div className="composer-status">
            <ShieldCheck size={12} />
            <span>
              {attached
                ? state.permissionMode === 'ask'
                  ? '操作前需要确认'
                  : '完全访问 · 自动批准'
                : '浏览器由你掌控'}
            </span>
          </div>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
