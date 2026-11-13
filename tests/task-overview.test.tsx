// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskOverview } from '../src/renderer/TaskOverview';
import { activityLabel, taskOverviewModel } from '../src/renderer/task-overview';
import type { AppState, Tab } from '../src/shared/contracts';
import type { BrowserSpace } from '../src/shared/tab-organization';

const now = 1_800_000_000_000;

function tab(id: string, spaceId: string, title: string, lastActiveAt = now - 120_000): Tab {
  return {
    id,
    spaceId,
    kind: 'today',
    lastActiveAt,
    title,
    url: `https://${id}.example.com/page`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    crashed: false,
  };
}

const human: BrowserSpace = { id: 'default', name: '我的工作区', color: 'neutral' };
const running: BrowserSpace = {
  id: 'agent-run',
  name: '发布 X 文章',
  color: 'teal',
  agent: { clientId: 'c1', label: '发布 X 文章', createdAt: 1, state: 'active' },
};
const confirming: BrowserSpace = {
  id: 'agent-confirm',
  name: '提交表单',
  color: 'amber',
  agent: { clientId: 'c2', label: '提交表单', createdAt: 2, state: 'active' },
};
const held: BrowserSpace = {
  id: 'agent-held',
  name: '比价',
  color: 'blue',
  agent: {
    clientId: 'c1',
    label: '比价',
    createdAt: 3,
    state: 'ended',
    endedAt: 4,
    endReason: 'stopped',
    takenOverAt: 5,
  },
};
const handedBack: BrowserSpace = {
  id: 'agent-back',
  name: '整理资料',
  color: 'purple',
  agent: {
    clientId: 'c1',
    label: '整理资料',
    createdAt: 6,
    state: 'ended',
    endedAt: 7,
    endReason: 'handed_back',
  },
};
const ended: BrowserSpace = {
  id: 'agent-ended',
  name: '旧任务',
  color: 'rose',
  agent: {
    clientId: 'c1',
    label: '旧任务',
    createdAt: 8,
    state: 'ended',
    endedAt: 9,
    endReason: 'idle',
  },
};

function makeState(): AppState {
  return {
    tabs: [
      tab('live-tab', 'agent-run', '正在提交的作品', now - 30_000),
      tab('other-run-tab', 'agent-run', '另一个页面', now - 600_000),
      tab('confirm-tab', 'agent-confirm', '表单页', now - 60_000),
      tab('held-tab', 'agent-held', '商品比价页', now - 3_600_000),
      tab('back-tab', 'agent-back', '资料页面', now - 7_200_000),
      tab('ended-tab', 'agent-ended', '旧页面', now - 86_400_000),
      tab('human-tab', 'default', '我的页面'),
    ],
    spaces: [human, running, confirming, held, handedBack, ended],
    activeSpaceId: 'default',
    agents: [],
    agentStatus: 'ready',
    attachmentStatus: 'none',
    approvals: [
      {
        approvalId: 'a1',
        tool: 'browser.click',
        summary: '点击提交',
        state: 'pending',
        spaceId: 'agent-confirm',
      },
    ],
    pendingApprovalsByConversation: {},
    conversationAgents: {},
    events: [],
    externalAgentTabs: [
      { tabId: 'live-tab', principal: 'external:c1:agent-run', spaceId: 'agent-run', phase: 'act' },
    ],
    agentClientNames: { c1: 'Claude Code', c2: 'Codex' },
  } as AppState;
}

describe('task overview model', () => {
  it('collects actionable agent tasks, sorts confirm/held first and drops ended spaces', () => {
    const model = taskOverviewModel(makeState(), now);
    expect(model.cards.map((card) => [card.label, card.status])).toEqual([
      ['提交表单', 'confirm'],
      ['比价', 'held'],
      ['发布 X 文章', 'running'],
      ['整理资料', 'recoverable'],
    ]);
    // 已结束（idle）只计数，不占卡片位置；人自己的空间永远不出现。
    expect(model.endedCount).toBe(1);
  });

  it('uses the live agent tab as the representative page and reports client, host and activity', () => {
    const model = taskOverviewModel(makeState(), now);
    const runCard = model.cards.find((card) => card.label === '发布 X 文章')!;
    expect(runCard.pageTitle).toBe('正在提交的作品');
    expect(runCard.pageHost).toBe('live-tab.example.com');
    expect(runCard.clientName).toBe('Claude Code');
    expect(runCard.tabCount).toBe(2);
    expect(runCard.live).toBe(true);
    expect(runCard.lastActiveAt).toBe(now - 30_000);
    const confirmCard = model.cards.find((card) => card.label === '提交表单')!;
    expect(confirmCard.clientName).toBe('Codex');
  });

  it('keeps held and handed-back spaces in the overview with their own status', () => {
    const model = taskOverviewModel(makeState(), now);
    expect(model.cards.find((card) => card.spaceId === 'agent-held')).toMatchObject({
      status: 'held',
      pageTitle: '商品比价页',
    });
    expect(model.cards.find((card) => card.spaceId === 'agent-back')).toMatchObject({
      status: 'recoverable',
    });
  });

  it('falls back to the most recently active page when no live tab is reported', () => {
    const state = makeState();
    state.externalAgentTabs = [];
    const model = taskOverviewModel(state, now);
    const runCard = model.cards.find((card) => card.label === '发布 X 文章')!;
    expect(runCard.pageTitle).toBe('正在提交的作品');
    expect(runCard.live).toBe(false);
  });

  it('formats activity labels for every bucket', () => {
    expect(activityLabel(undefined, now)).toBe('暂时没有活动记录');
    expect(activityLabel(now - 20_000, now)).toBe('刚刚有活动');
    expect(activityLabel(now - 5 * 60_000, now)).toBe('5 分钟前有活动');
    expect(activityLabel(now - 2 * 3_600_000, now)).toBe('2 小时前有活动');
    expect(activityLabel(now - 3 * 86_400_000, now)).toBe('3 天前有活动');
  });
});

const handBackAgent = vi.fn(async () => {});
const takeOverAgent = vi.fn(async () => {});
const stopAgent = vi.fn(async () => {});
const select = vi.fn(async () => {});
const run = async (action: () => Promise<unknown>) => {
  await action();
  return true;
};

let container: HTMLDivElement;
let root: Root | undefined;

async function render(state: AppState, open = true) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onOpenChange = vi.fn();
  await act(async () => {
    root!.render(createElement(TaskOverview, { state, open, onOpenChange, run }));
  });
  return onOpenChange;
}

const dialog = () => document.body.querySelector<HTMLElement>('.task-overview-dialog');
const cardByLabel = (label: string) =>
  [...(dialog()?.querySelectorAll<HTMLElement>('.task-card') ?? [])].find((card) =>
    card.getAttribute('aria-label')?.startsWith(`${label}：`),
  );
const buttonByText = (scope: Element | null | undefined, text: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === text,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: {
      spaces: { remove: vi.fn(), select, stopAgent, takeOverAgent, handBackAgent, create: vi.fn() },
    },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.querySelectorAll('.task-overview-dialog').forEach((node) => node.remove());
  container?.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

it('renders one card per actionable agent task with its status and page', async () => {
  await render(makeState());
  expect(dialog()).not.toBeNull();
  expect(dialog()!.textContent).toContain('4 个任务');
  expect(cardByLabel('发布 X 文章')?.textContent).toContain('运行中');
  expect(cardByLabel('发布 X 文章')?.textContent).toContain('正在提交的作品');
  expect(cardByLabel('提交表单')?.textContent).toContain('等待确认');
  expect(cardByLabel('比价')?.textContent).toContain('已接管 · 待交还');
  expect(cardByLabel('整理资料')?.textContent).toContain('已交还 · 可恢复');
  expect(dialog()!.textContent).toContain('另有 1 个已结束的 Agent 空间');
});

it('opens a task from its card and closes the overview', async () => {
  const onOpenChange = await render(makeState());
  await act(async () => {
    (buttonByText(cardByLabel('发布 X 文章'), '查看') as HTMLElement).click();
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(select).toHaveBeenCalledExactlyOnceWith('agent-run');
});

it('exposes the status-specific primary action: 交还 for held tasks', async () => {
  const onOpenChange = await render(makeState());
  await act(async () => {
    (buttonByText(cardByLabel('比价'), '交还') as HTMLElement).click();
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(handBackAgent).toHaveBeenCalledExactlyOnceWith('agent-held');
});

it('offers 接管 and 停止 for running tasks and 再次接管 for recoverable ones', async () => {
  const onOpenChange = await render(makeState());
  expect(buttonByText(cardByLabel('发布 X 文章'), '接管')).toBeTruthy();
  expect(buttonByText(cardByLabel('发布 X 文章'), '停止')).toBeTruthy();
  await act(async () => {
    (buttonByText(cardByLabel('整理资料'), '再次接管') as HTMLElement).click();
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(takeOverAgent).toHaveBeenCalledExactlyOnceWith('agent-back');
});

it('shows the empty state when there is no agent task', async () => {
  const state = makeState();
  state.spaces = [human];
  state.approvals = [];
  state.externalAgentTabs = [];
  state.tabs = [tab('human-tab', 'default', '我的页面')];
  await render(state);
  expect(dialog()!.textContent).toContain('目前没有进行中的 Agent 任务');
});
