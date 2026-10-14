import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi, afterEach } from 'vitest';
import { ConversationTabs } from '../src/renderer/panel/ConversationTabs';
import { TaskControlBar } from '../src/renderer/panel/TaskControlBar';
import { ConversationAgentNotice } from '../src/renderer/panel/ConversationAgentNotice';

afterEach(() => vi.unstubAllGlobals());

const conversation = {
  id: 'c1',
  title: '商品比价',
  updatedAt: '2026-10-14T14:00:00+08:00',
  messages: [],
};
const run = async () => true;

it('会话标签行：当前会话选中、待审批角标、历史与新对话入口', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTabs, {
      conversations: [conversation],
      activeId: 'c1',
      approvalsByConversation: { c1: 2 },
      run,
    }),
  );
  expect(html).toContain('商品比价');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('2 项待审批');
  expect(html).toContain('aria-label="历史对话"');
  expect(html).toContain('aria-label="新对话"');
});

it('任务控制条：运行中=接管+停止；人工=继续任务+停止；其他不渲染', () => {
  const running = renderToStaticMarkup(
    createElement(TaskControlBar, {
      task: { id: 't1', agentId: 'a1', goal: 'g', status: 'running', updatedAt: '' },
      busy: false,
      run,
    }),
  );
  expect(running).toContain('接管');
  expect(running).toContain('停止任务');
  expect(running).not.toContain('继续任务');

  const manual = renderToStaticMarkup(
    createElement(TaskControlBar, {
      task: { id: 't1', agentId: 'a1', goal: 'g', status: 'manual', updatedAt: '' },
      busy: false,
      run,
    }),
  );
  expect(manual).toContain('继续任务');

  expect(
    renderToStaticMarkup(
      createElement(TaskControlBar, {
        task: { id: 't1', agentId: 'a1', goal: 'g', status: 'completed', updatedAt: '' },
        busy: false,
        run,
      }),
    ),
  ).toBe('');
});

it('恢复原 Agent 三态：连接中/不可用/失败重试', () => {
  const connecting = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', agentId: 'a1', agentName: 'Claude Code', state: 'connecting' },
      busy: false,
      run,
    }),
  );
  expect(connecting).toContain('正在连接Claude Code');
  expect(connecting).toContain('历史消息可以先浏览');

  const missing = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', agentId: 'a1', agentName: 'Claude Code', state: 'unavailable' },
      busy: false,
      run,
    }),
  );
  expect(missing).toContain('原 Agent（Claude Code）不可用');
  expect(missing).toContain('不会带上之前的上下文');

  const failed = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'failed', error: '连接超时' },
      busy: false,
      run,
    }),
  );
  expect(failed).toContain('恢复失败：连接超时');
  expect(failed).toContain('重试');

  const capacity = renderToStaticMarkup(
    createElement(ConversationAgentNotice, {
      view: { conversationId: 'c1', state: 'capacity' },
      busy: false,
      run,
    }),
  );
  expect(capacity).toContain('并发会话已达上限');
});
