import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Globe2,
  History,
  Laptop,
  LayoutPanelLeft,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react";
import type { AppState, SavedPage } from "../shared/contracts";
import type { LocalAgentPreset } from '../shared/local-agents';
import { AgentSettings } from "./AgentSettings";
import { ConversationPanel } from "./ConversationPanel";
import { addressToUrl, Brand, hostname, IconButton } from "./ui";
import "./style.css";

const empty: AppState = {
  tabs: [],
  agents: [],
  agentStatus: "not_configured",
  attachmentStatus: "none",
  approvals: [],
  events: [],
};
type Surface =
  "browser" | "settings" | "bookmarks" | "history" | "conversations";
type Theme = "light" | "dark" | "auto";

function App() {
  const [state, setState] = useState<AppState>(empty);
  const [surface, setSurface] = useState<Surface>("browser");
  const [localPreset, setLocalPreset] = useState<LocalAgentPreset>();
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 960);
  const [panel, setPanel] = useState(() => window.innerWidth > 680);
  const [draft, setDraft] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("pilion-theme");
    return stored === "dark" || stored === "light" ? stored : "auto";
  });
  const pageArea = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const active = state.tabs.find((item) => item.id === state.activeTabId);
  const home = !active || active.url === "about:blank";
  const [addressFocused, setAddressFocused] = useState(false);
  const native = Boolean(window.pilion);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : String(cause),
      );
      return false;
    }
  }, []);
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
    localStorage.setItem("pilion-theme", theme);
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
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
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
            surface === "browser" &&
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
      setSurface("browser");
      setAddressFocused(false);
      addressInput.current?.blur();
      void run(() => window.pilion.tabs.navigate(addressToUrl(text)));
    },
    [native, run],
  );
  useEffect(() => {
    if (!native) return;
    return window.pilion.onShortcut((key) => {
      if (key === "l" || key === "k") {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
      if (key === "t") {
        setSurface("browser");
        void run(() => window.pilion.tabs.open());
      }
      if (key === "w" && active)
        void run(() => window.pilion.tabs.close(active.id));
      if (key === ",") setSurface("settings");
    });
  }, [active, native, run]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "l" || event.key === "k") {
        event.preventDefault();
        setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
        addressInput.current?.focus();
        addressInput.current?.select();
      }
      if (native && event.key === "t") {
        event.preventDefault();
        setSurface("browser");
        void run(() => window.pilion.tabs.open());
      }
      if (native && event.key === "w" && active) {
        event.preventDefault();
        void run(() => window.pilion.tabs.close(active.id));
      }
      if (native && event.key === "r") {
        event.preventDefault();
        void run(() => window.pilion.tabs.reload());
      }
      if (event.key === ",") {
        event.preventDefault();
        setSurface("settings");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active, native, run]);
  const selectSurface = (next: Surface) => {
    setSurface(next);
    setFilter("");
    if (window.innerWidth <= 960) setSidebar(false);
  };
  const busy = ["starting", "stopping", "running"].includes(state.agentStatus);
  const newTab = () => {
    setSurface("browser");
    if (native) void run(() => window.pilion.tabs.open());
  };
  const rows =
    surface === "bookmarks" ? (state.bookmarks ?? []) : (state.history ?? []);
  const bookmarks = state.bookmarks ?? [];
  return (
    <main
      className={`app-shell ${sidebar ? "" : "sidebar-hidden"} ${panel ? "" : "panel-hidden"}`}
    >
      <header className="titlebar">
        <div className="titlebar-brand">
          <Brand compact />
          <span>Pilion</span>
        </div>
        <span className="workspace-name">个人工作区</span>
        <span className="titlebar-state">
          <span
            className={`connection-dot ${state.attachmentStatus === "attached" ? "ready" : ""}`}
          />
          {state.attachmentStatus === "attached" ? "Agent 已连接" : "由你掌控"}
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
            className={surface === "browser" ? "selected" : ""}
            onClick={() => selectSurface("browser")}
          >
            <Globe2 size={17} />
            浏览器<span className="nav-count">{state.tabs.length}</span>
          </button>
          <button
            className={surface === "conversations" ? "selected" : ""}
            onClick={() => selectSurface("conversations")}
          >
            <MessageSquare size={17} />
            对话记录
          </button>
          <button
            className={surface === "bookmarks" ? "selected" : ""}
            onClick={() => selectSurface("bookmarks")}
          >
            <Bookmark size={17} />
            书签
          </button>
          <button
            className={surface === "history" ? "selected" : ""}
            onClick={() => selectSurface("history")}
          >
            <History size={17} />
            浏览历史
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
              className={`tab ${tab.id === active?.id && surface === "browser" ? "active" : ""}`}
              key={tab.id}
            >
              <button
                className="tab-target"
                role="tab"
                aria-selected={tab.id === active?.id}
                title={tab.title}
                onClick={() => {
                  setSurface("browser");
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
                  {tab.url === "about:blank"
                    ? "新标签页"
                    : tab.title || hostname(tab.url)}
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
            className={surface === "settings" ? "selected" : ""}
            onClick={() => selectSurface("settings")}
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
              label={`主题：${theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统"}`}
              onClick={() =>
                setTheme(
                  theme === "auto"
                    ? "light"
                    : theme === "light"
                      ? "dark"
                      : "auto",
                )
              }
            >
              {theme === "dark" ? (
                <Moon size={16} />
              ) : theme === "light" ? (
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
              label="刷新"
              disabled={home}
              onClick={() => void run(() => window.pilion.tabs.reload())}
            >
              <RefreshCw size={16} className={active?.loading ? "spin" : ""} />
            </IconButton>
          </div>
          <form
            className="address-form"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(address);
            }}
          >
            {active?.url.startsWith("https:") ? (
              <LockKeyhole size={13} />
            ) : (
              <Search size={14} />
            )}
            <input
              ref={addressInput}
              aria-label="地址栏"
              placeholder="搜索或输入网址"
              value={addressFocused ? address : home ? "" : (active?.url ?? "")}
              onFocus={() => {
                setAddress(
                  active?.url === "about:blank" ? "" : (active?.url ?? ""),
                );
                setAddressFocused(true);
              }}
              onBlur={() => setAddressFocused(false)}
              onChange={(event) => setAddress(event.target.value)}
            />
            <IconButton
              type="button"
              label={
                bookmarks.some((item) => item.url === active?.url)
                  ? "移除书签"
                  : "添加书签"
              }
              disabled={home}
              onClick={() =>
                void run(() => window.pilion.workspace.toggleBookmark())
              }
            >
              <Bookmark
                size={15}
                fill={
                  bookmarks.some((item) => item.url === active?.url)
                    ? "currentColor"
                    : "none"
                }
              />
            </IconButton>
          </form>
          <IconButton
            label={panel ? "收起协作栏" : "打开 Agent 面板"}
            className={panel ? "accent-icon" : ""}
            onClick={() => setPanel(!panel)}
          >
            <PanelRightOpen size={18} />
          </IconButton>
        </header>
        {(error || state.error) && (
          <div className="error-banner" role="alert">
            <CircleAlert size={15} />
            <span>{error || state.error}</span>
            {error && (
              <IconButton label="关闭错误提示" onClick={() => setError("")}>
                <X size={14} />
              </IconButton>
            )}
          </div>
        )}
        <div className="page-area" ref={pageArea}>
          {surface === "settings" ? (
            <AgentSettings
              initialPreset={localPreset}
              state={state}
              close={() => setSurface("browser")}
              run={run}
            />
          ) : surface === "conversations" ? (
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
                    if (
                      await run(() => window.pilion.workspace.newConversation())
                    ) {
                      setPanel(true);
                      setSurface("browser");
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
                    item.messages.length &&
                    item.title.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((item) => (
                  <button
                    className="library-row"
                    disabled={busy}
                    key={item.id}
                    onClick={async () => {
                      if (
                        await run(() =>
                          window.pilion.workspace.selectConversation(item.id),
                        )
                      ) {
                        setPanel(true);
                        setSurface("browser");
                      }
                    }}
                  >
                    <MessageSquare size={18} />
                    <div>
                      <strong>{item.title}</strong>
                      <span>
                        {state.agents.find((agent) => agent.id === item.agentId)
                          ?.name ?? "Agent"}{" "}
                        · {new Date(item.updatedAt).toLocaleDateString()}
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
          ) : surface === "bookmarks" || surface === "history" ? (
            <div className="library-surface">
              <header className="surface-header">
                <div>
                  <span className="eyebrow">工作区</span>
                  <h1>{surface === "bookmarks" ? "书签" : "浏览历史"}</h1>
                </div>
                {surface === "history" && rows.length > 0 && (
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(() => window.pilion.workspace.clearHistory())
                    }
                  >
                    清空历史
                  </button>
                )}
              </header>
              <SearchField value={filter} onChange={setFilter} />
              <PageList
                pages={rows.filter((item) =>
                  `${item.title} ${item.url}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )}
                open={(url) => {
                  setSurface("browser");
                  void run(() => window.pilion.tabs.open(url));
                }}
              />
              {!rows.length && (
                <div className="empty-list">
                  {surface === "bookmarks" ? (
                    <Bookmark size={30} />
                  ) : (
                    <Clock3 size={30} />
                  )}
                  <h2>
                    {surface === "bookmarks" ? "还没有书签" : "还没有浏览记录"}
                  </h2>
                </div>
              )}
            </div>
          ) : active?.error || active?.crashed ? (
            <div className="page-error">
              <CircleAlert size={36} />
              <h1>{active.crashed ? "页面已停止响应" : "无法打开这个页面"}</h1>
              <p>{hostname(active.url)}</p>
              <code>{active.error}</code>
              <button
                className="primary-button"
                onClick={() =>
                  void run(() => window.pilion.tabs.navigate(active.url))
                }
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
                    navigate(String(data.get("query") ?? ""));
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
                    { label: "GitHub", url: "https://github.com", mark: "G" },
                    {
                      label: "Wikipedia",
                      url: "https://wikipedia.org",
                      mark: "W",
                    },
                    {
                      label: "Hacker News",
                      url: "https://news.ycombinator.com",
                      mark: "Y",
                    },
                    ...bookmarks
                      .slice(0, 2)
                      .map((item) => ({
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
                  <img
                    src="./images/alpine-lake.jpg"
                    alt="阿尔卑斯湖泊与山间晨光"
                  />
                </div>
                {state.history?.length ? (
                  <section className="recent-section">
                    <div className="section-heading">
                      <h2>继续浏览</h2>
                      <button
                        className="text-button"
                        onClick={() => selectSurface("history")}
                      >
                        查看全部
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <PageList
                      pages={state.history.slice(0, 3)}
                      open={navigate}
                    />
                  </section>
                ) : null}
              </div>
              <footer className="home-footer">
                <span>PILION</span>
                <span>
                  {new Date().toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
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
            {active?.loading ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <Check size={12} />
            )}
            {active?.loading
              ? "正在加载"
              : home
                ? "新标签页"
                : hostname(active?.url)}
          </span>
          <span>
            {state.attachmentStatus === "attached"
              ? "Agent 可访问工作区"
              : "手动浏览"}
          </span>
        </footer>
      </section>
      {panel && (
        <ConversationPanel
          state={state}
          settings={preset => { setLocalPreset(preset); setSurface("settings"); }}
          close={() => setPanel(false)}
          run={run}
          draft={draft}
          setDraft={setDraft}
        />
      )}
    </main>
  );
}
function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange(text: string): void;
}) {
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
function PageList({
  pages,
  open,
}: {
  pages: SavedPage[];
  open(url: string): void;
}) {
  return (
    <div>
      {pages.map((page) => (
        <button
          className="library-row"
          key={page.url}
          onClick={() => open(page.url)}
        >
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
createRoot(document.getElementById("root")!).render(<App />);
