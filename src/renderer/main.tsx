import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Command,
  ExternalLink,
  Globe2,
  Link2,
  Link2Off,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import type { AgentConfig, AgentStatus, AppState } from '../shared/contracts';
import './style.css';

const empty: AppState = {
  tabs: [], agents: [], agentStatus: 'not_configured', attachmentStatus: 'none', approvals: [], events: [],
};

const statusCopy: Record<AgentStatus, string> = {
  not_configured: '等待配置',
  starting: '正在连接',
  ready: '在线',
  running: '正在执行',
  stopping: '正在停止',
  error: '连接异常',
  disconnected: '已断开',
};

const attachmentCopy = { none: '未建立会话', attached: '已附加当前页面', detached: '会话未附加' } as const;

function friendlyHost(url?: string) {
  if (!url) return '新标签页';
  try { return new URL(url).hostname.replace(/^www\./, '') || '本地页面'; } catch { return '输入地址或搜索'; }
}

function eventParts(event: string) {
  const match = event.match(/^(\d{1,2}:\d{2}:\d{2})\s+(.+)$/);
  return match ? { time: match[1], body: match[2] } : { time: '刚刚', body: event };
}

function App() {
  const [state, setState] = useState(empty);
  const [addressDraft, setAddressDraft] = useState({ tabId: '', value: '' });
  const [task, setTask] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [draft, setDraft] = useState({ name: '', command: '', args: '', cwd: '' });
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.pilion.getState().then(setState);
    return window.pilion.onState(setState);
  }, []);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: 'smooth' });
  }, [state.events.length]);

  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  const address = addressDraft.tabId === active?.id ? addressDraft.value : active?.url ?? '';
  const isBusy = ['starting', 'running', 'stopping'].includes(state.agentStatus);
  const canAttach = state.agentStatus === 'ready' && state.attachmentStatus !== 'attached';
  const activeAgentName = state.agents.find(agent => agent.id === selectedAgent)?.name ?? state.agents[0]?.name;

  async function save() {
    const config: AgentConfig = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: draft.args.split(' ').filter(Boolean),
      cwd: draft.cwd.trim() || undefined,
      enabled: true,
    };
    await window.pilion.agents.save(config);
    setSelectedAgent(config.id);
    setDraft({ name: '', command: '', args: '', cwd: '' });
    setSettingsOpen(false);
  }

  function submitTask() {
    if (!task.trim()) return;
    void window.pilion.agents.task(task.trim());
    setTask('');
  }

  return (
    <main className="app-shell">
      <header className="browser-chrome">
        <div className="tab-strip">
          <div className="brand" aria-label="Pilion Browser">
            <span className="brand-mark"><Sparkles size={15} strokeWidth={2.2} /></span>
            <span className="brand-name">Pilion</span>
          </div>
          <div className="tabs" role="tablist" aria-label="浏览器标签页">
            {state.tabs.map(tab => (
              <div className={`tab ${tab.id === state.activeTabId ? 'active' : ''}`} role="presentation" key={tab.id}>
                <button
                  className="tab-target"
                  role="tab"
                  aria-selected={tab.id === state.activeTabId}
                  aria-label={`切换到 ${tab.title}`}
                  title={tab.title}
                  onClick={() => void window.pilion.tabs.activate(tab.id)}
                >
                  {tab.loading ? <LoaderCircle className="spin" size={13} /> : tab.crashed ? <CircleAlert size={13} /> : <Globe2 size={13} />}
                  <span>{tab.title || '新标签页'}</span>
                </button>
                <button className="tab-close" aria-label={`关闭 ${tab.title}`} title="关闭标签页" onClick={() => void window.pilion.tabs.close(tab.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <button className="icon-button new-tab" aria-label="新建标签页" title="新建标签页" onClick={() => void window.pilion.tabs.open()}>
              <Plus size={16} />
            </button>
          </div>
          <button className="icon-button chrome-menu" aria-label="更多浏览器选项" title="更多选项" disabled>
            <MoreHorizontal size={17} />
          </button>
        </div>

        <nav className="navigation" aria-label="浏览器导航">
          <div className="nav-actions">
            <button className="icon-button" aria-label="后退" title="后退" disabled={!active?.canGoBack} onClick={() => void window.pilion.tabs.back()}><ArrowLeft size={17} /></button>
            <button className="icon-button" aria-label="前进" title="前进" disabled={!active?.canGoForward} onClick={() => void window.pilion.tabs.forward()}><ArrowRight size={17} /></button>
            <button className="icon-button" aria-label="重新加载" title="重新加载" onClick={() => void window.pilion.tabs.reload()}><RefreshCw size={16} /></button>
          </div>
          <form className="address-form" onSubmit={event => { event.preventDefault(); void window.pilion.tabs.navigate(address); }}>
            <ShieldCheck className="address-security" size={15} aria-hidden="true" />
            <input
              value={address}
              onChange={event => setAddressDraft({ tabId: active?.id ?? '', value: event.target.value })}
              aria-label="地址"
              title="地址栏"
              placeholder="输入网址"
              spellCheck={false}
            />
            <span className="host-hint">{friendlyHost(active?.url)}</span>
          </form>
          <button className="icon-button panel-toggle" aria-label="AI 工作区已打开" title="AI 工作区" disabled><PanelRight size={17} /></button>
        </nav>
      </header>

      <aside className="ai-workspace" aria-label="Pilion AI 工作区">
        <section className="workspace-header">
          <div className="agent-avatar" aria-hidden="true"><Bot size={19} /></div>
          <div className="agent-heading">
            <span className="eyebrow">AI WORKSPACE</span>
            <h1>Pilion Agent</h1>
          </div>
          <span className={`presence ${state.agentStatus}`} title={statusCopy[state.agentStatus]}>
            <span className="presence-dot" />{statusCopy[state.agentStatus]}
          </span>
          <button className="icon-button settings-trigger" aria-label="打开 Agent 配置" title="Agent 配置" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={17} />
          </button>
        </section>

        <div className="workspace-scroll">
          <section className="session-card" aria-labelledby="session-title">
            <div className="section-heading">
              <div>
                <span className="section-kicker">SESSION</span>
                <h2 id="session-title">当前会话</h2>
              </div>
              <span className={`attachment-pill ${state.attachmentStatus}`}>
                {state.attachmentStatus === 'attached' ? <Link2 size={12} /> : <Link2Off size={12} />}
                {state.attachmentStatus === 'attached' ? '已附加' : '未附加'}
              </span>
            </div>

            <label className="select-label" htmlFor="agent-select">运行 Agent</label>
            <div className="select-wrap">
              <Bot size={15} />
              <select
                id="agent-select"
                aria-label="选择并连接 Agent"
                title="选择并连接 Agent"
                value={selectedAgent}
                onChange={event => {
                  setSelectedAgent(event.target.value);
                  void window.pilion.agents.connect(event.target.value);
                }}
              >
                <option value="" disabled>{state.agents.length ? '选择 Agent' : '尚未配置 Agent'}</option>
                {state.agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
              </select>
              <ChevronDown size={14} />
            </div>

            <div className="session-context">
              <div className="context-icon"><Globe2 size={15} /></div>
              <div>
                <strong>{active?.title || '等待打开页面'}</strong>
                <span>{attachmentCopy[state.attachmentStatus]}</span>
              </div>
            </div>

            <div className="session-actions">
              {state.attachmentStatus === 'attached' ? (
                <button className="secondary-button" aria-label="Detach" title="从当前页面分离" onClick={() => void window.pilion.agents.detach()}>
                  <Link2Off size={15} />分离页面
                </button>
              ) : (
                <button className="primary-button" aria-label="Attach" title="附加到当前页面" disabled={!canAttach} onClick={() => void window.pilion.agents.attach()}>
                  <Link2 size={15} />附加页面
                </button>
              )}
              <button className="quiet-button" aria-label="断开 Agent" title="断开 Agent" disabled={state.agentStatus === 'not_configured' || state.agentStatus === 'disconnected'} onClick={() => void window.pilion.agents.disconnect()}>
                <Unplug size={15} />断开
              </button>
            </div>
          </section>

          {state.error && <div className="error-banner" role="alert"><CircleAlert size={16} /><div><strong>执行遇到问题</strong><span>{state.error}</span></div></div>}

          {state.approvals.length > 0 && (
            <section className="approvals" aria-labelledby="approval-title">
              <div className="section-heading compact">
                <div><span className="section-kicker">REVIEW</span><h2 id="approval-title">待你确认</h2></div>
                <span className="count-badge">{state.approvals.length}</span>
              </div>
              {state.approvals.map(item => (
                <article className="approval-card" key={item.approvalId}>
                  <span className="approval-icon"><LockKeyhole size={15} /></span>
                  <div><strong>{item.tool}</strong><p>{item.summary}</p></div>
                  <span className="approval-state"><span />{item.state === 'pending' ? '等待中' : item.state}</span>
                </article>
              ))}
            </section>
          )}

          <section className="activity" aria-labelledby="activity-title">
            <div className="section-heading compact activity-heading">
              <div><span className="section-kicker">ACTIVITY</span><h2 id="activity-title">协作动态</h2></div>
              {state.events.length > 0 && <span className="live-label"><span />实时</span>}
            </div>
            <div className="timeline" ref={timelineRef} aria-live="polite">
              {state.events.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-orbit"><Sparkles size={19} /></span>
                  <h3>从一个明确目标开始</h3>
                  <p>连接本机 Agent 并附加当前页面，Pilion 会在这里呈现计划、操作与需要确认的步骤。</p>
                  <button className="text-button" aria-label="配置第一个 Agent" title="打开 Agent 配置" onClick={() => setSettingsOpen(true)}>
                    配置第一个 Agent<ExternalLink size={13} />
                  </button>
                </div>
              ) : state.events.map((item, index) => {
                const event = eventParts(item);
                const recent = index === state.events.length - 1;
                return (
                  <article className={`timeline-item ${recent ? 'recent' : ''}`} key={`${item}-${index}`}>
                    <span className="timeline-node">{recent && isBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={12} />}</span>
                    <div className="timeline-copy"><p>{event.body}</p><time>{event.time}</time></div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>

        <section className="composer-wrap" aria-label="发送任务">
          {state.agentStatus === 'running' && (
            <button className="stop-task" aria-label="停止任务" title="停止当前任务" onClick={() => void window.pilion.agents.cancel()}><CircleStop size={14} />停止当前任务</button>
          )}
          <form className="composer" onSubmit={event => { event.preventDefault(); submitTask(); }}>
            <textarea
              value={task}
              onChange={event => setTask(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitTask(); }
              }}
              placeholder="输入任务"
              aria-label="输入任务"
              title="输入任务，Shift + Enter 换行"
              rows={2}
            />
            <div className="composer-footer">
              <span><Command size={12} /> Enter 发送 · Shift Enter 换行</span>
              <button className="send-button" aria-label="发送" title="发送任务" disabled={!task.trim() || state.attachmentStatus !== 'attached'}><Send size={15} /></button>
            </div>
          </form>
        </section>

        {settingsOpen && (
          <div className="sheet-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
            <section className="config-sheet" role="dialog" aria-modal="true" aria-labelledby="config-title">
              <div className="sheet-handle" />
              <div className="sheet-header">
                <div><span className="section-kicker">LOCAL RUNTIME</span><h2 id="config-title">Agent 配置</h2></div>
                <button className="icon-button" aria-label="关闭 Agent 配置" title="关闭" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
              </div>
              <p className="sheet-intro">连接运行在本机的受信任 Agent。配置只保存在当前设备。</p>
              <label>显示名称<input placeholder="例如：Research Agent" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} autoFocus /></label>
              <label>启动命令<input placeholder="例如：node" value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label>
              <label>参数<input placeholder="空格分隔，可选" value={draft.args} onChange={event => setDraft({ ...draft, args: event.target.value })} /></label>
              <label>工作目录<input placeholder="可选" value={draft.cwd} onChange={event => setDraft({ ...draft, cwd: event.target.value })} /></label>
              <div className="security-note"><ShieldCheck size={15} /><span>敏感页面操作仍需在独立安全窗口中确认。</span></div>
              <button className="save-button" aria-label="保存配置" title="保存 Agent 配置" disabled={!draft.name.trim() || !draft.command.trim()} onClick={() => void save()}><Zap size={15} />保存并使用</button>
              {activeAgentName && <button className="reset-link" aria-label="清空配置表单" title="清空表单" onClick={() => setDraft({ name: '', command: '', args: '', cwd: '' })}><RotateCcw size={13} />清空表单</button>}
            </section>
          </div>
        )}
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
