import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/contracts';
import { CommandBar } from '../src/renderer/CommandBar';
import { commandOptions } from '../src/renderer/command-options';

vi.mock('../src/renderer/command-options', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/command-options')>();
  return { ...actual, commandOptions: vi.fn(actual.commandOptions) };
});

const state = {
  tabs: [],
  agents: [],
  agentStatus: 'ready',
  attachmentStatus: 'none',
  approvals: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  events: [],
} as unknown as AppState;
const render = (open: boolean) =>
  renderToStaticMarkup(createElement(CommandBar, { state, open, onOpenChange() {}, choose() {} }));

it('does not filter tabs, bookmarks and history while the command bar is closed', () => {
  render(false);
  render(false);
  expect(commandOptions).not.toHaveBeenCalled();
  render(true);
  expect(commandOptions).toHaveBeenCalledWith(state, '');
});
