import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleStop,
  Clapperboard,
  Clock3,
  Cookie,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  Globe2,
  History,
  Laptop,
  LayoutPanelLeft,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  MousePointer2,
  Minus,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react';
import type { AgentActivityPhase, AppState, DownloadRecord, SavedPage } from '../shared/contracts';
import type { LocalAgentPreset } from '../shared/local-agents';
import { AgentSettings } from './AgentSettings';
const ConversationPanel = lazy(() =>
  import('./ConversationPanel').then((module) => ({ default: module.ConversationPanel })),
);
import { SkillLibrary } from './SkillLibrary';
import { addressToUrl, Brand, failureText, hostname, IconButton } from './ui';
import './style.css';

const empty: AppState = {
  tabs: [],
  agents: [],
  agentStatus: 'not_configured',
  attachmentStatus: 'none',
  approvals: [],
  events: [],
};
const AGENT_ACTIVITY = {
  think: { label: 'Agent 正在思考', detail: '', icon: LoaderCircle },
  act: { label: 'Agent 正在操作页面', detail: '', icon: MousePointer2 },
  confirm: { label: 'Agent 等待你确认', detail: '请在右侧面板处理', icon: ShieldCheck },
} satisfies Record<
  AgentActivityPhase,
  { label: string; detail: string; icon: typeof MousePointer2 }
>;
type CookieImportState = {
  profiles: { id: string; name: string }[];
  selected: string;
  supported: boolean;
  reason?: string;
  busy: boolean;
  done?: string;
};
type Surface =
  'browser' | 'settings' | 'bookmarks' | 'history' | 'downloads' | 'conversations' | 'skills';
type Theme = 'light' | 'dark' | 'auto';

function App() {
  const [state, setState] = useState<AppState>(empty);
  const [surface, setSurface] = useState<Surface>('browser');
  const [localPreset, setLocalPreset] = useState<LocalAgentPreset>();
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 960);
  const [panel, setPanel] = useState(() => window.innerWidth > 680);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftId = state.activeConversationId ?? 'preview';
  const draft = drafts[draftId] ?? '';
  const setDraft = useCallback(
    (text: string) =>
      setDrafts((current) =>
        current[draftId] === text ? current : { ...current, [draftId]: text },
      ),
    [draftId],
  );
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [browserTools, setBrowserTools] = useState(false);
  const [cookieImport, setCookieImport] = useState<CookieImportState | null>(null);
  const [noteText, setNoteText] = useState('');
  const [naming, setNaming] = useState(false);
  const [recordingName, setRecordingName] = useState('');
  const recordingActive = Boolean(state.recording);
  const replayRunning = state.replay?.status === 'running';
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('pilion-theme');
    return stored === 'dark' || stored === 'light' ? stored : 'auto';
  });
  const pageArea = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const active = state.tabs.find((item) => item.id === state.activeTabId);
  const agentActivityPhase = state.agentActivityPhase ?? 'think';
  const agentActivity = AGENT_ACTIVITY[agentActivityPhase];
  const AgentActivityIcon = agentActivity.icon;
  const home = !active || active.url === 'about:blank';
  const [addressFocused, setAddressFocused] = useState(false);
  const native = Boolean(window.pilion);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(failureText(cause));
      return false;
    }
  }, []);
  const openFind = useCallback(() => {
    setSurface('browser');
    setBrowserTools(false);
    setFindOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindText('');
    if (native) void run(() => window.pilion.tabs.stopFind());
  }, [native, run]);
  useEffect(() => {
    if (findOpen) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [findOpen]);
  useEffect(() => {
    if (!native) return;
    let received = false;
    const off = window.pilion.onState((next) => {
      received = true;
      setState(next);
      if (next.approvals.length) setPanel(true);
    });
    void window.pilion
      .getState()
      .then((next) => {
        if (!received) setState(next);
      })
      .catch((cause) => setError(String(cause)));
    return off;
  }, [native]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pilion-theme', theme);
  }, [theme]);
  useEffect(() => {
    let narrow = window.innerWidth <= 960;
    const resize = () => {
      const next = window.innerWidth <= 960;
      if (next !== narrow) {
        setSidebar(!next);
        narrow = next;
      }
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useLayoutEffect(() => {
    const element = pageArea.current;
    if (!element || !native) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      // Native views paint above the renderer's DOM, so the recording frame is revealed by
      // shrinking the view to sit inside it, never by z-index.
      const inset = recordingActive ? 2 : 0;
      void window.pilion
        .viewport({
          x: Math.round(bounds.x) + inset,
          y: Math.round(bounds.y) + inset,
          width: Math.max(0, Math.floor(bounds.width) - inset * 2),
          height: Math.max(0, Math.floor(bounds.height) - inset * 2),
          visible:
            surface === 'browser' &&
            !home &&
            !active?.error &&
            !active?.crashed &&
            !(window.innerWidth <= 680 && panel) &&
            !(window.innerWidth <= 960 && sidebar),
        })
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      observer.disconnect();
    };
  }, [native, surface, home, active?.error, active?.crashed, sidebar, panel, recordingActive]);
  const navigate = useCallback(
    (text: string) => {
      if (!text.trim() || !native) return;
      setSurface('browser');
      setBrowserTools(false);
      setFindOpen(false);
      setFindText('');
      setAddressFocused(false);
      addressInput.current?.blur();
      void window.pilion.tabs.stopFind();
      void run(() => window.pilion.tabs.navigate(addressToUrl(text)));
    },
    [native, run],
  );
  useEffect(() => {
    if (!native) return;
    return window.pilion.onShortcut((key) => {
      if (key === 'l' || key === 'k') {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
      if (key === 't') {
        setSurface('browser');
        void run(() => window.pilion.tabs.open());
      }
      if (key === 'shift+t') void run(() => window.pilion.tabs.reopenClosed());
      if (key === 'w' && active) void run(() => window.pilion.tabs.close(active.id));
      if (key === 'r') void run(() => window.pilion.tabs.reload());
      if (key === 'f') openFind();
      if (key === '[') void run(() => window.pilion.tabs.back());
      if (key === ']') void run(() => window.pilion.tabs.forward());
      if (key === '=' || key === '+') void run(() => window.pilion.tabs.zoomIn());
      if (key === '-') void run(() => window.pilion.tabs.zoomOut());
      if (key === '0') void run(() => window.pilion.tabs.resetZoom());
      if (/^[1-9]$/.test(key)) {
        const index = key === '9' ? state.tabs.length - 1 : Number(key) - 1;
        const tab = state.tabs[index];
        if (tab) {
          setSurface('browser');
          void run(() => window.pilion.tabs.activate(tab.id));
        }
      }
      if (key === ',') setSurface('settings');
    });
  }, [active, native, openFind, run, state.tabs]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'l' || key === 'k') {
        event.preventDefault();
        setAddress(active?.url === 'about:blank' ? '' : (active?.url ?? ''));
        addressInput.current?.focus();
        addressInput.current?.select();
      }
      if (native && key === 't' && event.shiftKey) {
        event.preventDefault();
        void run(() => window.pilion.tabs.reopenClosed());
      } else if (native && key === 't') {
        event.preventDefault();
        setSurface('browser');
        void run(() => window.pilion.tabs.open());
      }
      if (native && key === 'w' && active) {
        event.preventDefault();
        void run(() => window.pilion.tabs.close(active.id));
      }
      if (native && key === 'r') {
        event.preventDefault();
        void run(() => window.pilion.tabs.reload());
      }
      if (key === 'f') {
        event.preventDefault();
        openFind();
      }
      if (native && key === '[') {
        event.preventDefault();
        void run(() => window.pilion.tabs.back());
      }
      if (native && key === ']') {
        event.preventDefault();
        void run(() => window.pilion.tabs.forward());
      }
      if (native && (key === '=' || key === '+')) {
        event.preventDefault();
        void run(() => window.pilion.tabs.zoomIn());
      }
      if (native && key === '-') {
        event.preventDefault();
        void run(() => window.pilion.tabs.zoomOut());
      }
      if (native && key === '0') {
        event.preventDefault();
        void run(() => window.pilion.tabs.resetZoom());
      }
      if (native && /^[1-9]$/.test(key)) {
        event.preventDefault();
        const index = key === '9' ? state.tabs.length - 1 : Number(key) - 1;
        const tab = state.tabs[index];
        if (tab) {
          setSurface('browser');
          void run(() => window.pilion.tabs.activate(tab.id));
        }
      }
      if (key === ',') {
        event.preventDefault();
        setSurface('settings');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [active, native, openFind, run, state.tabs]);
  const selectSurface = (next: Surface) => {
    setSurface(next);
    setFilter('');
    setBrowserTools(false);
    if (findOpen) closeFind();
    if (window.innerWidth <= 960) setSidebar(false);
    // Settings are forms with paths in them; below this width the fixed Agent panel squeezes
    // those fields to a few characters, so the panel yields until the user reopens it.
    if (next === 'settings' && window.innerWidth <= 900) setPanel(false);
  };
  const openCookieImport = async () => {
    setCookieImport({ profiles: [], selected: '', supported: true, busy: true });
    try {
      const sources = await window.pilion.cookies.chromeSources();
      setCookieImport({
        profiles: sources.profiles,
        selected: sources.profiles[0]?.id ?? '',
        supported: sources.supported,
        reason: sources.reason,
        busy: false,
      });
    } catch (error) {
      setCookieImport({
        profiles: [],
        selected: '',
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
        busy: false,
      });
    }
  };
  const runCookieImport = async () => {
    const selected = cookieImport?.selected;
    if (!selected) return;
    setCookieImport((current) => (current ? { ...current, busy: true } : current));
    try {
      const result = await window.pilion.cookies.importChrome(selected);
      setCookieImport((current) =>
        current
          ? {
              ...current,
              busy: false,
              done: `导入完成，工作区现有 ${result.stored} 条 cookie，覆盖 ${result.domains} 个域名${
                result.unreadable ? `，${result.unreadable} 条无法解密` : ''
              }`,
            }
          : current,
      );
    } catch (error) {
      setCookieImport((current) =>
        current
          ? {
              ...current,
              busy: false,
              done: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  };
  const busy = ['starting', 'stopping', 'running'].includes(state.agentStatus);
  const task = state.conversations?.find((item) => item.id === state.activeConversationId)?.task;
  const manual = task?.status === 'manual';
  // While the Agent drives, the page is already behind a shield; the controls that would move
  // that same page read as unavailable too, so the only way in stays the takeover button.
  const agentDriving = state.agentStatus === 'running' && state.attachmentStatus === 'attached';
  const drivingHint = 'Agent 正在操作页面，点击「接管」后可用';
  // An active replay owns the footer. A finished one only lingers there while nothing else needs
  // it, so an Agent task started before 关闭 still gets its indicator and its take-over button.
  const showReplayBar =
    Boolean(state.replay) &&
    (replayRunning || state.replay?.status === 'paused' || (!agentDriving && !manual));
  const newTab = () => {
    setSurface('browser');
    setBrowserTools(false);
    if (findOpen) closeFind();
    if (native) void run(() => window.pilion.tabs.open());
  };
  const rows = surface === 'bookmarks' ? (state.bookmarks ?? []) : (state.history ?? []);
  const bookmarks = state.bookmarks ?? [];
  const downloads = state.downloads ?? [];
  const activeDownloads = downloads.filter(
    (item) => item.status === 'progressing' || item.status === 'paused',
  ).length;
  return (
    <main className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${panel ? '' : 'panel-hidden'}`}>
      <aside className="sidebar">
        <div className="workspace-switch">
          <span className="workspace-icon">
            <LayoutPanelLeft size={17} />
          </span>
          <strong>我的工作区</strong>
          <IconButton label="收起侧边栏" onClick={() => setSidebar(false)}>
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <button
          className="sidebar-search"
          onClick={() => {
            addressInput.current?.focus();
            addressInput.current?.select();
          }}
        >
          <Search size={15} />
          <span>搜索或输入网址</span>
        </button>
        <nav className="workspace-nav" aria-label="工作区">
          <button
            className={surface === 'browser' ? 'selected' : ''}
            onClick={() => selectSurface('browser')}
          >
            <Globe2 size={17} />
            浏览器<span className="nav-count">{state.tabs.length}</span>
          </button>
          <button
            className={surface === 'conversations' ? 'selected' : ''}
            onClick={() => selectSurface('conversations')}
          >
            <MessageSquare size={17} />
            对话记录
          </button>
          <button
            className={surface === 'bookmarks' ? 'selected' : ''}
            onClick={() => selectSurface('bookmarks')}
          >
            <Bookmark size={17} />
            书签
          </button>
          <button
            className={surface === 'history' ? 'selected' : ''}
            onClick={() => selectSurface('history')}
          >
            <History size={17} />
            浏览历史
          </button>
          <button
            className={surface === 'downloads' ? 'selected' : ''}
            onClick={() => selectSurface('downloads')}
          >
            <Download size={17} />
            下载
            {activeDownloads > 0 ? <span className="nav-count">{activeDownloads}</span> : null}
          </button>
          <button
            className={surface === 'skills' ? 'selected' : ''}
            onClick={() => selectSurface('skills')}
          >
            <Clapperboard size={17} />
            技能库
            {(state.skills?.length ?? 0) > 0 ? (
              <span className="nav-count">{state.skills!.length}</span>
            ) : null}
          </button>
        </nav>
        <div className="sidebar-section-label">
          <span>标签页</span>
          <IconButton label="新建标签页" onClick={newTab}>
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="tabs" role="tablist" aria-label="浏览器标签页">
          {state.tabs.map((tab) => (
            <div
              className={`tab ${tab.id === active?.id && surface === 'browser' ? 'active' : ''}`}
              key={tab.id}
            >
              <button
                className="tab-target"
                role="tab"
                aria-selected={tab.id === active?.id}
                title={tab.title}
                onClick={() => {
                  setSurface('browser');
                  setBrowserTools(false);
                  if (findOpen) closeFind();
                  void run(() => window.pilion.tabs.activate(tab.id));
                }}
              >
                {tab.loading ? (
                  <LoaderCircle size={15} className="spin" />
                ) : tab.error || tab.crashed ? (
                  <CircleAlert size={15} />
                ) : (
                  <Globe2 size={15} />
                )}
                <span>
                  {tab.url === 'about:blank' ? '新标签页' : tab.title || hostname(tab.url)}
                </span>
              </button>
              <IconButton
                label={`关闭 ${tab.title}`}
                className="tab-close"
                onClick={() => void run(() => window.pilion.tabs.close(tab.id))}
              >
                <X size={13} />
              </IconButton>
            </div>
          ))}
          <button className="new-tab-row" onClick={newTab}>
            <Plus size={15} />
            新建标签页
          </button>
        </div>
        <footer className="sidebar-footer">
          <button
            className={surface === 'settings' ? 'selected' : ''}
            onClick={() => selectSurface('settings')}
          >
            <Settings2 size={17} />
            <span>Agent 连接</span>
            <span className="nav-count">{state.agents.length}</span>
          </button>
          <div>
            <span className="local-label">
              <ShieldCheck size={14} />
              本地工作区
            </span>
            <IconButton
              label={`主题：${theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}`}
              onClick={() =>
                setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')
              }
            >
              {theme === 'dark' ? (
                <Moon size={16} />
              ) : theme === 'light' ? (
                <Sun size={16} />
              ) : (
                <Laptop size={16} />
              )}
            </IconButton>
          </div>
        </footer>
      </aside>
      <section className="browser-workspace">
        <header className="browser-chrome">
          {!sidebar && (
            <IconButton label="展开侧边栏" onClick={() => setSidebar(true)}>
              <LayoutPanelLeft size={17} />
            </IconButton>
          )}
          <div className="navigation-buttons">
            <IconButton
              label="后退"
              title={agentDriving ? drivingHint : undefined}
              disabled={agentDriving || replayRunning || !active?.canGoBack}
              onClick={() => void run(() => window.pilion.tabs.back())}
            >
              <ArrowLeft size={17} />
            </IconButton>
            <IconButton
              label="前进"
              title={agentDriving ? drivingHint : undefined}
              disabled={agentDriving || replayRunning || !active?.canGoForward}
              onClick={() => void run(() => window.pilion.tabs.forward())}
            >
              <ArrowRight size={17} />
            </IconButton>
            <IconButton
              label={active?.loading ? '停止加载' : '刷新'}
              title={agentDriving ? drivingHint : undefined}
              disabled={agentDriving || replayRunning || home}
              onClick={() =>
                void run(() =>
                  active?.loading ? window.pilion.tabs.stop() : window.pilion.tabs.reload(),
                )
              }
            >
              {active?.loading ? <X size={16} /> : <RefreshCw size={16} />}
            </IconButton>
          </div>
          <form
            className="address-form"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(address);
            }}
          >
            {active?.url.startsWith('https:') ? <LockKeyhole size={13} /> : <Search size={14} />}
            <input
              ref={addressInput}
              aria-label="地址栏"
              placeholder="搜索或输入网址"
              title={agentDriving ? drivingHint : undefined}
              disabled={agentDriving || replayRunning}
              value={addressFocused ? address : home ? '' : (active?.url ?? '')}
              onFocus={() => {
                setAddress(active?.url === 'about:blank' ? '' : (active?.url ?? ''));
                setAddressFocused(true);
              }}
              onBlur={() => setAddressFocused(false)}
              onChange={(event) => setAddress(event.target.value)}
            />
            <IconButton
              type="button"
              label={recordingActive ? '停止录制' : '开始录制'}
              title={recordingActive ? '停止录制' : '录制我的操作，之后可以回放'}
              className={recordingActive ? 'recording-icon' : ''}
              disabled={agentDriving || replayRunning || (home && !recordingActive)}
              onClick={() => {
                if (recordingActive) {
                  setRecordingName(`录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
                  setNaming(true);
                } else {
                  // A recording can also end without this form: leaving the recorded tab makes the
                  // main process stop and save it. A fresh recording must start on the note input.
                  setNaming(false);
                  void run(() => window.pilion.recording.start());
                }
              }}
            >
              {recordingActive ? <Square size={15} fill="currentColor" /> : <Circle size={15} />}
            </IconButton>
            <IconButton
              type="button"
              label="从 Chrome 导入 cookie"
              title="从 Chrome 导入全部 cookie"
              disabled={agentDriving || replayRunning}
              onClick={() => void openCookieImport()}
            >
              <Cookie size={15} />
            </IconButton>
            <IconButton
              type="button"
              label={bookmarks.some((item) => item.url === active?.url) ? '移除书签' : '添加书签'}
              disabled={home}
              onClick={() => void run(() => window.pilion.workspace.toggleBookmark())}
            >
              <Bookmark
                size={15}
                fill={bookmarks.some((item) => item.url === active?.url) ? 'currentColor' : 'none'}
              />
            </IconButton>
          </form>
          <IconButton
            label={browserTools ? '收起浏览器工具' : '浏览器工具'}
            className={browserTools ? 'accent-icon' : ''}
            onClick={() => {
              if (findOpen) closeFind();
              setBrowserTools((current) => !current);
            }}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          <IconButton
            label={panel ? '收起协作栏' : '打开 Agent 面板'}
            className={panel ? 'accent-icon' : ''}
            onClick={() => setPanel(!panel)}
          >
            <PanelRightOpen size={18} />
          </IconButton>
        </header>
        {state.recording && surface === 'browser' ? (
          <div className="recording-bar" role="status" aria-live="polite">
            <span className="recording-dot" aria-hidden="true" />
            <strong>录制中 · {state.recording.steps} 步</strong>
            {state.recording.unsupported > 0 ? (
              <span className="recording-warn" title="这些步骤回放不了，提炼时会变成「需要我」">
                {state.recording.unsupported} 步回放不了
              </span>
            ) : null}
            {naming ? (
              <form
                className="recording-name"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await run(() => window.pilion.recording.stop(recordingName))) {
                    setNaming(false);
                    setNoteText('');
                  }
                }}
              >
                <input
                  autoFocus
                  aria-label="录制名称"
                  value={recordingName}
                  onChange={(event) => setRecordingName(event.target.value)}
                  maxLength={120}
                />
                <button type="submit" className="secondary-button" disabled={!recordingName.trim()}>
                  保存
                </button>
                <button type="button" className="text-button" onClick={() => setNaming(false)}>
                  继续录
                </button>
              </form>
            ) : (
              <form
                className="recording-note"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!noteText.trim()) return;
                  if (await run(() => window.pilion.recording.note(noteText))) setNoteText('');
                }}
              >
                <input
                  aria-label="录制旁白"
                  placeholder="加一句旁白，例如：这里要选上个月"
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  maxLength={2000}
                />
              </form>
            )}
          </div>
        ) : null}
        {browserTools && surface === 'browser' ? (
          <div className="browser-tools" aria-label="浏览器工具">
            <button
              aria-label="新建标签页"
              title="新建标签页"
              disabled={replayRunning}
              onClick={newTab}
            >
              <Plus size={15} />
              新建标签页
            </button>
            <button
              aria-label="复制标签页"
              title="复制标签页"
              disabled={replayRunning || !active}
              onClick={() => {
                setBrowserTools(false);
                void run(() => window.pilion.tabs.duplicate());
              }}
            >
              <Copy size={15} />
              复制标签页
            </button>
            <button
              aria-label="恢复关闭标签"
              title="恢复关闭标签"
              disabled={replayRunning || !state.canReopenClosedTab}
              onClick={() => {
                setBrowserTools(false);
                void run(() => window.pilion.tabs.reopenClosed());
              }}
            >
              <RotateCcw size={15} />
              恢复关闭标签
            </button>
            <button
              aria-label="页内查找"
              title={agentDriving ? drivingHint : '页内查找'}
              disabled={agentDriving || replayRunning || home}
              onClick={openFind}
            >
              <Search size={15} />
              页内查找
            </button>
            <div className="zoom-controls" aria-label="页面缩放">
              <IconButton
                label="缩小页面"
                title={agentDriving ? drivingHint : undefined}
                disabled={agentDriving || replayRunning || home}
                onClick={() => void run(() => window.pilion.tabs.zoomOut())}
              >
                <Minus size={14} />
              </IconButton>
              <button
                className="zoom-value"
                title={agentDriving ? drivingHint : undefined}
                disabled={agentDriving || replayRunning || home || active?.zoomPercent === 100}
                onClick={() => void run(() => window.pilion.tabs.resetZoom())}
              >
                {active?.zoomPercent ?? 100}%
              </button>
              <IconButton
                label="放大页面"
                title={agentDriving ? drivingHint : undefined}
                disabled={agentDriving || replayRunning || home}
                onClick={() => void run(() => window.pilion.tabs.zoomIn())}
              >
                <ZoomIn size={14} />
              </IconButton>
            </div>
          </div>
        ) : null}
        {cookieImport ? (
          <div className="find-bar cookie-bar" role="alertdialog" aria-label="导入 Chrome cookie">
            <Cookie size={15} />
            {cookieImport.done ? (
              <span className="cookie-bar-copy">{cookieImport.done}</span>
            ) : cookieImport.supported ? (
              <>
                <span className="cookie-bar-copy">
                  将把 Chrome 的全部登录态导入本工作区，Agent 连接后即可使用这些身份。
                </span>
                <select
                  aria-label="Chrome 配置文件"
                  value={cookieImport.selected}
                  disabled={cookieImport.busy}
                  onChange={(event) =>
                    setCookieImport((current) =>
                      current ? { ...current, selected: event.target.value } : current,
                    )
                  }
                >
                  {cookieImport.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button"
                  disabled={cookieImport.busy}
                  onClick={() => void runCookieImport()}
                >
                  {cookieImport.busy ? '正在导入…' : '确认导入'}
                </button>
              </>
            ) : (
              <span className="cookie-bar-copy">{cookieImport.reason}</span>
            )}
            <IconButton label="关闭导入提示" onClick={() => setCookieImport(null)}>
              <X size={15} />
            </IconButton>
          </div>
        ) : null}
        {findOpen && surface === 'browser' && !home ? (
          <form
            className="find-bar"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (findText) void run(() => window.pilion.tabs.find(findText, true, false));
            }}
          >
            <Search size={15} />
            <input
              ref={findInput}
              aria-label="在页面中查找"
              placeholder="在页面中查找"
              value={findText}
              onChange={(event) => {
                const text = event.target.value;
                setFindText(text);
                if (native) void run(() => window.pilion.tabs.find(text, true, true));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeFind();
                } else if (event.key === 'Enter' && event.shiftKey && findText) {
                  event.preventDefault();
                  void run(() => window.pilion.tabs.find(findText, false, false));
                }
              }}
            />
            <output aria-live="polite">
              {state.findResult?.tabId === active?.id
                ? `${state.findResult.activeMatchOrdinal}/${state.findResult.matches}`
                : '0/0'}
            </output>
            <IconButton
              type="button"
              label="上一个匹配项"
              disabled={!findText}
              onClick={() => void run(() => window.pilion.tabs.find(findText, false, false))}
            >
              <ChevronUp size={15} />
            </IconButton>
            <IconButton
              type="button"
              label="下一个匹配项"
              disabled={!findText}
              onClick={() => void run(() => window.pilion.tabs.find(findText, true, false))}
            >
              <ChevronDown size={15} />
            </IconButton>
            <IconButton type="button" label="关闭页内查找" onClick={closeFind}>
              <X size={15} />
            </IconButton>
          </form>
        ) : null}
        {(error || state.error) && (
          <div className="error-banner" role="alert">
            <CircleAlert size={15} />
            <span>{error || state.error}</span>
            {error && (
              <IconButton label="关闭错误提示" onClick={() => setError('')}>
                <X size={14} />
              </IconButton>
            )}
          </div>
        )}
        <div className={`page-area ${state.recording ? 'recording' : ''}`} ref={pageArea}>
          {surface === 'settings' ? (
            <AgentSettings
              initialPreset={localPreset}
              state={state}
              close={() => setSurface('browser')}
              run={run}
              importCookies={() => void openCookieImport()}
            />
          ) : surface === 'conversations' ? (
            <div className="library-surface">
              <header className="surface-header">
                <div>
                  <span className="eyebrow">工作区</span>
                  <h1>对话记录</h1>
                </div>
                <button
                  className="secondary-button"
                  disabled={busy || !native}
                  onClick={async () => {
                    if (await run(() => window.pilion.workspace.newConversation())) {
                      setPanel(true);
                      setSurface('browser');
                    }
                  }}
                >
                  <Plus size={16} />
                  新对话
                </button>
              </header>
              <SearchField value={filter} onChange={setFilter} />
              {state.conversations
                ?.filter(
                  (item) =>
                    item.messages.length && item.title.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((item) => (
                  <button
                    className="library-row"
                    disabled={busy}
                    key={item.id}
                    onClick={async () => {
                      if (await run(() => window.pilion.workspace.selectConversation(item.id))) {
                        setPanel(true);
                        setSurface('browser');
                      }
                    }}
                  >
                    <MessageSquare size={18} />
                    <div>
                      <strong>{item.title}</strong>
                      <span>
                        {state.agents.find((agent) => agent.id === item.agentId)?.name ?? 'Agent'} ·{' '}
                        {new Date(item.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))}
              {!state.conversations?.some((item) => item.messages.length) && (
                <div className="empty-list">
                  <MessageSquare size={30} />
                  <h2>还没有对话记录</h2>
                </div>
              )}
            </div>
          ) : surface === 'skills' ? (
            <SkillLibrary
              skills={state.skills ?? []}
              busy={busy}
              run={run}
              distillation={state.distillation}
              agentConnected={
                state.agentStatus === 'ready' && state.attachmentStatus === 'attached'
              }
              onPlay={(id) => {
                setSurface('browser');
                void run(() => window.pilion.skills.play(id));
              }}
            />
          ) : surface === 'downloads' ? (
            <Downloads
              downloads={downloads}
              run={run}
              clear={() => void run(() => window.pilion.downloads.clear())}
            />
          ) : surface === 'bookmarks' || surface === 'history' ? (
            <div className="library-surface">
              <header className="surface-header">
                <div>
                  <span className="eyebrow">工作区</span>
                  <h1>{surface === 'bookmarks' ? '书签' : '浏览历史'}</h1>
                </div>
                {surface === 'history' && rows.length > 0 && (
                  <button
                    className="text-button"
                    onClick={() => void run(() => window.pilion.workspace.clearHistory())}
                  >
                    清空历史
                  </button>
                )}
              </header>
              <SearchField value={filter} onChange={setFilter} />
              <PageList
                pages={rows.filter((item) =>
                  `${item.title} ${item.url}`.toLowerCase().includes(filter.toLowerCase()),
                )}
                open={(url) => {
                  setSurface('browser');
                  void run(() => window.pilion.tabs.open(url));
                }}
              />
              {!rows.length && (
                <div className="empty-list">
                  {surface === 'bookmarks' ? <Bookmark size={30} /> : <Clock3 size={30} />}
                  <h2>{surface === 'bookmarks' ? '还没有书签' : '还没有浏览记录'}</h2>
                </div>
              )}
            </div>
          ) : active?.error || active?.crashed ? (
            <div className="page-error">
              <CircleAlert size={36} />
              <h1>{active.crashed ? '页面已停止响应' : '无法打开这个页面'}</h1>
              <p>{hostname(active.url)}</p>
              <code>{active.error}</code>
              <button
                className="primary-button"
                onClick={() => void run(() => window.pilion.tabs.navigate(active.url))}
              >
                <RefreshCw size={16} />
                重新加载
              </button>
            </div>
          ) : home ? (
            <div className="new-tab-page">
              <div className="home-content">
                <Brand />
                <h1>新标签页</h1>
                <form
                  className="home-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    navigate(String(data.get('query') ?? ''));
                  }}
                >
                  <Search size={19} />
                  <input
                    name="query"
                    aria-label="搜索网络"
                    placeholder="搜索网络，或输入网址"
                    required
                  />
                  <button className="icon-button" aria-label="搜索">
                    <ArrowRight size={18} />
                  </button>
                </form>
                <div className="quick-links">
                  {[
                    { label: 'GitHub', url: 'https://github.com', mark: 'G' },
                    {
                      label: 'Wikipedia',
                      url: 'https://wikipedia.org',
                      mark: 'W',
                    },
                    {
                      label: 'Hacker News',
                      url: 'https://news.ycombinator.com',
                      mark: 'Y',
                    },
                    ...bookmarks.slice(0, 2).map((item) => ({
                      label: item.title || hostname(item.url),
                      url: item.url,
                      mark: hostname(item.url).charAt(0).toUpperCase(),
                    })),
                  ].map((item) => (
                    <button key={item.url} onClick={() => navigate(item.url)}>
                      <span className="site-monogram">{item.mark}</span>
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                <div className="home-landscape">
                  <img src="./images/alpine-lake.jpg" alt="阿尔卑斯湖泊与山间晨光" />
                </div>
                {state.history?.length ? (
                  <section className="recent-section">
                    <div className="section-heading">
                      <h2>继续浏览</h2>
                      <button className="text-button" onClick={() => selectSurface('history')}>
                        查看全部
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <PageList pages={state.history.slice(0, 3)} open={navigate} />
                  </section>
                ) : null}
              </div>
              <footer className="home-footer">
                <span>PILION</span>
                <span>
                  {new Date().toLocaleDateString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                  })}
                </span>
              </footer>
            </div>
          ) : null}
          {!native && (
            <div className="preview-notice">
              <Laptop size={16} />
              请在 Pilion 桌面应用中使用浏览器和 Agent 连接。
            </div>
          )}
        </div>
        <footer
          className={`browser-status ${(state.agentStatus === 'running' && state.attachmentStatus === 'attached') || manual ? 'agent-active' : ''}`}
        >
          <span>
            {active?.loading ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
            {active?.loading ? '正在加载' : home ? '新标签页' : hostname(active?.url)}
          </span>
          {showReplayBar && state.replay ? (
            <div
              className={`agent-operation-indicator is-replay ${state.replay.status}`}
              role="status"
            >
              <Play size={14} />
              <span className="agent-operation-copy">
                <strong>
                  {state.replay.status === 'running'
                    ? `正在回放「${state.replay.name}」 ${state.replay.step}/${state.replay.total}`
                    : state.replay.status === 'paused'
                      ? `需要你：${state.replay.message}`
                      : state.replay.status === 'done'
                        ? `回放完成「${state.replay.name}」`
                        : `回放失败`}
                </strong>
                {state.replay.status === 'failed' && state.replay.message ? (
                  <span className="agent-operation-detail">{state.replay.message}</span>
                ) : null}
              </span>
              {state.replay.status === 'paused' ? (
                <button
                  className="take-over"
                  aria-label="继续回放"
                  onClick={() => void run(() => window.pilion.skills.resume())}
                >
                  <Play size={14} />
                  继续
                </button>
              ) : null}
              <button
                aria-label={state.replay.status === 'running' ? '停止回放' : '关闭'}
                onClick={() => void run(() => window.pilion.skills.stop())}
              >
                <CircleStop size={14} />
                {state.replay.status === 'running' ? '停止' : '关闭'}
              </button>
            </div>
          ) : agentDriving ? (
            <div
              className={`agent-operation-indicator is-${agentActivityPhase}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="agent-operation-pulse" />
              <AgentActivityIcon
                size={14}
                className={`agent-operation-icon ${
                  agentActivityPhase === 'think'
                    ? 'spin'
                    : agentActivityPhase === 'act'
                      ? 'agent-operation-pointer'
                      : ''
                }`}
              />
              <span className="agent-operation-copy">
                <strong>{agentActivity.label}</strong>
                {state.agentReplay || agentActivity.detail ? (
                  <span className="agent-operation-detail">
                    {state.agentReplay
                      ? `回放「${state.agentReplay.name}」 ${state.agentReplay.step}/${state.agentReplay.total}`
                      : agentActivity.detail}
                  </span>
                ) : null}
              </span>
              <button
                aria-label="停止浏览器任务"
                onClick={() => void run(() => window.pilion.agents.cancel())}
              >
                <CircleStop size={14} />
                停止任务
              </button>
              <button
                className="take-over"
                aria-label="接管浏览器"
                onClick={() => void run(() => window.pilion.agents.takeOver())}
              >
                <MousePointer2 size={14} />
                接管
              </button>
            </div>
          ) : manual ? (
            <div className="agent-operation-indicator is-manual" role="status">
              <MousePointer2 size={14} />
              <strong>你正在操作</strong>
              <button
                aria-label="停止浏览器任务"
                onClick={() => void run(() => window.pilion.agents.cancel())}
              >
                <CircleStop size={14} />
                停止任务
              </button>
              <button
                className="take-over"
                disabled={busy}
                onClick={() => void run(() => window.pilion.agents.resume())}
                aria-label="继续任务"
              >
                <Play size={14} />
                {state.agentStatus === 'starting' ? '正在连接…' : busy ? '正在暂停…' : '继续任务'}
              </button>
            </div>
          ) : (
            <span>
              {task?.status === 'stopped'
                ? '任务已停止 · 手动浏览'
                : state.attachmentStatus === 'attached'
                  ? 'Agent 可访问工作区'
                  : '手动浏览'}
            </span>
          )}
        </footer>
      </section>
      {panel && (
        <Suspense
          fallback={
            <aside className="ai-workspace" aria-label="Pilion AI 工作区">
              <header className="agent-header">
                <h2>Agent</h2>
                <LoaderCircle size={16} className="spin" />
              </header>
            </aside>
          }
        >
          <ConversationPanel
            state={state}
            settings={(preset) => {
              setLocalPreset(preset);
              selectSurface('settings');
            }}
            close={() => setPanel(false)}
            run={run}
            draft={draft}
            setDraft={setDraft}
          />
        </Suspense>
      )}
    </main>
  );
}
function SearchField({ value, onChange }: { value: string; onChange(text: string): void }) {
  return (
    <div className="library-search">
      <Search size={16} />
      <input
        aria-label="筛选记录"
        placeholder="搜索记录"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
function Downloads({
  downloads,
  run,
  clear,
}: {
  downloads: DownloadRecord[];
  run(action: () => Promise<unknown>): Promise<boolean>;
  clear(): void;
}) {
  const canClear = downloads.some(
    (item) => item.status !== 'progressing' && item.status !== 'paused',
  );
  return (
    <div className="library-surface">
      <header className="surface-header">
        <div>
          <span className="eyebrow">工作区</span>
          <h1>下载</h1>
        </div>
        {canClear ? (
          <button className="text-button" onClick={clear}>
            <Trash2 size={14} />
            清除已结束记录
          </button>
        ) : null}
      </header>
      <div className="download-list">
        {downloads.map((item) => {
          const active = item.status === 'progressing' || item.status === 'paused';
          return (
            <div className="download-row" key={item.id}>
              <FileDown size={19} />
              <div className="download-details">
                <strong title={item.filename}>{item.filename}</strong>
                <span>
                  {downloadStatus(item)} · {hostname(item.url)}
                </span>
                {active ? (
                  <progress
                    aria-label={`${item.filename} 下载进度`}
                    max={item.totalBytes || 1}
                    value={item.receivedBytes}
                  />
                ) : null}
              </div>
              <div className="download-actions">
                {active ? (
                  <>
                    <IconButton
                      label={item.status === 'paused' ? '继续下载' : '暂停下载'}
                      onClick={() => void run(() => window.pilion.downloads.togglePause(item.id))}
                    >
                      {item.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}
                    </IconButton>
                    <IconButton
                      label="取消下载"
                      onClick={() => void run(() => window.pilion.downloads.cancel(item.id))}
                    >
                      <X size={15} />
                    </IconButton>
                  </>
                ) : item.status === 'completed' ? (
                  <>
                    <IconButton
                      label="打开下载"
                      onClick={() => void run(() => window.pilion.downloads.open(item.id))}
                    >
                      <ArrowUpRight size={15} />
                    </IconButton>
                    <IconButton
                      label="在文件夹中显示"
                      onClick={() => void run(() => window.pilion.downloads.show(item.id))}
                    >
                      <FolderOpen size={15} />
                    </IconButton>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {!downloads.length ? (
        <div className="empty-list">
          <Download size={30} />
          <h2>还没有下载记录</h2>
        </div>
      ) : null}
    </div>
  );
}
function downloadStatus(item: DownloadRecord): string {
  const size = item.totalBytes
    ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
    : formatBytes(item.receivedBytes);
  if (item.status === 'progressing') return `下载中 ${size}`;
  if (item.status === 'paused') return `已暂停 ${size}`;
  if (item.status === 'completed') return `已完成 ${formatBytes(item.receivedBytes)}`;
  if (item.status === 'cancelled') return '已取消';
  return '下载中断';
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
function PageList({ pages, open }: { pages: SavedPage[]; open(url: string): void }) {
  return (
    <div>
      {pages.map((page) => (
        <button className="library-row" key={page.url} onClick={() => open(page.url)}>
          <Globe2 size={17} />
          <div>
            <strong>{page.title || hostname(page.url)}</strong>
            <span>{hostname(page.url)}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
      ))}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
