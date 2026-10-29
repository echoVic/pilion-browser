import { describe, expect, it } from 'vitest';
import { commandOptions } from '../src/renderer/command-options';
import type { AppState } from '../src/shared/contracts';

const state: AppState = {
  tabs: [
    {
      id: 'work',
      title: 'Work',
      url: 'https://example.com/work',
      spaceId: 'work',
      kind: 'today',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
      crashed: false,
    },
    {
      id: 'reading',
      title: 'Reading',
      url: 'https://example.org',
      spaceId: 'reading',
      kind: 'pinned',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
      crashed: false,
    },
  ],
  activeSpaceId: 'work',
  agents: [],
  agentStatus: 'ready',
  attachmentStatus: 'none',
  approvals: [],
  events: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  bookmarks: [
    { url: 'https://example.com/work', title: 'Duplicate', time: '' },
    { url: 'https://example.com/saved', title: 'Saved', time: '' },
  ],
  history: [{ url: 'https://example.com/saved', title: 'Saved', time: '' }],
};
describe('command bar search', () => {
  it('switches existing tabs before offering navigation and deduplicates saved pages', () => {
    expect(commandOptions(state, 'example.com').map((option) => option.kind)).toEqual([
      'tab',
      'page',
      'search',
    ]);
    expect(commandOptions(state, 'reading')[0]).toMatchObject({ kind: 'tab', tabId: 'reading' });
  });
  it('filters browser commands and supports an explicit command prefix', () => {
    expect(commandOptions(state, '>归档')).toMatchObject([
      { kind: 'action', action: 'showArchive' },
    ]);
    expect(commandOptions(state, '查看书签')[0]).toMatchObject({
      kind: 'action',
      action: 'showBookmarks',
    });
    expect(commandOptions(state, '>unknown')).toEqual([]);
  });
});
