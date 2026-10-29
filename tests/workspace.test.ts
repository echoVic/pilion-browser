import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/main/workspace';
import { addressToUrl } from '../src/renderer/ui';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('workspace persistence', () => {
  it('restores a long canonical URL without rejecting the rest of the workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-workspace-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    const store = new WorkspaceStore(path);
    const url = new URL(`https://example.com/search?q=${'中'.repeat(1000)}`).href;
    store.create('conversation');
    Object.assign(store.data, {
      tabState: {
        spaces: [{ id: 'default', name: '我的工作区', color: 'neutral' }],
        activeSpaceId: 'default',
        tabs: [{ title: 'Search', url, spaceId: 'default', kind: 'today', lastActiveAt: 10 }],
        archivedTabs: [],
      },
    });
    await store.save();
    const restored = new WorkspaceStore(path);
    await expect(restored.load()).resolves.toBeUndefined();
    expect(restored.data.tabState?.tabs[0].url).toBe(url);
    expect(restored.current?.id).toBe('conversation');
  });
  it('persists spaces, tab classifications and archived pages alongside legacy URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-workspace-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    const store = new WorkspaceStore(path);
    Object.assign(store.data, {
      tabState: {
        spaces: [{ id: 'research', name: '研究', color: 'blue' }],
        activeSpaceId: 'research',
        tabs: [
          {
            title: 'Example',
            url: 'https://example.com',
            spaceId: 'research',
            kind: 'pinned',
            lastActiveAt: 10,
          },
        ],
        archivedTabs: [
          {
            id: 'archived',
            title: 'Old',
            url: 'https://example.org',
            spaceId: 'research',
            kind: 'today',
            lastActiveAt: 1,
            archivedAt: 20,
          },
        ],
      },
    });
    await store.save();
    const restored = new WorkspaceStore(path);
    await restored.load();
    expect(restored.data).toHaveProperty('tabState', {
      spaces: [{ id: 'research', name: '研究', color: 'blue' }],
      activeSpaceId: 'research',
      tabs: [
        {
          title: 'Example',
          url: 'https://example.com',
          spaceId: 'research',
          kind: 'pinned',
          lastActiveAt: 10,
        },
      ],
      archivedTabs: [
        {
          id: 'archived',
          title: 'Old',
          url: 'https://example.org',
          spaceId: 'research',
          kind: 'today',
          lastActiveAt: 1,
          archivedAt: 20,
        },
      ],
    });
  });

  it('restores conversations, bookmarks and tabs, and marks interrupted messages cancelled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-workspace-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    const store = new WorkspaceStore(path);
    await store.load();
    expect(store.data.permissionMode).toBe('full');
    store.data.permissionMode = 'ask';
    store.create('c1', 'agent1');
    store.current!.acpSessionId = 'acp-session-1';
    store.current!.task = {
      id: 'task1',
      agentId: 'agent1',
      goal: 'Research this page',
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    store.append({
      id: 'm1',
      role: 'user',
      text: 'Research this page',
      time: new Date().toISOString(),
    });
    store.append({
      id: 'm2',
      role: 'assistant',
      text: 'partial',
      time: new Date().toISOString(),
      status: 'running',
    });
    store.data.tabs = ['https://example.com/'];
    store.data.bookmarks = [
      { url: 'https://example.com/', title: 'Example', time: new Date().toISOString() },
    ];
    store.addDownload({
      id: 'download-1',
      filename: 'example.html',
      url: 'https://example.com/',
      savePath: join(directory, 'example.html'),
      receivedBytes: 12,
      totalBytes: 24,
      status: 'progressing',
      startedAt: new Date().toISOString(),
    });
    await store.save();
    const restored = new WorkspaceStore(path);
    await restored.load();
    expect(restored.data.permissionMode).toBe('ask');
    expect(restored.current?.title).toBe('Research this page');
    expect(restored.current?.acpSessionId).toBe('acp-session-1');
    expect(restored.current?.task).toMatchObject({
      id: 'task1',
      goal: 'Research this page',
      status: 'manual',
    });
    restored.current!.task!.status = 'stopped';
    await restored.save();
    const stopped = new WorkspaceStore(path);
    await stopped.load();
    expect(stopped.current?.task?.status).toBe('stopped');
    expect(restored.current?.messages[1]).toMatchObject({ text: 'partial', status: 'cancelled' });
    expect(restored.data.tabs).toEqual(store.data.tabs);
    expect(restored.data.bookmarks).toEqual(store.data.bookmarks);
    expect(restored.data.downloads).toMatchObject([{ id: 'download-1', status: 'interrupted' }]);
  });
  it('serializes writes so older snapshots cannot replace newer state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-workspace-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    const store = new WorkspaceStore(path);
    store.create('c1');
    const first = store.save();
    store.create('c2');
    const second = store.save();
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(path, 'utf8')).activeConversationId).toBe('c2');
  });
  it('deduplicates visits and excludes internal pages', () => {
    const store = new WorkspaceStore('/unused');
    for (const title of ['old', 'new'])
      store.visit({ title, url: 'https://example.com', time: 'now' });
    store.visit({ title: 'Blank', url: 'about:blank', time: 'now' });
    expect(store.data.history).toEqual([{ title: 'new', url: 'https://example.com', time: 'now' }]);
  });
  it('distinguishes addresses from search text and retains explicit protocols for policy validation', () => {
    expect(addressToUrl('example.com/path')).toBe('https://example.com/path');
    expect(addressToUrl('research a topic')).toBe(
      'https://www.google.com/search?q=research%20a%20topic',
    );
    expect(addressToUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});

describe('权限模式迁移到会话级', () => {
  it('旧工作区里没有 permissionMode 的对话，缺省继承全局模式', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-ws-migrate-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(
        path,
        JSON.stringify({
          permissionMode: 'ask',
          conversations: [
            {
              id: 'c-old',
              title: '旧对话',
              updatedAt: new Date().toISOString(),
              messages: [],
            },
            {
              id: 'c-full',
              title: '全访问对话',
              updatedAt: new Date().toISOString(),
              messages: [],
              permissionMode: 'full',
            },
          ],
          tabs: [],
          activeTabIndex: 0,
          bookmarks: [],
          history: [],
          downloads: [],
        }),
      ),
    );
    const store = new WorkspaceStore(path);
    await store.load();
    const old = store.data.conversations.find((c) => c.id === 'c-old');
    const full = store.data.conversations.find((c) => c.id === 'c-full');
    expect(old?.permissionMode).toBeUndefined();
    expect(full?.permissionMode).toBe('full');
    // 缺省回退全局（旧的 ask）；显式的会话级优先。
    expect(old?.permissionMode ?? store.data.permissionMode).toBe('ask');
    expect(full?.permissionMode ?? store.data.permissionMode).toBe('full');
  });
});
