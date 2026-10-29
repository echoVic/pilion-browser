import clsx from 'clsx';
import {
  Archive,
  CircleAlert,
  Globe2,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  Plus,
  X,
} from 'lucide-react';
import type { AppState, Tab } from '../shared/contracts';
import { hostname, IconButton } from './ui';
import './browser-organization.css';

type Props = {
  state: AppState;
  activate(id: string): void;
  newTab(): void;
  showArchive(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

export function visibleBrowserTabs(state: AppState): Tab[] {
  return ['favorite', 'pinned', 'today'].flatMap((kind) =>
    state.tabs.filter(
      (tab) =>
        (tab.kind ?? 'today') === kind &&
        (kind === 'favorite' || !tab.spaceId || tab.spaceId === state.activeSpaceId),
    ),
  );
}

export function BrowserTabs({ state, activate, newTab, showArchive, run }: Props) {
  const tabs = visibleBrowserTabs(state);
  const favorites = tabs.filter((tab) => tab.kind === 'favorite');
  const pinned = tabs.filter((tab) => tab.kind === 'pinned');
  const today = tabs.filter((tab) => !tab.kind || tab.kind === 'today');
  const name = (tab: Tab) =>
    tab.url === 'about:blank' ? '新标签页' : tab.title || hostname(tab.url);
  const agentState = (tab: Tab) => {
    const background = state.agentTabs?.find((entry) => entry.tabId === tab.id);
    return {
      target: state.agentTabId === tab.id || Boolean(background),
      live:
        (state.agentTabId === tab.id && state.agentActivityPhase === 'act') ||
        Boolean(background?.running),
    };
  };
  const agentBadge = (tab: Tab) => {
    const agent = agentState(tab);
    return agent.target ? (
      <span
        className={clsx('tab-agent', { 'is-live': agent.live })}
        aria-hidden="true"
        title="Agent 正在操作这个标签页"
      >
        AI
      </span>
    ) : null;
  };
  const row = (tab: Tab) => {
    const agent = agentState(tab);
    const title = name(tab);
    return (
      <div
        key={tab.id}
        className={clsx('tab', 'browser-tab', {
          active: tab.id === state.activeTabId,
          'agent-target': agent.target,
        })}
        data-tab-id={tab.id}
        onContextMenu={(event) => {
          event.preventDefault();
          void run(() => window.pilion.tabs.menu(tab.id));
        }}
      >
        <button
          className="tab-target"
          role="tab"
          aria-selected={tab.id === state.activeTabId}
          aria-label={agent.target ? `${title}，Agent 正在操作` : title}
          title={tab.url}
          onClick={() => activate(tab.id)}
        >
          {tab.loading ? (
            <LoaderCircle size={15} className="spin" />
          ) : tab.error || tab.crashed ? (
            <CircleAlert size={15} />
          ) : tab.kind === 'pinned' ? (
            <Pin size={14} />
          ) : (
            <Globe2 size={15} />
          )}
          <span className="tab-title">{title}</span>
          {agentBadge(tab)}
        </button>
        <IconButton
          label={`标签菜单 ${title}`}
          className="tab-menu"
          onClick={() => void run(() => window.pilion.tabs.menu(tab.id))}
        >
          <MoreHorizontal size={14} />
        </IconButton>
        <IconButton
          label={`关闭 ${tab.title}`}
          className="tab-close"
          onClick={() => void run(() => window.pilion.tabs.close(tab.id))}
        >
          <X size={13} />
        </IconButton>
      </div>
    );
  };
  return (
    <div className="tabs browser-tabs" role="tablist" aria-label="浏览器标签页">
      {favorites.length > 0 && (
        <section className="favorite-section" aria-label="常用标签">
          <div className="favorite-grid">
            {favorites.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={tab.id === state.activeTabId}
                className={clsx('favorite-tab', { 'agent-target': agentState(tab).target })}
                aria-label={name(tab)}
                title={`${name(tab)} · ${hostname(tab.url)}`}
                onClick={() => activate(tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void run(() => window.pilion.tabs.menu(tab.id));
                }}
              >
                <span className="favorite-mark">
                  {hostname(tab.url)
                    .replace(/^www\./, '')
                    .charAt(0)
                    .toUpperCase()}
                </span>
                <span className="favorite-name">{name(tab)}</span>
                {agentBadge(tab)}
              </button>
            ))}
          </div>
        </section>
      )}
      {pinned.length > 0 && (
        <section aria-label="固定标签">
          <div className="browser-tab-heading">
            <Pin size={11} />
            <span>固定标签</span>
          </div>
          {pinned.map(row)}
        </section>
      )}
      <section aria-label="普通标签">
        <div className="browser-tab-heading">
          <span>今天</span>
          <span className="browser-tab-count">{today.length}</span>
          <IconButton label="新建标签页" onClick={newTab}>
            <Plus size={14} />
          </IconButton>
        </div>
        {today.map(row)}
        <button className="new-tab-row" onClick={newTab}>
          <Plus size={15} />
          新建标签页
        </button>
      </section>
      <button className="archive-link" onClick={showArchive}>
        <Archive size={14} />
        <span>已归档标签</span>
        {(state.archivedTabs?.length ?? 0) > 0 && <span>{state.archivedTabs!.length}</span>}
      </button>
    </div>
  );
}
