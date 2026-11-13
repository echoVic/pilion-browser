// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState, Conversation } from '../src/shared/contracts';
import { ConversationLibrary } from '../src/renderer/ConversationLibrary';

const conversation = (id: string, running = false): Conversation =>
  ({
    id,
    title: `对话 ${id}`,
    updatedAt: '2026-11-01T00:00:00Z',
    messages: [{ id: `m-${id}`, role: 'user', text: '你好', time: '2026-11-01T00:00:00Z' }],
    ...(running ? { task: { status: 'running' } } : {}),
  }) as Conversation;
// 当前对话的 Agent 正在跑：旧实现会把「新对话」和每一行都禁掉。
const conversations = [conversation('A', true), conversation('B')];
const state = {
  tabs: [],
  agents: [],
  agentStatus: 'running',
  attachmentStatus: 'attached',
  approvals: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  events: [],
  conversations,
  activeConversationId: 'A',
} as unknown as AppState;

const newConversation = vi.fn(async () => {});
const selectConversation = vi.fn<(id: string) => Promise<void>>(async () => {});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  newConversation.mockClear();
  selectConversation.mockClear();
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { workspace: { newConversation, selectConversation } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

it('lets the person start or switch conversations while another one is running', async () => {
  const onOpened = vi.fn();
  await act(async () =>
    root.render(
      createElement(ConversationLibrary, {
        state,
        conversations,
        native: true,
        run: async (action: () => Promise<unknown>) => {
          await action();
          return true;
        },
        onOpened,
        search: null,
        empty: null,
      }),
    ),
  );
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.filter((button) => button.disabled)).toEqual([]);
  await act(async () => buttons.find((button) => button.textContent === '新对话')!.click());
  expect(newConversation).toHaveBeenCalledOnce();
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.library-row')[1].click());
  expect(selectConversation).toHaveBeenCalledWith('B');
  expect(onOpened).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="Agent 正在运行"]')).not.toBeNull();
});
