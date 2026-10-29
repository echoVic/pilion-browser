// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState, ApprovalViewState, PromptAttachment } from '../src/shared/contracts';
import type { ComposerInput } from '../src/renderer/ComposerInput';
import { ConversationPanel } from '../src/renderer/ConversationPanel';

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
const setDraft = vi.fn();
const run = async (action: () => Promise<unknown>) => {
  await action();
  return true;
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockImplementation(async () => state);
  agents.cancel.mockImplementation(async () => {});
  observed.composer = undefined;
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

async function render(draft = 'draft A') {
  await act(async () => {
    root!.render(
      createElement(ConversationPanel, {
        state,
        run,
        draft,
        setDraft,
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
  const composer = observed.composer!;
  return Promise.resolve(
    composer.onInterruptAndSend(composer.runtime.getState().text, composer.attachments),
  );
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
  setDraft.mockClear();
  await act(async () => {
    cancellation.resolve();
    await pending;
  });
  expect(agents.task).not.toHaveBeenCalled();
  expect(agents.resume).not.toHaveBeenCalled();
  expect(agents.cancel).toHaveBeenCalledExactlyOnceWith('A');
  expect(observed.composer!.runtime.getState().text).toBe('draft B');
  expect(observed.composer!.attachments).toEqual([image('B.png')]);
  expect(setDraft).not.toHaveBeenCalled();
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
    container.querySelector<HTMLButtonElement>('[aria-label="Detach"]')!.click(),
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
    container.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.click(),
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
        draft: 'draft A',
        setDraft,
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
