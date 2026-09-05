import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  CircleAlert,
  CircleStop,
  FileText,
  Globe2,
  Link2,
  Link2Off,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
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
  not_configured: '未配置',
  starting: '正在连接',
  ready: '已就绪',
  running: '执行中',
  stopping: '正在停止',
  error: '连接异常',
  disconnected: '已断开',
};

const attachmentCopy = { none: '未建立会话', attached: '已连接此页面', detached: '未连接此页面' } as const;

const suggestions = [
  { icon: FileText, label: '总结当前页面', prompt: '总结当前页面的核心内容，并列出关键结论。' },
  { icon: Search, label: '查找关键信息', prompt: '查找当前页面中的关键信息，并按重要性整理。' },
  { icon: ShieldCheck, label: '检查页面风险', prompt: '检查当前页面中需要注意的安全或隐私风险。' },
];

type Theme = 'auto' | 'light' | 'dark';
const themeOrder: Theme[] = ['auto', 'light', 'dark'];
const themeMeta: Record<Theme, { icon: typeof Sun; label: string }> = {
  auto: { icon: Monitor, label: '主题：跟随系统' },
  light: { icon: Sun, label: '主题：浅色' },
  dark: { icon: Moon, label: '主题：深色' },
};

// System "plumbing" logs render as neutral status pills; everything else is an agent turn.
const systemMarker = /(已附加|已分离|握手|Action\s|result\/outbox|撤销|ACL|Attachment|lease|已过期|Session|策略|draining|Spike adapter)/;

type Turn =
  | { kind: 'user' | 'agent'; body: string; time: string; key: string }
  | { kind: 'system' | 'error'; body: string; time: string; key: string };

function friendlyHost(url?: string) {
  if (!url) return '新标签页';
  try { return new URL(url).hostname.replace(/^www\./, '') || '本地页面'; } catch { return '输入地址或搜索'; }
}

function eventParts(event: string) {
  const match = event.match(/^(\d{1,2}:\d{2}:\d{2})\s+(.+)$/);
  return match ? { time: match[1], body: match[2] } : { time: '刚刚', body: event };
}

function classifyEvent(raw: string, index: number): Turn {
  const { time, body } = eventParts(raw);
  if (/^Agent stderr:/.test(body)) return { kind: 'error', body: body.replace(/^Agent stderr:\s*/, ''), time, key: `e${index}` };
  if (systemMarker.test(body)) return { kind: 'system', body, time, key: `e${index}` };
  return { kind: 'agent', body, time, key: `e${index}` };
}

function App() {
  const [state, setState] = useState(empty);
  const [addressDraft, setAddressDraft] = useState({ tabId: '', value: '' });
  const [task, setTask] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [draft, setDraft] = useState({ name: '', command: '', args: '', cwd: '' });
  // Locally-tracked prompts the user sent, kept so the transcript reads as a two-sided conversation.
  const [prompts, setPrompts] = useState<{ text: string; time: string; at: number; id: number }[]>([]);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('pilion-theme') : null;
    return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
  });
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.pilion.getState().then(setState);
    return window.pilion.onState(setState);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('pilion-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);

  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  const address = addressDraft.tabId === active?.id ? addressDraft.value : active?.url ?? '';
  const isBusy = ['starting', 'running', 'stopping'].includes(state.agentStatus);
  const canAttach = state.agentStatus === 'ready' && state.attachmentStatus !== 'attached';
  const activeAgentName = state.agents.find(agent => agent.id === selectedAgent)?.name ?? state.agents[0]?.name;

  const turns = useMemo<Turn[]>(() => {
    const events = state.events.map(classifyEvent);
    const byAnchor = new Map<number, Turn[]>();
    for (const prompt of prompts) {
      const at = Math.min(prompt.at, events.length);
      const bucket = byAnchor.get(at) ?? [];
      bucket.push({ kind: 'user', body: prompt.text, time: prompt.time, key: `p${prompt.id}` });
      byAnchor.set(at, bucket);
    }
    const merged: Turn[] = [];
    for (let index = 0; index <= events.length; index += 1) {
      for (const turn of byAnchor.get(index) ?? []) merged.push(turn);
      if (index < events.length) merged.push(events[index]);
    }
    return merged;
  }, [state.events, prompts]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, isBusy]);

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
    const text = task.trim();
    if (!text) return;
    setPrompts(prev => [...prev, { text, time: new Date().toLocaleTimeString(), at: state.events.length, id: Date.now() + prev.length }]);
    void window.pilion.agents.task(text);
    setTask('');
  }

  function chooseSuggestion(prompt: string) {
    setTask(prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function cycleTheme() {
    setTheme(prev => themeOrder[(themeOrder.indexOf(prev) + 1) % themeOrder.length]);
  }

  const ThemeIcon = themeMeta[theme].icon;
  const hasTranscript = turns.length > 0;

  return (
    <main className="app-shell">
      <header className="browser-chrome">
        <div className="tab-strip">
          <div className="brand" aria-label="Pilion Browser">
            <span className="brand-mark"><Sparkles size={14} strokeWidth={2.2} /></span>
            <span className="brand-name">Pilion</span>
          </div>
          <div className="tabs" role="tablist" aria-label="浏览器标签页">
            {state.tabs.map(tab => (
              <div className={`tab ${tab.id === state.activeTabId ? 'active' : ''}`} role="presentation" key={tab.id}>
                <button className="tab-target" role="tab" aria-selected={tab.id === state.activeTabId} aria-label={`切换到 ${tab.title}`} title={tab.title} onClick={() => void window.pilion.tabs.activate(tab.id)}>
                  {tab.loading ? <LoaderCircle className="spin" size={14} /> : tab.crashed ? <CircleAlert size={14} /> : <Globe2 size={14} />}
                  <span>{tab.title || '新标签页'}</span>
                </button>
                <button className="tab-close" aria-label={`关闭 ${tab.title}`} title="关闭标签页" onClick={() => void window.pilion.tabs.close(tab.id)}><X size={13} /></button>
              </div>
            ))}
            <button className="icon-button new-tab" aria-label="新建标签页" title="新建标签页" onClick={() => void window.pilion.tabs.open()}><Plus size={17} /></button>
          </div>
          <div className="window-drag-space" aria-hidden="true" />
        </div>

        <nav className="navigation" aria-label="浏览器导航">
          <div className="nav-actions">
            <button className="icon-button" aria-label="后退" title="后退" disabled={!active?.canGoBack} onClick={() => void window.pilion.tabs.back()}><ArrowLeft size={18} /></button>
            <button className="icon-button" aria-label="前进" title="前进" disabled={!active?.canGoForward} onClick={() => void window.pilion.tabs.forward()}><ArrowRight size={18} /></button>
            <button className="icon-button" aria-label="重新加载" title="重新加载" onClick={() => void window.pilion.tabs.reload()}><RefreshCw size={16} /></button>
          </div>
          <form className="address-form" onSubmit={event => { event.preventDefault(); void window.pilion.tabs.navigate(address); }}>
            <ShieldCheck className="address-security" size={15} aria-hidden="true" />
            <input value={address} onChange={event => setAddressDraft({ tabId: active?.id ?? '', value: event.target.value })} aria-label="地址" title="地址栏" placeholder="搜索或输入网址" spellCheck={false} />
            <span className="host-hint">{friendlyHost(active?.url)}</span>
          </form>
          <button className="icon-button theme-toggle" aria-label={themeMeta[theme].label} title={themeMeta[theme].label} onClick={cycleTheme}><ThemeIcon size={17} /></button>
        </nav>
      </header>

      <aside className="ai-workspace" aria-label="Pilion AI 工作区">
        <section className="workspace-header">
          <div className="agent-avatar" aria-hidden="true"><Bot size={18} /></div>
          <div className="agent-heading">
            <h1>Pilion Agent</h1>
            <span className={`presence ${state.agentStatus}`} title={statusCopy[state.agentStatus]}><span className="presence-dot" />{statusCopy[state.agentStatus]}</span>
          </div>
          <div className="agent-picker">
            <select aria-label="选择并连接 Agent" title="选择并连接 Agent" value={selectedAgent} onChange={event => { setSelectedAgent(event.target.value); void window.pilion.agents.connect(event.target.value); }}>
              <option value="" disabled>{state.agents.length ? '选择 Agent' : '未配置 Agent'}</option>
              {state.agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </div>
          <button className="icon-button settings-trigger" aria-label="打开 Agent 配置" title="Agent 配置" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>
        </section>

        <section className="context-strip" aria-label="页面与连接状态">
          <span className="context-favicon"><Globe2 size={15} /></span>
          <div className="context-copy">
            <strong>{active?.title || '等待打开页面'}</strong>
            <span>{friendlyHost(active?.url)} · <span className={`attach-state ${state.attachmentStatus === 'attached' ? 'on' : ''}`}>{attachmentCopy[state.attachmentStatus]}</span></span>
          </div>
          {state.attachmentStatus === 'attached' ? (
            <button className="context-action attached" aria-label="Detach" title="从当前页面分离" onClick={() => void window.pilion.agents.detach()}><Link2Off size={15} /></button>
          ) : (
            <button className="context-action" aria-label="Attach" title="附加到当前页面" disabled={!canAttach} onClick={() => void window.pilion.agents.attach()}><Link2 size={15} /></button>
          )}
          <button className="context-action" aria-label="断开 Agent" title="断开 Agent" disabled={state.agentStatus === 'not_configured' || state.agentStatus === 'disconnected'} onClick={() => void window.pilion.agents.disconnect()}><Unplug size={15} /></button>
        </section>

        <div className="workspace-scroll">
          {state.error && <div className="error-banner" role="alert"><CircleAlert size={17} /><div><strong>执行遇到问题</strong><span>{state.error}</span></div></div>}

          {state.approvals.length > 0 && (
            <section className="approvals" aria-labelledby="approval-title">
              <div className="section-heading"><h2 id="approval-title">待你确认</h2><span className="count-badge">{state.approvals.length}</span></div>
              {state.approvals.map(item => (
                <article className="approval-card" key={item.approvalId}>
                  <span className="approval-icon"><LockKeyhole size={16} /></span>
                  <div><strong>{item.tool}</strong><p>{item.summary}</p></div>
                  <span className="approval-state"><span />{item.state === 'pending' ? '等待中' : item.state}</span>
                </article>
              ))}
            </section>
          )}

          <section className="activity" aria-labelledby="activity-title">
            <div className="section-heading activity-heading">
              <h2 id="activity-title">对话</h2>
              {isBusy && <span className="live-label"><span />实时</span>}
            </div>
            <div className="transcript" ref={transcriptRef} aria-live="polite">
              {!hasTranscript ? (
                <div className="empty-state">
                  <div className="empty-intro"><span className="empty-icon"><Sparkles size={19} /></span><div><h3>从当前页面开始</h3><p>挑一个任务，或直接告诉 Pilion 你想完成什么。</p></div></div>
                  <div className="suggestions" aria-label="建议任务">
                    {suggestions.map(({ icon: Icon, label, prompt }) => (
                      <button key={label} className="suggestion" title={prompt} onClick={() => chooseSuggestion(prompt)}><span className="suggestion-icon"><Icon size={16} /></span><span>{label}</span><ArrowRight size={15} /></button>
                    ))}
                  </div>
                  {state.agents.length === 0 && <button className="configure-link" aria-label="配置第一个 Agent" title="打开 Agent 配置" onClick={() => setSettingsOpen(true)}>配置本机 Agent</button>}
                </div>
              ) : (
                <>
                  {turns.map(turn => {
                    if (turn.kind === 'user') return (
                      <div className="turn user" key={turn.key}><div className="turn-bubble">{turn.body}<time>{turn.time}</time></div></div>
                    );
                    if (turn.kind === 'agent') return (
                      <div className="turn agent" key={turn.key}><div className="turn-bubble"><span className="turn-head"><Sparkles size={11} />Pilion</span>{turn.body}<time>{turn.time}</time></div></div>
                    );
                    if (turn.kind === 'error') return (
                      <div className="turn error" key={turn.key}><span className="turn-note"><CircleAlert size={13} />{turn.body}</span></div>
                    );
                    return (
                      <div className="turn system" key={turn.key}><span className="turn-note">{turn.body}</span></div>
                    );
                  })}
                  {state.agentStatus === 'running' && (
                    <div className="turn agent thinking"><div className="turn-bubble"><span className="turn-head"><Sparkles size={11} />Pilion</span>正在处理…</div></div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>

        <section className="composer-wrap" aria-label="发送任务">
          {state.agentStatus === 'running' && <button className="stop-task" aria-label="停止任务" title="停止当前任务" onClick={() => void window.pilion.agents.cancel()}><CircleStop size={15} />停止当前任务</button>}
          <form className="composer" onSubmit={event => { event.preventDefault(); submitTask(); }}>
            <textarea ref={composerRef} value={task} onChange={event => setTask(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitTask(); } }} placeholder="输入任务" aria-label="输入任务" title="输入任务，Shift + Enter 换行" rows={2} />
            <div className="composer-footer">
              <span className="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>⇧ Enter</kbd> 换行</span>
              <button className="send-button" aria-label="发送" title="发送任务" disabled={!task.trim() || state.attachmentStatus !== 'attached'}><Send size={16} /></button>
            </div>
          </form>
        </section>

        {settingsOpen && (
          <div className="sheet-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
            <section className="config-sheet" role="dialog" aria-modal="true" aria-labelledby="config-title">
              <div className="sheet-header"><div><h2 id="config-title">Agent 配置</h2><span>本机运行时</span></div><button className="icon-button" aria-label="关闭 Agent 配置" title="关闭" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
              <p className="sheet-intro">连接运行在本机的受信任 Agent。配置只保存在当前设备。</p>
              <label>显示名称<input placeholder="例如：Research Agent" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} autoFocus /></label>
              <label>启动命令<input placeholder="例如：node" value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label>
              <label>参数<input placeholder="空格分隔，可选" value={draft.args} onChange={event => setDraft({ ...draft, args: event.target.value })} /></label>
              <label>工作目录<input placeholder="可选" value={draft.cwd} onChange={event => setDraft({ ...draft, cwd: event.target.value })} /></label>
              <div className="security-note"><ShieldCheck size={16} /><span>敏感页面操作仍需在独立安全窗口中确认。</span></div>
              <button className="save-button" aria-label="保存配置" title="保存 Agent 配置" disabled={!draft.name.trim() || !draft.command.trim()} onClick={() => void save()}><Zap size={16} />保存并使用</button>
              {activeAgentName && <button className="reset-link" aria-label="清空配置表单" title="清空表单" onClick={() => setDraft({ name: '', command: '', args: '', cwd: '' })}><RotateCcw size={14} />清空表单</button>}
            </section>
          </div>
        )}
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
