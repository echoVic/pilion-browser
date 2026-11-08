import type { AppState, Tab } from '../shared/contracts';
import { isAgentSpace, type SpaceColor } from '../shared/tab-organization';
import { hostname } from './ui';

/**
 * 「任务总览」的数据模型：把散在 spaces / tabs / externalAgentTabs / approvals 里的
 * 外部 Agent 任务收敛成卡片。纯函数，渲染层只负责画，方便单测覆盖状态判定与排序。
 *
 * 只收「值得现在处理」的空间：进行中、等人确认、被接管待交还、已交还待恢复；
 * 已结束（stopped / idle / restart / closed）只计数，不在卡片里占位置。
 */

export type TaskCardStatus = 'confirm' | 'running' | 'held' | 'recoverable';

export interface TaskCard {
  spaceId: string;
  /** 空间名，也就是任务名。 */
  label: string;
  /** 空间主题色，和侧栏的空间色点保持一致，卡片一眼能对上。 */
  color: SpaceColor;
  /** 外部客户端名；未注册时回退「外部客户端」。 */
  clientName: string;
  status: TaskCardStatus;
  /** 代表这一任务的标签：Agent 最近操作的标签，否则空间里最近活跃的页面。 */
  tabId?: string;
  pageTitle?: string;
  pageHost?: string;
  tabCount: number;
  /** 空间内最近的活动时间（毫秒）。 */
  lastActiveAt?: number;
  /** 外部连接刚上报过活动阶段：卡片上显示「正在操作」的呼吸点。 */
  live: boolean;
}

export interface TaskOverviewModel {
  cards: TaskCard[];
  /** 已结束、可在侧栏清理的 Agent 空间数量。 */
  endedCount: number;
}

export const STATUS_TEXT: Record<TaskCardStatus, string> = {
  confirm: '等待确认',
  running: '运行中',
  held: '已接管 · 待交还',
  recoverable: '已交还 · 可恢复',
};

const STATUS_ORDER: Record<TaskCardStatus, number> = {
  confirm: 0,
  held: 1,
  running: 2,
  recoverable: 3,
};

/** 空间里最近活跃的页面：Agent 正在操作的那个最可信，其次按 lastActiveAt 取最近的。 */
function representativeTab(
  tabs: ReadonlyArray<Tab>,
  agentTabId: string | undefined,
): Tab | undefined {
  const live = agentTabId ? tabs.find((tab) => tab.id === agentTabId) : undefined;
  if (live) return live;
  const ordered = [...tabs].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  return ordered.find((tab) => tab.url !== 'about:blank') ?? ordered[0];
}

function latestActivity(
  tabs: ReadonlyArray<Tab>,
  fallback: number | undefined,
): number | undefined {
  const times = tabs.map((tab) => tab.lastActiveAt ?? 0).filter((time) => time > 0);
  if (times.length) return Math.max(...times);
  return fallback;
}

export function taskOverviewModel(state: AppState, now = Date.now()): TaskOverviewModel {
  const clientNames = state.agentClientNames ?? {};
  const approvals = state.approvals ?? [];
  const externalTabs = state.externalAgentTabs ?? [];
  const cards: TaskCard[] = [];
  let endedCount = 0;

  for (const space of state.spaces ?? []) {
    if (!isAgentSpace(space)) continue;
    const agent = space.agent;
    const held = agent.takenOverAt !== undefined;
    const recoverable = !held && agent.state === 'ended' && agent.endReason === 'handed_back';
    if (!held && !recoverable && agent.state !== 'active') {
      endedCount += 1;
      continue;
    }
    const pending = approvals.some(
      (approval) => approval.state === 'pending' && approval.spaceId === space.id,
    );
    const status: TaskCardStatus = held
      ? 'held'
      : recoverable
        ? 'recoverable'
        : pending
          ? 'confirm'
          : 'running';
    const tabs = state.tabs.filter((tab) => tab.spaceId === space.id);
    const liveTabId = externalTabs.find((tab) => tab.spaceId === space.id)?.tabId;
    const tab = representativeTab(tabs, liveTabId);
    const fallbackActivity = agent.endedAt ?? agent.createdAt;
    cards.push({
      spaceId: space.id,
      label: agent.label,
      color: space.color,
      clientName: clientNames[agent.clientId] ?? '外部客户端',
      status,
      ...(tab
        ? {
            tabId: tab.id,
            pageTitle: tab.title || hostname(tab.url) || '新标签页',
            pageHost: hostname(tab.url),
          }
        : {}),
      tabCount: tabs.length,
      lastActiveAt: latestActivity(tabs, fallbackActivity),
      live: liveTabId !== undefined,
    });
  }

  cards.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.lastActiveAt ?? now) - (a.lastActiveAt ?? now),
  );
  return { cards, endedCount };
}

/** 「刚刚活动 / 3 分钟前活动 / 2 小时前活动 / 3 天前活动」。 */
export function activityLabel(lastActiveAt: number | undefined, now = Date.now()): string {
  if (!lastActiveAt) return '暂时没有活动记录';
  const elapsed = Math.max(0, now - lastActiveAt);
  if (elapsed < 60_000) return '刚刚有活动';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前有活动`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前有活动`;
  return `${Math.floor(elapsed / 86_400_000)} 天前有活动`;
}
