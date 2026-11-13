import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AppState, Tab } from '../src/shared/contracts';
import { BrowserTabs } from '../src/renderer/BrowserTabs';

const tab = (id: string): Tab =>
  ({ id, title: `页面 ${id}`, url: `https://${id}.example/`, loading: false }) as Tab;
const base = {
  tabs: [tab('a')],
  activeTabId: 'a',
  agentTabId: 'a',
  agents: [],
  agentStatus: 'running',
  attachmentStatus: 'attached',
  approvals: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  events: [],
} as unknown as AppState;
const labelOf = (state: AppState) =>
  /role="tab"[^>]*aria-label="([^"]*)"/.exec(
    renderToStaticMarkup(
      createElement(BrowserTabs, {
        state,
        activate() {},
        newTab() {},
        showArchive() {},
        run: async () => true,
      }),
    ),
  )?.[1];

it('announces that the Agent is operating only while it acts on that tab', () => {
  expect(labelOf({ ...base, agentActivityPhase: 'act' })).toBe('页面 a，Agent 正在操作');
  expect(labelOf({ ...base, agentActivityPhase: 'think' })).toBe('页面 a，Agent 在用');
  expect(labelOf({ ...base, agentActivityPhase: 'confirm' })).toBe('页面 a，Agent 在用');
  expect(labelOf({ ...base, agentTabId: undefined })).toBe('页面 a');
});

it('follows background and external Agent activity the same way', () => {
  const idle = { ...base, agentTabId: undefined };
  expect(labelOf({ ...idle, agentTabs: [{ tabId: 'a', running: true }] } as AppState)).toBe(
    '页面 a，Agent 正在操作',
  );
  expect(labelOf({ ...idle, agentTabs: [{ tabId: 'a', running: false }] } as AppState)).toBe(
    '页面 a，Agent 在用',
  );
  expect(
    labelOf({
      ...idle,
      externalAgentTabs: [{ tabId: 'a', phase: 'think', principal: 'p' }],
    } as unknown as AppState),
  ).toBe('页面 a，Agent 在用');
});
