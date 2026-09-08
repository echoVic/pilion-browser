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
  CircleAlert,
  Clock3,
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
  Sun,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react';
import type { AppState, DownloadRecord, SavedPage } from '../shared/contracts';
import type { LocalAgentPreset } from '../shared/local-agents';
import { AgentSettings } from './AgentSettings';
const ConversationPanel = lazy(() =>
  import('./ConversationPanel').then((module) => ({ default: module.ConversationPanel })),
);
import { addressToUrl, Brand, hostname, IconButton } from './ui';
import './style.css';

const empty: AppState = {
  tabs: [],
  agents: [],
  agentStatus: 'not_configured',
  attachmentStatus: 'none',
  approvals: [],
  events: [],
};
type Surface = 'browser' | 'settings' | 'bookmarks' | 'history' | 'downloads' | 'conversations';
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
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('pilion-theme');
    return stored === 'dark' || stored === 'light' ? stored : 'auto';
  });
  const pageArea = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const active = state.tabs.find((item) => item.id === state.activeTabId);
  const home = !active || active.url === 'about:blank';
  const [addressFocused, setAddressFocused] = useState(false);
  const native = Boolean(window.pilion);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : String(cause),
      );
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
      void window.pilion
        .viewport({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.floor(bounds.width),
          height: Math.floor(bounds.height),
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
  }, [native, surface, home, active?.error, active?.crashed, sidebar, panel]);
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
  };
  const busy = ['starting', 'stopping', 'running'].includes(state.agentStatus);
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
      <header className="titlebar">
        <div className="titlebar-brand">
          <Brand compact />
          <span>Pilion</span>
        </div>
        <span className="workspace-name">个人工作区</span>
        <span className="titlebar-state">
          <span
            className={`connection-dot ${state.attachmentStatus === 'attached' ? 'ready' : ''}`}
          />
          {state.attachmentStatus === 'attached' ? 'Agent 已连接' : '由你掌控'}
        </span>
      </header>
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
              disabled={!active?.canGoBack}
              onClick={() => void run(() => window.pilion.tabs.back())}
            >
              <ArrowLeft size={17} />
            </IconButton>
            <IconButton
              label="前进"
              disabled={!active?.canGoForward}
              onClick={() => void run(() => window.pilion.tabs.forward())}
            >
              <ArrowRight size={17} />
            </IconButton>
            <IconButton
              label={active?.loading ? '停止加载' : '刷新'}
              disabled={home}
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
        {browserTools && surface === 'browser' ? (
          <div className="browser-tools" aria-label="浏览器工具">
            <button aria-label="新建标签页" title="新建标签页" onClick={newTab}>
              <Plus size={15} />
              新建标签页
            </button>
            <button
              aria-label="复制标签页"
              title="复制标签页"
              disabled={!active}
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
              disabled={!state.canReopenClosedTab}
              onClick={() => {
                setBrowserTools(false);
                void run(() => window.pilion.tabs.reopenClosed());
              }}
            >
              <RotateCcw size={15} />
              恢复关闭标签
            </button>
            <button aria-label="页内查找" title="页内查找" disabled={home} onClick={openFind}>
              <Search size={15} />
              页内查找
            </button>
            <div className="zoom-controls" aria-label="页面缩放">
              <IconButton
                label="缩小页面"
                disabled={home}
                onClick={() => void run(() => window.pilion.tabs.zoomOut())}
              >
                <Minus size={14} />
              </IconButton>
              <button
                className="zoom-value"
                disabled={home || active?.zoomPercent === 100}
                onClick={() => void run(() => window.pilion.tabs.resetZoom())}
              >
                {active?.zoomPercent ?? 100}%
              </button>
              <IconButton
                label="放大页面"
                disabled={home}
                onClick={() => void run(() => window.pilion.tabs.zoomIn())}
              >
                <ZoomIn size={14} />
              </IconButton>
            </div>
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
        <div className="page-area" ref={pageArea}>
          {surface === 'settings' ? (
            <AgentSettings
              initialPreset={localPreset}
              state={state}
              close={() => setSurface('browser')}
              run={run}
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
        <footer className="browser-status">
          <span>
            {active?.loading ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
            {active?.loading ? '正在加载' : home ? '新标签页' : hostname(active?.url)}
          </span>
          <span>{state.attachmentStatus === 'attached' ? 'Agent 可访问工作区' : '手动浏览'}</span>
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
              setSurface('settings');
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
