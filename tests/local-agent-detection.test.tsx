// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/contracts';
import type { LocalAgentEnvironment } from '../src/shared/local-agents';
import { LocalAgentSettings } from '../src/renderer/LocalAgentSettings';

const state: AppState = {
  tabs: [],
  agents: [],
  agentStatus: 'not_configured',
  attachmentStatus: 'none',
  approvals: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  events: [],
};
const environment = {
  nodePath: '/usr/local/bin/node',
  nodeVersion: 'v22.0.0',
  defaultCwd: '/Users/me',
  agents: [{ id: 'claude', status: 'ready', executablePath: '/bin/claude-acp' }],
} as unknown as LocalAgentEnvironment;
const inspectLocal = vi.fn<(nodePath?: string) => Promise<LocalAgentEnvironment>>();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  inspectLocal.mockReset();
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { agents: { inspectLocal } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const statusText = () => container.querySelector('.local-runtime-status strong')?.textContent;
async function mount() {
  await act(async () => {
    root.render(createElement(LocalAgentSettings, { state, run: async () => true }));
  });
}

it('says it is detecting during the first 250 ms instead of claiming ACP must be installed', async () => {
  inspectLocal.mockResolvedValue(environment);
  await mount();
  expect(inspectLocal).not.toHaveBeenCalled();
  expect(statusText()).toBe('正在检测本机环境');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(inspectLocal).toHaveBeenCalledOnce();
  expect(statusText()).toBe('已检测到 ACP 程序');
});

it('clears a detection error once a manual re-detect succeeds, and strips the IPC wrapper', async () => {
  inspectLocal.mockRejectedValueOnce(
    new Error("Error invoking remote method 'agent:inspect-local': Error: 找不到 Node.js"),
  );
  await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(container.querySelector('.form-error')?.textContent).toBe('找不到 Node.js');
  inspectLocal.mockResolvedValueOnce(environment);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="重新检测本机环境"]')!.click(),
  );
  expect(container.querySelector('.form-error')).toBeNull();
  expect(statusText()).toBe('已检测到 ACP 程序');
});
