// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SpaceSwitcher } from '../src/renderer/SpaceSwitcher';
import type { AppState } from '../src/shared/contracts';
import type { BrowserSpace } from '../src/shared/tab-organization';

const humanSpace = (id: string, name: string): BrowserSpace => ({
  id,
  name,
  color: 'neutral',
});
const agentSpace: BrowserSpace = {
  id: 'agent-1',
  name: '比价',
  color: 'teal',
  agent: {
    clientId: 'c1',
    label: '比价',
    createdAt: 1,
    state: 'ended',
    endedAt: 2,
    endReason: 'closed',
  },
};

const remove = vi.fn(async () => {});
const select = vi.fn(async () => {});
const run = async (action: () => Promise<unknown>) => {
  await action();
  return true;
};

let container: HTMLDivElement;
let root: Root | undefined;

function makeState(spaces: BrowserSpace[], activeSpaceId: string): AppState {
  return {
    tabs: [],
    spaces,
    activeSpaceId,
    agents: [],
    agentStatus: 'disconnected',
    attachmentStatus: 'none',
    approvals: [],
    pendingApprovalsByConversation: {},
    conversationAgents: {},
    events: [],
  } as AppState;
}

async function render(
  spaces: BrowserSpace[],
  activeSpaceId = spaces[0].id,
  runOverride: (action: () => Promise<unknown>) => Promise<boolean> = run,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(SpaceSwitcher, {
        state: makeState(spaces, activeSpaceId),
        run: runOverride,
      }),
    );
  });
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function buttonByText(scope: Element | null, text: string): HTMLButtonElement | undefined {
  return [...(scope?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === text,
  );
}

const trigger = () => container.querySelector<HTMLButtonElement>('.space-trigger');
const popover = () => container.querySelector<HTMLElement>('.space-popover');
const rowRemove = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="删除空间：${name}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { spaces: { remove, select } },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

it('offers a row-level delete entry for every human space and leaves agent spaces to their group', async () => {
  await render([
    humanSpace('default', '我的工作区'),
    humanSpace('reading', '阅读'),
    agentSpace,
    humanSpace('writing', '写作'),
  ]);
  await click(trigger());

  const labels = [...container.querySelectorAll('.space-row-remove')].map((button) =>
    button.getAttribute('aria-label'),
  );
  expect(labels).toEqual(['删除空间：我的工作区', '删除空间：阅读', '删除空间：写作']);
  // 当前行常驻露出入口，其余行由 CSS 在悬停/聚焦时露出。
  expect(container.querySelector('.space-row.is-current .space-row-remove')).not.toBeNull();
  // Agent 空间在下方有自己的「删除」，行上不重复。
  const agentRow = [...container.querySelectorAll('.space-row')].find((row) =>
    row.textContent?.includes('比价'),
  );
  expect(agentRow?.querySelector('.space-row-remove')).toBeNull();
});

it('asks for inline confirmation and only then removes the space', async () => {
  await render([humanSpace('default', '我的工作区'), humanSpace('reading', '阅读')]);
  await click(trigger());
  await click(rowRemove('阅读'));

  const confirm = container.querySelector<HTMLElement>('.space-remove-confirm');
  expect(confirm?.textContent).toContain('删除「阅读」？');
  expect(confirm?.textContent).toContain('其中的标签会保留');
  expect(rowRemove('阅读')?.getAttribute('aria-expanded')).toBe('true');
  expect(remove).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();

  await click(buttonByText(confirm, '删除空间'));
  expect(remove).toHaveBeenCalledExactlyOnceWith('reading');
  expect(popover()).toBeNull();
  expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
  // 删除成功后收起菜单，焦点落在触发按钮上，键盘用户不会掉到 body。
  expect(document.activeElement).toBe(trigger());
});

it('cancels the confirmation, keeps the switcher open and returns focus to the row', async () => {
  await render([humanSpace('default', '我的工作区'), humanSpace('reading', '阅读')]);
  await click(trigger());
  const trash = rowRemove('阅读');
  await click(trash);

  await click(buttonByText(container.querySelector('.space-remove-confirm'), '取消'));
  expect(remove).not.toHaveBeenCalled();
  expect(container.querySelector('.space-remove-confirm')).toBeNull();
  expect(popover()).not.toBeNull();
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
  expect(document.activeElement).toBe(trash);
});

it('Escape dismisses the confirmation first and the switcher second', async () => {
  await render([humanSpace('default', '我的工作区'), humanSpace('reading', '阅读')]);
  await click(trigger());
  const trash = rowRemove('阅读');
  await click(trash);
  const cancel = buttonByText(container.querySelector('.space-remove-confirm'), '取消');
  await act(async () => cancel!.focus());
  expect(document.activeElement).toBe(cancel);

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(container.querySelector('.space-remove-confirm')).toBeNull();
  expect(popover()).not.toBeNull();
  // 焦点原本在确认条上，撤销后要回到行内垃圾桶，不能掉到 body。
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
  expect(document.activeElement).toBe(trash);

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(popover()).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('keeps the confirmation open while removal is in flight and when it fails', async () => {
  let finish!: (removed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  await render(
    [humanSpace('default', '我的工作区'), humanSpace('reading', '阅读')],
    'default',
    async () => pending,
  );
  await click(trigger());
  await click(rowRemove('阅读'));
  await click(buttonByText(container.querySelector('.space-remove-confirm'), '删除空间'));

  const deleting = buttonByText(container.querySelector('.space-remove-confirm'), '删除中…');
  expect(deleting?.disabled).toBe(true);
  expect(buttonByText(container.querySelector('.space-remove-confirm'), '取消')?.disabled).toBe(
    true,
  );

  await act(async () => {
    finish(false);
    await pending;
  });
  expect(container.querySelector('.space-remove-confirm')).not.toBeNull();
  expect(popover()).not.toBeNull();
});

it('never removes the last human space, even when agent spaces remain', async () => {
  await render([humanSpace('default', '我的工作区'), agentSpace]);
  await click(trigger());
  expect(container.querySelectorAll('.space-row-remove')).toHaveLength(0);
});
