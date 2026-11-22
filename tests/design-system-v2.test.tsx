// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ApprovalViewState, ConversationMessage } from '../src/shared/contracts';
import { groupConversationMessages, type ToolStepItem } from '../src/renderer/chat-adapter';
import { ConversationPanel } from '../src/renderer/ConversationPanel';
import { ComposerStore } from '../src/renderer/composer/composer-store';
import { InlineApproval } from '../src/renderer/InlineApproval';

const msg = (
  id: string,
  role: ConversationMessage['role'],
  text: string,
  status?: ConversationMessage['status'],
): ConversationMessage => ({
  id,
  role,
  text,
  status,
  time: '2026-11-21T22:00:00+08:00',
});

describe('groupConversationMessages', () => {
  it('keeps isolated single tool calls flat and collapses consecutive >= 2 tools', () => {
    const grouped = groupConversationMessages([
      msg('u1', 'user', '帮我查价格'),
      msg('t1', 'tool', 'browser.open', 'completed'),
      msg('a1', 'assistant', '已打开页面'),
      msg('t2', 'tool', 'browser.read', 'completed'),
      msg('t3', 'tool', 'browser.click', 'running'),
    ]);
    expect(grouped).toHaveLength(4);
    expect(grouped[1].metadata?.custom?.kind).toBe('tool');
    expect(grouped[3].metadata?.custom?.kind).toBe('tool-group');
    expect(grouped[3].id).toBe('t2');
    expect(grouped[3].status).toEqual({ type: 'running' });
    expect(grouped[3].metadata?.custom?.settled).toBe(false);
    expect(grouped[3].metadata?.custom?.steps as ToolStepItem[]).toEqual([
      { id: 't2', name: 'browser.read', status: 'completed' },
      { id: 't3', name: 'browser.click', status: 'running' },
    ]);
  });

  it('marks settled completed and failed groups accurately', () => {
    const grouped = groupConversationMessages([
      msg('t1', 'tool', 'browser.open', 'completed'),
      msg('t2', 'tool', 'browser.click', 'failed'),
      msg('a1', 'assistant', '点击失败了'),
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].metadata?.custom?.kind).toBe('tool-group');
    expect(grouped[0].metadata?.custom?.settled).toBe(true);
    expect(grouped[0].status).toEqual({ type: 'incomplete', reason: 'error' });
  });
});

describe('InlineApproval Split Button', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders a single primary button without split menu when no scopes are advertised', async () => {
    const approval: ApprovalViewState = {
      approvalId: 'a1',
      tool: 'browser.click',
      summary: 'click submit',
      state: 'pending',
      nonce: 'n1',
      actionDigest: 'd1',
    };
    await act(async () => {
      root!.render(createElement(InlineApproval, { approval, count: 1, run: async () => true }));
    });
    expect(container.querySelector('.appr-split')).toBeNull();
    expect(container.querySelector('.appr-actions .btn-primary')?.textContent).toContain(
      '批准一次',
    );
  });

  it('renders a monochrome split button and toggles the scope menu cleanly', async () => {
    const approval: ApprovalViewState = {
      approvalId: 'a2',
      externalClientName: 'Claude Code',
      allowedScopes: ['space', 'client'],
      tool: 'browser.click("提交订单")',
      summary: 'click checkout',
      state: 'pending',
      nonce: 'n2',
      actionDigest: 'd2',
    };
    await act(async () => {
      root!.render(createElement(InlineApproval, { approval, count: 2, run: async () => true }));
    });
    const caret = container.querySelector<HTMLButtonElement>('.appr-split-caret');
    const menu = container.querySelector<HTMLDivElement>('.appr-split-menu');
    expect(caret).not.toBeNull();
    expect(menu).not.toBeNull();
    expect(menu!.hidden).toBe(true);
    expect(container.querySelector('.appr-split-main')?.textContent).toContain('本任务允许');

    await act(async () => {
      caret!.click();
    });
    expect(menu!.hidden).toBe(false);
    expect(caret!.getAttribute('aria-expanded')).toBe('true');
    expect(menu!.textContent).toContain('批准一次');
    expect(menu!.textContent).toContain('始终允许此客户端');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(menu!.hidden).toBe(true);
  });
});

describe('Interactive & intermediate conversation states', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    Reflect.deleteProperty(window, 'pilion');
    vi.unstubAllGlobals();
  });

  it('renders streaming caret, live thinking label, active tool state, working dots and resets copy feedback', async () => {
    vi.useFakeTimers();
    const copyMessage = vi.fn(async () => {});
    Object.defineProperty(window, 'pilion', {
      configurable: true,
      value: {
        getState: vi.fn(async () => state),
        workspace: { copyMessage },
        agents: {},
      },
    });
    const state: AppState = {
      tabs: [],
      agents: [{ id: 'a1', name: 'Claude', command: 'node', args: [], enabled: true }],
      connectedAgentId: 'a1',
      agentStatus: 'running',
      attachmentStatus: 'attached',
      approvals: [],
      pendingApprovalsByConversation: {},
      conversationAgents: {},
      events: [],
      activeConversationId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: '实时流测试',
          updatedAt: '',
          messages: [
            msg('u1', 'user', '检查状态'),
            msg('th1', 'thought', '正在分析 DOM 结构', 'running'),
            msg('t1', 'tool', 'browser.read', 'running'),
            msg('a1', 'assistant', '已完成初步读取', 'completed'),
            msg('a2', 'assistant', '正在继续生成', 'running'),
          ],
        },
      ],
    };

    const composerStore = new ComposerStore();
    await act(async () => {
      root!.render(
        createElement(ConversationPanel, {
          state,
          run: async (fn) => {
            await fn();
            return true;
          },
          composer: composerStore,
          settings() {},
          close() {},
        }),
      );
    });

    expect(container.querySelector('.working-pill')?.textContent).toContain('Agent 正在工作');
    expect(container.querySelectorAll('.working-pill .typing-dots i')).toHaveLength(3);
    expect(container.querySelector('.thought.is-streaming')?.hasAttribute('open')).toBe(true);
    expect(container.querySelector('.thought.is-streaming summary')?.textContent).toContain(
      '正在思考…',
    );
    expect(container.querySelector('.tool-message.running')).not.toBeNull();
    expect(container.querySelector('.msg-assistant.is-streaming')).not.toBeNull();

    const settledState: AppState = {
      ...state,
      agentStatus: 'ready',
      conversations: [
        {
          id: 'c1',
          title: '实时流测试',
          updatedAt: '',
          messages: [
            msg('u1', 'user', '检查状态'),
            msg('a1', 'assistant', '已完成初步读取', 'completed'),
          ],
        },
      ],
    };
    await act(async () => {
      root!.render(
        createElement(ConversationPanel, {
          state: settledState,
          run: async (fn) => {
            await fn();
            return true;
          },
          composer: composerStore,
          settings() {},
          close() {},
        }),
      );
    });

    const copyBtn = container.querySelector<HTMLButtonElement>('.msg-footer button');
    expect(copyBtn).not.toBeNull();
    await act(async () => {
      copyBtn!.click();
    });
    expect(copyMessage).toHaveBeenCalledWith('a1');
    expect(copyBtn!.classList.contains('copied')).toBe(true);
    expect(copyBtn!.getAttribute('aria-label')).toBe('已复制');

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(copyBtn!.classList.contains('copied')).toBe(false);
    expect(copyBtn!.getAttribute('aria-label')).toBe('复制回复');
  });
});
