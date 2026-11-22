// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState, ApprovalViewState, PromptAttachment } from '../src/shared/contracts';
import type { ComposerInput } from '../src/renderer/ComposerInput';
import { ConversationPanel } from '../src/renderer/ConversationPanel';
import { ComposerStore } from '../src/renderer/composer/composer-store';

const observed = vi.hoisted(() => ({
  composer: undefined as ComponentProps<typeof ComposerInput> | undefined,
}));
vi.mock('../src/renderer/ComposerInput', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/ComposerInput')>();
  return {
    ComposerInput(props: ComponentProps<typeof ComposerInput>) {
      observed.composer = props;
      return createElement(original.ComposerInput, props);
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const image = (name: string): PromptAttachment => ({
  name,
  mimeType: 'image/png',
  data: 'aGVsbG8=',
});
const approval = (id: string, conversationId?: string): ApprovalViewState => ({
  approvalId: id,
  conversationId,
  tool: `tool-${id}`,
  summary: `summary-${id}`,
  state: 'pending',
  nonce: `nonce-${id}`,
  actionDigest: `digest-${id}`,
});

let state: AppState;
let container: HTMLDivElement;
let root: Root | undefined;
const agents = {
  cancel: vi.fn<(conversationId?: string) => Promise<void>>(async () => {}),
  attach: vi.fn<(conversationId?: string) => Promise<void>>(async () => {}),
  detach: vi.fn<(conversationId?: string) => Promise<void>>(async () => {}),
  takeOver: vi.fn<(conversationId?: string) => Promise<void>>(async () => {}),
  task: vi.fn<
    (text: string, attachments?: PromptAttachment[], conversationId?: string) => Promise<void>
  >(async () => {}),
  resume: vi.fn<(text?: string, conversationId?: string) => Promise<void>>(async () => {}),
};
const getState = vi.fn(async () => state);
let composer: ComposerStore;
/** 已在 store 里放过初始草稿的对话：同一对话重渲染不再覆盖用户之后的输入。 */
let seeded: Set<string>;
const run = async (action: () => Promise<unknown>) => {
  await action();
  return true;
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockImplementation(async () => state);
  agents.cancel.mockImplementation(async () => {});
  observed.composer = undefined;
  composer = new ComposerStore();
  seeded = new Set();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { getState, agents },
  });
  state = {
    tabs: [],
    agents: [
      { id: 'agent-A', name: 'Agent A', command: 'node', args: [], enabled: true },
      { id: 'agent-B', name: 'Agent B', command: 'node', args: [], enabled: true },
    ],
    connectedAgentId: 'agent-A',
    agentStatus: 'running',
    attachmentStatus: 'attached',
    agentImageCapable: true,
    approvals: [],
    pendingApprovalsByConversation: {},
    conversationAgents: {},
    events: [],
    activeConversationId: 'A',
    conversations: ['A', 'B'].map((id) => ({
      id,
      title: `Conversation ${id}`,
      messages: [],
      updatedAt: '',
    })),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

async function render(draft = 'draft A', options: { run?: typeof run } = {}) {
  const id = state.activeConversationId ?? 'preview';
  if (!seeded.has(id)) {
    seeded.add(id);
    composer.update(id, (entry) => ({ ...entry, draft }));
  }
  await act(async () => {
    root!.render(
      createElement(ConversationPanel, {
        state,
        run: options.run ?? run,
        composer,
        settings() {},
        close() {},
      }),
    );
  });
}
async function addImage(name: string) {
  await act(async () => observed.composer!.setAttachments([image(name)]));
}
function interrupt() {
  return observed.composer!.onInterruptAndSend();
}
async function switchToB() {
  state = {
    ...state,
    activeConversationId: 'B',
    connectedAgentId: 'agent-B',
    agentStatus: 'ready',
  };
  await render('draft B');
  await addImage('B.png');
}

it('shows only B approvals in the actionable dock, activity list and count', async () => {
  state = {
    ...state,
    activeConversationId: 'B',
    connectedAgentId: 'agent-B',
    agentStatus: 'ready',
    approvals: [approval('A', 'A'), approval('unscoped'), approval('B1', 'B'), approval('B2', 'B')],
  };
  await render('draft B');
  expect(container.querySelector('.approval-dock')?.textContent).toContain('tool-B1');
  expect(container.querySelector('.approval-dock')?.textContent).not.toContain('tool-A');
  expect(container.querySelector('.appr-count')?.textContent).toContain('2');
  expect(container.querySelector('.seg-badge')?.textContent).toBe('2');
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.seg button:nth-child(2)')!.click();
  });
  expect(
    [...container.querySelectorAll('.approval-row p')].map((item) => item.textContent),
  ).toEqual(['summary-B1', 'summary-B2']);
});

it('does not assign unscoped approvals to a preview without a conversation', async () => {
  state = { ...state, activeConversationId: undefined, approvals: [approval('unscoped')] };
  await render('');
  expect(container.querySelector('.approval-dock')).toBeNull();
  expect(container.querySelector('.seg-badge')).toBeNull();
});

it('shows external approvals with their own visible source before B identity without counting them as B', async () => {
  state = {
    ...state,
    activeConversationId: 'B',
    connectedAgentId: 'agent-B',
    agentStatus: 'ready',
    approvals: [
      approval('unscoped'),
      { ...approval('external'), externalClientName: 'External X' },
      approval('B1', 'B'),
    ],
  };
  await render('draft B');
  const external = container.querySelector('[aria-label="外部客户端操作审批"]');
  const header = container.querySelector('.chat-header');
  expect(external?.textContent).toContain('外部客户端：External X');
  expect(external?.textContent).not.toContain('tool-unscoped');
  expect(external!.compareDocumentPosition(header!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(container.querySelector('[aria-label="操作审批"]')?.textContent).toContain('tool-B1');
  expect(container.querySelector('.seg-badge')?.textContent).toBe('1');
});

it('offers task and persistent permission only when the host advertises external scopes', async () => {
  state = {
    ...state,
    activeConversationId: 'B',
    approvals: [
      { ...approval('external'), externalClientName: 'CLI', allowedScopes: ['space', 'client'] },
      approval('B1', 'B'),
    ],
  };
  await render();
  const external = container.querySelector('[aria-label="外部客户端操作审批"]');
  expect(external?.textContent).toContain('本任务允许');
  expect(external?.textContent).toContain('始终允许此客户端');
  const internal = container.querySelector('[aria-label="操作审批"]');
  expect(internal?.textContent).not.toContain('本任务允许');
  expect(internal?.textContent).not.toContain('始终允许此客户端');
});

it('aborts A interrupt after deferred cancellation when switched to B, preserving B draft and images', async () => {
  const cancellation = deferred<void>();
  agents.cancel.mockReturnValueOnce(cancellation.promise);
  await render();
  await addImage('A.png');
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = interrupt();
  });
  await switchToB();
  await act(async () => {
    cancellation.resolve();
    await pending;
  });
  expect(agents.task).not.toHaveBeenCalled();
  expect(agents.resume).not.toHaveBeenCalled();
  expect(agents.cancel).toHaveBeenCalledExactlyOnceWith('A');
  expect(observed.composer!.runtime.getState().text).toBe('draft B');
  expect(observed.composer!.attachments).toEqual([image('B.png')]);
  expect(composer.get('B')).toMatchObject({ draft: 'draft B', attachments: [image('B.png')] });
  // 打断被放弃：A 的输入原样留着，切回 A 还能接着发。
  expect(composer.get('A')).toMatchObject({ draft: 'draft A', attachments: [image('A.png')] });
});

it('aborts an interrupt after unmount even if the active conversation is still A', async () => {
  const cancellation = deferred<void>();
  agents.cancel.mockReturnValueOnce(cancellation.promise);
  await render();
  await addImage('A.png');
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = interrupt();
  });
  await act(async () => root!.unmount());
  root = undefined;
  state = { ...state, agentStatus: 'ready' };
  await act(async () => {
    cancellation.resolve();
    await pending;
  });
  expect(agents.task).not.toHaveBeenCalled();
  expect(agents.resume).not.toHaveBeenCalled();
});

it('aborts when switched to B during the idle-state await, keeping images in B', async () => {
  const idle = deferred<AppState>();
  getState.mockReturnValueOnce(idle.promise);
  await render();
  await addImage('A.png');
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = interrupt();
  });
  expect(getState).toHaveBeenCalled();
  await switchToB();
  await act(async () => {
    idle.resolve(state);
    await pending;
  });
  expect(agents.task).not.toHaveBeenCalled();
  expect(observed.composer!.runtime.getState().text).toBe('draft B');
  expect(observed.composer!.attachments).toEqual([image('B.png')]);
});

it('keeps A draft and images when IPC switches to B before the panel receives the new state', async () => {
  const idle = deferred<AppState>();
  getState.mockReturnValueOnce(idle.promise);
  await render();
  await addImage('A.png');
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = interrupt();
  });
  await act(async () => {
    idle.resolve({ ...state, activeConversationId: 'B', agentStatus: 'ready' });
    await pending;
  });
  expect(agents.task).not.toHaveBeenCalled();
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
});

it('does not flush the queue twice when cancellation also renders an idle state', async () => {
  const cancellation = deferred<void>();
  agents.cancel.mockReturnValueOnce(cancellation.promise);
  await render();
  await addImage('A.png');
  await act(async () => observed.composer!.onEnqueue('queued A', [image('queued-A.png')]));
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = interrupt();
  });
  state = { ...state, agentStatus: 'ready' };
  await render();
  expect(agents.task).not.toHaveBeenCalled();
  await act(async () => {
    cancellation.resolve();
    await pending;
  });
  expect(agents.task).toHaveBeenCalledExactlyOnceWith(
    'draft A\n\nqueued A',
    [image('A.png'), image('queued-A.png')],
    'A',
  );
});

it('merges the claimed queue exactly once and routes an unchanged interrupt to A', async () => {
  await render();
  await addImage('A.png');
  await act(async () => observed.composer!.onEnqueue('queued A', [image('queued-A.png')]));
  state = { ...state, agentStatus: 'ready' };
  await act(async () => interrupt());
  expect(agents.cancel).toHaveBeenCalledExactlyOnceWith('A');
  expect(agents.task).toHaveBeenCalledExactlyOnceWith(
    'draft A\n\nqueued A',
    [image('A.png'), image('queued-A.png')],
    'A',
  );
  expect(observed.composer!.runtime.getState().text).toBe('');
  expect(observed.composer!.attachments).toEqual([]);
});

it('routes attachment and task-control actions to the panel conversation', async () => {
  state = {
    ...state,
    agentStatus: 'ready',
    conversations: [
      {
        ...state.conversations![0],
        task: { id: 'tA', goal: 'goal A', agentId: 'agent-A', status: 'running', updatedAt: '' },
      },
      state.conversations![1],
    ],
  };
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="暂停浏览器权限"]')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.task-controls button')!.click(),
  );
  expect(agents.detach).toHaveBeenCalledExactlyOnceWith('A');
  expect(agents.takeOver).toHaveBeenCalledExactlyOnceWith('A');
  state = {
    ...state,
    attachmentStatus: 'detached',
    conversations: [
      {
        ...state.conversations![0],
        task: { ...state.conversations![0].task!, status: 'manual' },
      },
      state.conversations![1],
    ],
  };
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="共享浏览器"]')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.task-controls button')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.task-controls button:nth-child(2)')!.click(),
  );
  expect(agents.attach).toHaveBeenCalledExactlyOnceWith('A');
  expect(agents.resume).toHaveBeenCalledExactlyOnceWith('', 'A');
  expect(agents.cancel).toHaveBeenCalledExactlyOnceWith('A');
});

it('ignores a delayed task-control callback after its panel unmounts', async () => {
  let action: (() => Promise<unknown>) | undefined;
  state = {
    ...state,
    agentStatus: 'ready',
    conversations: [
      {
        ...state.conversations![0],
        task: { id: 'tA', goal: 'goal A', agentId: 'agent-A', status: 'running', updatedAt: '' },
      },
    ],
  };
  await act(async () => {
    root!.render(
      createElement(ConversationPanel, {
        state,
        run: async (next) => {
          action = next;
          return true;
        },
        composer,
        settings() {},
        close() {},
      }),
    );
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.task-controls button')!.click(),
  );
  expect(action).toBeDefined();
  await act(async () => root!.unmount());
  root = undefined;
  await action!();
  expect(agents.takeOver).not.toHaveBeenCalled();
});

/** 记下交给全局横幅（run）的错误，用来断言「没发出去」只在输入框上方说一次。 */
function reportingRun(reported: unknown[]) {
  return async (action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (cause) {
      reported.push(cause);
      return false;
    }
  };
}
const queuedTexts = () =>
  [...container.querySelectorAll('.queued-message .queued-text')].map((item) => item.textContent);
const queueLabel = () => container.querySelector('.queued-label')?.textContent ?? '';
const composerNotices = () =>
  [...container.querySelectorAll('.composer-notice span')].map((item) => item.textContent);
async function clickSend() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click(),
  );
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

it('keeps the queue through Stop and sends it only once the Agent is ready again', async () => {
  await render();
  await act(async () => observed.composer!.onEnqueue('queued A', []));
  state = { ...state, agentStatus: 'stopping' };
  await render();
  await settle();
  expect(agents.task).not.toHaveBeenCalled();
  expect(queuedTexts()).toEqual(['queued A']);
  state = { ...state, agentStatus: 'ready' };
  await render();
  await settle();
  expect(agents.task).toHaveBeenCalledExactlyOnceWith('queued A', undefined, 'A');
  expect(composer.get('A').queue).toEqual([]);
  expect(composer.get('A').draft).toBe('draft A');
});

it('holds the queue during takeover instead of resuming the task for the person', async () => {
  const task = { id: 'tA', goal: 'goal A', agentId: 'agent-A', updatedAt: '' };
  state = {
    ...state,
    conversations: [
      { ...state.conversations![0], task: { ...task, status: 'running' } },
      state.conversations![1],
    ],
  };
  await render();
  await act(async () => observed.composer!.onEnqueue('queued A', []));
  state = {
    ...state,
    agentStatus: 'ready',
    attachmentStatus: 'detached',
    conversations: [
      { ...state.conversations![0], task: { ...task, status: 'manual' } },
      state.conversations![1],
    ],
  };
  await render();
  await settle();
  expect(agents.resume).not.toHaveBeenCalled();
  expect(agents.task).not.toHaveBeenCalled();
  expect(queuedTexts()).toEqual(['queued A']);
  expect(queueLabel()).toContain('你已接管任务');
});

it('keeps the queue, draft and images of A across switching conversations and collapsing the panel', async () => {
  await render();
  await addImage('A.png');
  await act(async () => observed.composer!.onEnqueue('queued A', [image('queued-A.png')]));
  await switchToB();
  expect(queuedTexts()).toEqual([]);
  state = {
    ...state,
    activeConversationId: 'A',
    connectedAgentId: 'agent-A',
    agentStatus: 'running',
  };
  await render();
  expect(queuedTexts()).toEqual(['queued A · 1 张图']);
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  await act(async () => root!.unmount());
  root = createRoot(container);
  await render();
  expect(queuedTexts()).toEqual(['queued A · 1 张图']);
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(agents.task).not.toHaveBeenCalled();
});

it('asks for an Agent on Cmd+Enter without one and keeps the input', async () => {
  state = { ...state, connectedAgentId: undefined, agentStatus: 'not_configured' };
  await render();
  await addImage('A.png');
  await act(async () => interrupt());
  expect(agents.cancel).not.toHaveBeenCalled();
  expect(agents.task).not.toHaveBeenCalled();
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  expect(composerNotices()).toContain('还没有连接 Agent，先在下方选择一个');
});

it('ignores a second Cmd+Enter while the first interrupt is still settling', async () => {
  const cancellation = deferred<void>();
  agents.cancel.mockReturnValueOnce(cancellation.promise);
  await render();
  let first!: Promise<unknown>;
  await act(async () => {
    first = interrupt();
  });
  await act(async () => interrupt());
  expect(agents.cancel).toHaveBeenCalledOnce();
  state = { ...state, agentStatus: 'ready' };
  await act(async () => {
    cancellation.resolve();
    await first;
  });
  expect(agents.task).toHaveBeenCalledExactlyOnceWith('draft A', undefined, 'A');
});

it('keeps the draft and images when main refuses the send, and says why once', async () => {
  const reported: unknown[] = [];
  state = { ...state, agentStatus: 'ready' };
  agents.task.mockRejectedValueOnce(
    new Error("Error invoking remote method 'agent:task': Error: 正在录制，请先停止录制再发送任务"),
  );
  await render('draft A', { run: reportingRun(reported) });
  await addImage('A.png');
  await clickSend();
  await settle();
  expect(agents.task).toHaveBeenCalledExactlyOnceWith('draft A', [image('A.png')], 'A');
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  expect(composerNotices()).toEqual(['正在录制，请先停止录制再发送任务']);
  expect(reported).toEqual([]);
});

it('clears the input when main records the message, not before', async () => {
  const listeners = new Set<(next: AppState) => void>();
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: {
      getState,
      agents,
      onState(listener: (next: AppState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const turn = deferred<void>();
  agents.task.mockReturnValueOnce(turn.promise);
  state = { ...state, agentStatus: 'ready' };
  await render();
  await addImage('A.png');
  await clickSend();
  await settle();
  expect(agents.task).toHaveBeenCalledOnce();
  expect(observed.composer!.runtime.getState().text).toBe('draft A');
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  const accepted: AppState = {
    ...state,
    agentStatus: 'running',
    conversations: [
      {
        ...state.conversations![0],
        messages: [{ id: 'u1', role: 'user', text: 'draft A', time: '', status: 'completed' }],
      },
      state.conversations![1],
    ],
  };
  await act(async () => {
    for (const listener of listeners) listener(accepted);
  });
  expect(observed.composer!.runtime.getState().text).toBe('');
  expect(observed.composer!.attachments).toEqual([]);
  await act(async () => {
    turn.resolve();
    await turn.promise;
  });
  expect(listeners.size).toBe(0);
});

it('keeps text typed after pressing send when the earlier text is accepted', async () => {
  const turn = deferred<void>();
  agents.task.mockReturnValueOnce(turn.promise);
  state = { ...state, agentStatus: 'ready' };
  await render();
  await clickSend();
  await act(async () => observed.composer!.runtime.setText('draft A, and more'));
  await act(async () => {
    turn.resolve();
    await turn.promise;
  });
  await settle();
  expect(agents.task).toHaveBeenCalledExactlyOnceWith('draft A', undefined, 'A');
  expect(composer.get('A').draft).toBe('draft A, and more');
});

it('does not send an image-only draft and asks for a line of text', async () => {
  state = { ...state, agentStatus: 'ready' };
  await render('');
  await addImage('A.png');
  await clickSend();
  await settle();
  expect(agents.task).not.toHaveBeenCalled();
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  expect(composerNotices()).toContain('请补一句文字说明再发送图片');
});

it('holds an image-only queue instead of sending a prompt without text', async () => {
  await render('');
  await act(async () => observed.composer!.onEnqueue('', [image('queued-A.png')]));
  state = { ...state, agentStatus: 'ready' };
  await render('');
  await settle();
  expect(agents.task).not.toHaveBeenCalled();
  expect(queueLabel()).toContain('队列里只有图片');
});

it('keeps a queue main refused visible and does not retry it on every render', async () => {
  const reported: unknown[] = [];
  agents.task.mockRejectedValue(new Error('请等待当前任务结束'));
  await render('draft A', { run: reportingRun(reported) });
  await act(async () => observed.composer!.onEnqueue('queued A', []));
  state = { ...state, agentStatus: 'ready' };
  await render('draft A', { run: reportingRun(reported) });
  await settle();
  await render('draft A', { run: reportingRun(reported) });
  await settle();
  expect(agents.task).toHaveBeenCalledExactlyOnceWith('queued A', undefined, 'A');
  expect(queuedTexts()).toEqual(['queued A']);
  expect(queueLabel()).toContain('队列未能自动发出：请等待当前任务结束');
  expect(reported).toEqual([]);
  agents.task.mockReset();
});

it('refuses to resume a takeover with images instead of dropping them', async () => {
  state = {
    ...state,
    agentStatus: 'ready',
    attachmentStatus: 'detached',
    conversations: [
      {
        ...state.conversations![0],
        task: { id: 'tA', goal: 'goal A', agentId: 'agent-A', status: 'manual', updatedAt: '' },
      },
      state.conversations![1],
    ],
  };
  await render('logged in');
  await addImage('A.png');
  await clickSend();
  await settle();
  expect(agents.resume).not.toHaveBeenCalled();
  expect(observed.composer!.attachments).toEqual([image('A.png')]);
  expect(observed.composer!.runtime.getState().text).toBe('logged in');
  expect(composerNotices()).toContain('继续任务时不能附带图片，请先移除图片再发送');
});
