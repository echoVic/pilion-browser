import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Copy,
  FileText,
  Globe2,
  Link2,
  LoaderCircle,
  MessageSquare,
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
} from '../shared/contracts';
import { InlineApproval } from './InlineApproval';
import { LOCAL_AGENTS, type LocalAgentPreset } from '../shared/local-agents';
import { IconButton, hostname, statusCopy } from './ui';

function Message({
  message,
  navigate,
}: {
  message: ConversationMessage;
  navigate(url: string): void;
}) {
  const [copied, setCopied] = useState(false);
  if (message.role === 'thought')
    return (
      <details className="thought">
        <summary>思考过程</summary>
        <div>{message.text}</div>
      </details>
    );
  if (message.role === 'tool')
    return (
      <div className={`tool-message ${message.status ?? ''}`}>
        {message.status === 'running' ? (
          <LoaderCircle size={14} className="spin" />
        ) : message.status === 'failed' ? (
          <CircleAlert size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>{message.text}</span>
      </div>
    );
  if (message.role === 'system')
    return (
      <div className="message-error" role="alert">
        <CircleAlert size={16} />
        {message.text}
      </div>
    );
  return (
    <article className={`message ${message.role}`}>
      {message.role === 'assistant' && (
        <div className="message-author">
          <span className="agent-avatar">
            <MessageSquare size={12} />
          </span>
          Agent
        </div>
      )}
      <div className="message-body">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <button
                className="markdown-link"
                onClick={() => {
                  if (href && /^https?:\/\//.test(href)) navigate(href);
                }}
              >
                {children}
              </button>
            ),
          }}
        >
          {message.text}
        </Markdown>
      </div>
      {message.role === 'assistant' && message.status !== 'running' && (
        <div className="message-footer">
          <time>
            {new Date(message.time).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <IconButton
            label={copied ? '已复制' : '复制回复'}
            onClick={async () => {
              try {
                await window.pilion.workspace.copyMessage(message.id);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </IconButton>
        </div>
      )}
    </article>
  );
}
export function ConversationPanel({
  state,
  settings,
  close,
  run,
  draft,
  setDraft,
}: {
  state: AppState;
  settings(preset?: LocalAgentPreset): void;
  close(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
  draft: string;
  setDraft(text: string): void;
}) {
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  async function configure(action: () => Promise<unknown>) {
    setConfiguring(true);
    try {
      await run(action);
    } finally {
      setConfiguring(false);
    }
  }
  const conversation = state.conversations?.find(
    (item) => item.id === state.activeConversationId,
  );
  const messages = conversation?.messages;
  const agent = state.agents.find((item) => item.id === state.connectedAgentId);
  const active = state.tabs.find((item) => item.id === state.activeTabId);
  const busy =
    ['running', 'starting', 'stopping'].includes(state.agentStatus) ||
    submitting ||
    configuring;
  const attached = state.attachmentStatus === 'attached';
  useEffect(() => {
    if (follow.current)
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [messages, state.agentStatus]);
  async function submit() {
    if (busy || sending.current) return;
    if (!agent) {
      settings();
      return;
    }
    if (!draft.trim()) return;
    if (!attached && !(await run(() => window.pilion.agents.attach()))) return;
    const text = draft.trim();
    sending.current = true;
    setSubmitting(true);
    setDraft('');
    follow.current = true;
    setView('chat');
    try {
      if (!(await run(() => window.pilion.agents.task(text)))) setDraft(text);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }
  function suggest(text: string) {
    setDraft(text);
    composer.current?.focus();
  }
  return (
    <aside className="ai-workspace" aria-label="Pilion AI 工作区">
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
            onClick={() =>
              void run(() => window.pilion.workspace.newConversation())
            }
          >
            <SquarePen size={17} />
          </IconButton>
          <IconButton label="隐藏 Agent 面板" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
      </header>
      <div className="agent-selector">
        <div>
          <i className={`connection-dot ${agent ? state.agentStatus : ''}`} />
          <select
            aria-label="选择 Agent"
            value={state.connectedAgentId ?? ''}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value.startsWith('preset:'))
                settings(event.target.value.slice(7) as LocalAgentPreset);
              else if (event.target.value === 'add') settings();
              else if (event.target.value)
                void run(() =>
                  window.pilion.agents.connect(event.target.value),
                );
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
              (preset) =>
                !state.agents.some((agent) => agent.preset === preset.id),
            ).map((preset) => (
              <option value={`preset:${preset.id}`} key={preset.id}>
                {preset.name}
              </option>
            ))}
            <option value="add">添加 Agent…</option>
          </select>
          <ChevronDown size={13} />
        </div>
        <IconButton label="管理 Agent" onClick={() => settings()}>
          <Settings2 size={15} />
        </IconButton>
      </div>
      <div className="panel-tabs">
        <button
          className={view === 'chat' ? 'selected' : ''}
          onClick={() => setView('chat')}
        >
          对话
        </button>
        <button
          className={view === 'activity' ? 'selected' : ''}
          onClick={() => setView('activity')}
        >
          活动
          {state.approvals.length > 0 && (
            <span className="count">{state.approvals.length}</span>
          )}
        </button>
        <span>{statusCopy[state.agentStatus]}</span>
      </div>
      <div
        className="transcript"
        ref={transcript}
        onScroll={() => {
          const node = transcript.current;
          if (node)
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {view === 'activity' ? (
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
        ) : (
          <>
            {messages?.length ? (
              messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  navigate={(url) =>
                    void run(() => window.pilion.tabs.open(url))
                  }
                />
              ))
            ) : (
              <div className="agent-empty">
                <span className="empty-agent-symbol">
                  <MessageSquare size={24} strokeWidth={1.5} />
                </span>
                <h3>新对话</h3>
                <div className="suggestion-list">
                  <button
                    onClick={() =>
                      suggest('总结当前页面的核心内容，列出关键结论和来源。')
                    }
                  >
                    <FileText size={16} />
                    <span>总结当前页面</span>
                    <Plus size={14} />
                  </button>
                  <button
                    onClick={() =>
                      suggest(
                        '围绕当前页面的主题展开研究，对比不同来源，整理成有引用的结论。',
                      )
                    }
                  >
                    <Search size={16} />
                    <span>研究一个主题</span>
                    <Plus size={14} />
                  </button>
                  <button
                    onClick={() =>
                      suggest(
                        '整理已打开的标签页，归纳每个页面的用途和待办事项。',
                      )
                    }
                  >
                    <Globe2 size={16} />
                    <span>整理打开的页面</span>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            )}
            {state.agentStatus === 'running' && (
              <div className="working">
                <LoaderCircle size={14} className="spin" />
                Agent 正在工作
              </div>
            )}
          </>
        )}
      </div>
      {state.approvals[0] && (
        <InlineApproval
          key={state.approvals[0].approvalId}
          approval={state.approvals[0]}
          count={state.approvals.length}
          run={run}
        />
      )}
      <div className="composer-area">
        {agent && (
          <div className={`page-context ${attached ? 'attached' : ''}`}>
            <Link2 size={13} />
            <span>
              {attached
                ? `已共享 ${state.tabs.length} 个标签页`
                : '浏览器权限已暂停'}
            </span>
            <IconButton
              label={attached ? 'Detach' : 'Attach'}
              onClick={() =>
                void run(() =>
                  attached
                    ? window.pilion.agents.detach()
                    : window.pilion.agents.attach(),
                )
              }
            >
              {attached ? <Unplug size={14} /> : <Link2 size={14} />}
            </IconButton>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={composer}
            aria-label="输入任务"
            placeholder={agent ? '输入任务' : '今天想完成什么？'}
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
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
                    window.pilion.agents.setMode(
                      event.target.value as PermissionMode,
                    ),
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
                  void configure(() =>
                    window.pilion.agents.setModel(event.target.value),
                  )
                }
              >
                {!state.agentModels?.length && (
                  <option value="">
                    {agent ? 'Agent 默认模型' : '连接后选择模型'}
                  </option>
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
              <IconButton
                label="停止任务"
                className="send-button"
                onClick={() => void run(() => window.pilion.agents.cancel())}
              >
                <CircleStop size={20} />
              </IconButton>
            ) : (
              <button
                type="submit"
                className="send-button"
                aria-label={agent ? '发送' : '连接 Agent'}
                title={agent ? '发送' : '连接 Agent'}
                disabled={busy || (!draft.trim() && Boolean(agent))}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
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
    </aside>
  );
}
