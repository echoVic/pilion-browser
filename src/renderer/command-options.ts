import type { AppState } from '../shared/contracts';
import type { AppAction } from '../shared/keybindings';
import { hostname } from './ui';

export type CommandOption =
  | { id: string; label: string; detail: string; kind: 'tab'; tabId: string }
  | { id: string; label: string; detail: string; kind: 'page'; url: string }
  | { id: string; label: string; detail: string; kind: 'search'; query: string }
  | { id: string; label: string; detail: string; kind: 'action'; action: AppAction };

const actions: { label: string; action: AppAction }[] = [
  { label: '新建空白标签页', action: 'newBlankTab' },
  { label: '查看书签', action: 'showBookmarks' },
  { label: '查看浏览历史', action: 'showHistory' },
  { label: '查看已归档标签', action: 'showArchive' },
  { label: '查看下载', action: 'showDownloads' },
  { label: '打开设置', action: 'settings' },
  { label: '复制当前网址', action: 'copyUrl' },
  { label: '显示或隐藏 Agent 面板', action: 'togglePanel' },
  { label: '显示或隐藏侧边栏', action: 'toggleSidebar' },
  { label: '查看技能库', action: 'showSkills' },
];

/** 同一个网址优先切换已打开的页，再列书签/历史；最后才新建搜索页。 */
export function commandOptions(state: AppState, query: string): CommandOption[] {
  const commandsOnly = query.trimStart().startsWith('>');
  const text = (commandsOnly ? query.trimStart().slice(1) : query).trim().toLowerCase();
  const matches = (value: string) =>
    text.split(/\s+/).every((word) => value.toLowerCase().includes(word));
  const options: CommandOption[] = [];
  const urls = new Set<string>();
  if (!commandsOnly) {
    const tabs = [...state.tabs].sort(
      (a, b) =>
        Number(b.spaceId === state.activeSpaceId) - Number(a.spaceId === state.activeSpaceId),
    );
    for (const tab of tabs) {
      const space = state.spaces?.find((item) => item.id === tab.spaceId)?.name ?? '';
      if (!matches(`${tab.title} ${tab.url} ${space}`)) continue;
      urls.add(tab.url);
      options.push({
        id: `tab-${tab.id}`,
        kind: 'tab',
        tabId: tab.id,
        label: tab.url === 'about:blank' ? '新标签页' : tab.title || hostname(tab.url),
        detail: `切换标签${space ? ` · ${space}` : ''} · ${hostname(tab.url)}`,
      });
    }
    if (text)
      for (const page of [...(state.bookmarks ?? []), ...(state.history ?? [])]) {
        if (urls.has(page.url) || !matches(`${page.title} ${page.url}`)) continue;
        urls.add(page.url);
        options.push({
          id: `page-${options.length}`,
          kind: 'page',
          url: page.url,
          label: page.title || hostname(page.url),
          detail: `书签 / 历史 · ${hostname(page.url)}`,
        });
      }
  }
  for (const action of actions)
    if (matches(action.label)) {
      options.push({
        id: `action-${action.action}`,
        kind: 'action',
        ...action,
        detail: '浏览器操作',
      });
    }
  if (text && !commandsOnly) {
    options.push({
      id: 'search',
      kind: 'search',
      query: query.trim(),
      label: `打开或搜索「${query.trim()}」`,
      detail: '在新标签页中打开',
    });
  }
  return options.slice(0, 14);
}
