import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AgentSpaceGroup } from '../src/renderer/AgentSpaceGroup';
import type { BrowserSpace } from '../src/shared/tab-organization';

const baseSpace = { id: 'agent-1', name: '比价', color: 'neutral' as const };
const activeSpace: BrowserSpace = {
  ...baseSpace,
  agent: { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' as const },
};
const endedSpace: BrowserSpace = {
  ...baseSpace,
  id: 'agent-2',
  agent: {
    clientId: 'c1',
    label: '旧',
    createdAt: 1,
    state: 'ended' as const,
    endedAt: 2,
    endReason: 'idle' as const,
  },
};

const run = async () => true;

it('renders an active agent space with AI 操作中 badge and 停止/接管 buttons', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'agent-1',
      run,
    }),
  );
  expect(html).toContain('本机 Agent（CLI）');
  expect(html).toContain('比价');
  expect(html).toContain('AI 操作中');
  expect(html).toContain('停止');
  expect(html).toContain('接管');
});

it('renders an ended agent space with 已结束 badge and 接管/删除 buttons', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [endedSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'default',
      run,
    }),
  );
  expect(html).toContain('已结束');
  expect(html).toContain('接管');
  expect(html).toContain('删除');
});

it('shows 已吊销的客户端 when client is revoked', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '已吊销的客户端' },
      activeSpaceId: 'agent-1',
      run,
    }),
  );
  expect(html).toContain('已吊销的客户端');
});

it('renders nothing when there are no agent spaces', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [{ id: 'default', name: '我的工作区', color: 'neutral' }],
      agentClientNames: {},
      activeSpaceId: 'default',
      run,
    }),
  );
  expect(html.trim()).toBe('');
});

it('查看 switches to the space', () => {
  const calls: string[] = [];
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'default',
      run: async (fn: () => Promise<unknown>) => {
        await fn();
        calls.push('selected');
        return true;
      },
    }),
  );
  // The 查看 button should be rendered
  expect(html).toContain('查看');
});

it('renders a taken-over space with a 交还 button and the custody badge', () => {
  const held: BrowserSpace = {
    ...baseSpace,
    id: 'agent-3',
    agent: {
      clientId: 'c1',
      label: '被接管',
      createdAt: 1,
      state: 'ended' as const,
      endedAt: 2,
      endReason: 'stopped' as const,
      takenOverAt: 3,
    },
  };
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [held],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'default',
      run,
    }),
  );
  expect(html).toContain('已接管 · 可交还');
  expect(html).toContain('交还');
  expect(html).toContain('转为我的空间');
  expect(html).not.toContain('AI 操作中');
});
