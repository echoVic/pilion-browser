// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState, AgentConfig } from '../src/shared/contracts';
import { ConversationAgentNotice } from '../src/renderer/panel/ConversationAgentNotice';
import { ConversationPanel } from '../src/renderer/ConversationPanel';

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = async (action: () => Promise<unknown>) => {
  await action();
  return true;
};

const agentsApi = {
  retryConversation: vi.fn(async () => {}),
  useAgentForConversation: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
};

beforeEach(() => {
  agentsApi.retryConversation.mockClear();
  agentsApi.useAgentForConversation.mockClear();
  agentsApi.connect.mockClear();
  vi.stubGlobal('window', { pilion: { agents: agentsApi } });
});

const config = (id: string, name: string, enabled = true): AgentConfig => ({
  id,
  name,
  command: 'node',
  args: [],
  enabled,
});

it('connecting：role=status 播报本对话 Agent 名称', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: {
        conversationId: 'c1',
        agentId: 'old-agent',
        agentName: 'Restore Agent',
        state: 'connecting',
      },
      busy: false,
      run,
    }),
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('Restore Agent');
  expect(html).toContain('历史消息可以先浏览');
});

it('unavailable：.is-warn + role=alert + 原 Agent 不可用文案；下拉过滤掉 disabled 与原 Agent', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: {
        conversationId: 'c1',
        agentId: 'old-agent',
        agentName: 'Restore Agent',
        state: 'unavailable',
      },
      agents: [
        config('old-agent', 'Restore Agent'),
        config('disabled-agent', 'Disabled Agent', false),
        config('other-agent', 'Other Agent'),
      ],
      busy: false,
      run,
    }),
  );
  expect(html).toContain('class="composer-notice is-warn"');
  expect(html).toContain('role="alert"');
  expect(html).toContain('原 Agent（Restore Agent）不可用');
  // 下拉里只有 Other Agent：原 Agent 自己与 disabled 的都不出现
  expect(html).toContain('value="other-agent"');
  expect(html).not.toContain('value="old-agent"');
  expect(html).not.toContain('value="disabled-agent"');
});

it('unavailable：选择下拉项调用 useAgentForConversation(conversationId, agentId)', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ConversationAgentNotice, {
        view: {
          conversationId: 'c1',
          agentId: 'old-agent',
          agentName: 'Restore Agent',
          state: 'unavailable',
        },
        agents: [config('old-agent', 'Restore Agent'), config('other-agent', 'Other Agent')],
        busy: false,
        run,
      }),
    );
  });
  const select = container.querySelector('select');
  expect(select?.getAttribute('aria-label')).toBe('为对话选择其他 Agent');
  await act(async () => {
    select!.value = 'other-agent';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(agentsApi.useAgentForConversation).toHaveBeenCalledTimes(1);
  expect(agentsApi.useAgentForConversation).toHaveBeenCalledWith('c1', 'other-agent');
  await act(async () => {
    await root!.unmount();
  });
});

it('failed：显示 error，点重试调用 retryConversation，且不调 agents.connect', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | undefined;
  const failed = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'failed', error: '连接超时' },
      busy: false,
      run,
    }),
  );
  expect(failed).toContain('恢复失败：连接超时');
  expect(failed).toContain('role="alert"');
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ConversationAgentNotice, {
        view: { conversationId: 'c1', state: 'failed', error: '连接超时' },
        busy: false,
        run,
      }),
    );
  });
  const button = container.querySelector('button');
  expect(button?.textContent).toContain('重试');
  await act(async () => {
    button!.click();
  });
  expect(agentsApi.retryConversation).toHaveBeenCalledTimes(1);
  expect(agentsApi.retryConversation).toHaveBeenCalledWith('c1');
  expect(agentsApi.connect).not.toHaveBeenCalled();
  await act(async () => {
    await root!.unmount();
  });
});

it('capacity 与 failed 文案不同', () => {
  const failed = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'failed', error: '连接超时' },
      busy: false,
      run,
    }),
  );
  const capacity = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'capacity' },
      busy: false,
      run,
    }),
  );
  expect(capacity).toContain('并发会话已达上限');
  expect(capacity).not.toContain('恢复失败');
  expect(failed).toContain('恢复失败：连接超时');
});

it('ready：new_session_no_context / session_reset 分别提示；无 notice 不渲染', () => {
  const fresh = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: {
        conversationId: 'c1',
        state: 'ready',
        agentName: 'Other Agent',
        notice: 'new_session_no_context',
      },
      busy: false,
      run,
    }),
  );
  expect(fresh).toContain('已用 Other Agent 新会话继续，之前的上下文未带入');

  const reset = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'ready', notice: 'session_reset' },
      busy: false,
      run,
    }),
  );
  expect(reset).toContain('会话已重置，之前的上下文未带入');

  const silent = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'ready', agentName: 'Other Agent' },
      busy: false,
      run,
    }),
  );
  expect(silent).toBe('');
});

it('头部：unavailable 时显示本对话 Agent 名，不沿用 connectedAgentId 对应的上一条对话', () => {
  vi.stubGlobal('window', {});
  const state = {
    tabs: [],
    agents: [config('other-agent', 'Other Agent')],
    agentStatus: 'none',
    attachmentStatus: 'none',
    approvals: [],
    pendingApprovalsByConversation: {},
    conversationAgents: {
      c1: {
        conversationId: 'c1',
        agentId: 'old-agent',
        agentName: 'Restore Agent',
        state: 'unavailable',
      },
    },
    conversations: [
      {
        id: 'c1',
        title: '历史对话',
        updatedAt: '2026-10-14T14:00:00+08:00',
        messages: [],
        agentName: 'Restore Agent',
      },
    ],
    activeConversationId: 'c1',
    // connectedAgentId 仍指向上一条对话的 Agent：头部必须忽略它，显示 Restore Agent
    connectedAgentId: 'other-agent',
    events: [],
  } as unknown as AppState;
  const html = renderToStaticMarkup(
    createElement(ConversationPanel, {
      state,
      settings() {},
      close() {},
      run,
      draft: '',
      setDraft() {},
    }),
  );
  expect(html).toContain('Restore Agent（不可用）');
  expect(html).toContain('当前对话的 Agent：Restore Agent（不可用）');
});

it('头部：ready 状态保持现有行为，显示 connectedAgentId 对应 Agent', () => {
  vi.stubGlobal('window', {});
  const state = {
    tabs: [],
    agents: [config('other-agent', 'Other Agent')],
    agentStatus: 'ready',
    attachmentStatus: 'none',
    approvals: [],
    pendingApprovalsByConversation: {},
    conversationAgents: {
      c1: {
        conversationId: 'c1',
        agentId: 'other-agent',
        agentName: 'Other Agent',
        state: 'ready',
      },
    },
    conversations: [
      { id: 'c1', title: '历史对话', updatedAt: '2026-10-14T14:00:00+08:00', messages: [] },
    ],
    activeConversationId: 'c1',
    connectedAgentId: 'other-agent',
    events: [],
  } as unknown as AppState;
  const html = renderToStaticMarkup(
    createElement(ConversationPanel, {
      state,
      settings() {},
      close() {},
      run,
      draft: '',
      setDraft() {},
    }),
  );
  expect(html).not.toContain('（不可用）');
  expect(html).toContain('value="other-agent"');
});
