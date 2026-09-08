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
  it('restores conversations, bookmarks and tabs, and marks interrupted messages cancelled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pilion-workspace-'));
    directories.push(directory);
    const path = join(directory, 'workspace.json');
    const store = new WorkspaceStore(path);
    await store.load();
    expect(store.data.permissionMode).toBe('full');
    store.data.permissionMode = 'ask';
    store.create('c1', 'agent1');
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
