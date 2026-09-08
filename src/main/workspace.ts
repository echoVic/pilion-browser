import { readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { PermissionModeSchema } from '../shared/contracts.js';
import type {
  Conversation,
  ConversationMessage,
  DownloadRecord,
  SavedPage,
} from '../shared/contracts.js';

const message = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'thought', 'tool', 'system']),
  text: z.string(),
  time: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']).optional(),
});
const savedPage = z.object({
  url: z.string(),
  title: z.string(),
  time: z.string(),
});
const download = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string(),
  savePath: z.string(),
  receivedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  status: z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted']),
  startedAt: z.string(),
});
const schema = z.object({
  permissionMode: PermissionModeSchema.default('full'),
  conversations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      agentId: z.string().optional(),
      updatedAt: z.string(),
      messages: z.array(message),
    }),
  ),
  activeConversationId: z.string().optional(),
  bookmarks: z.array(savedPage),
  history: z.array(savedPage),
  downloads: z.array(download).default([]),
  tabs: z.array(z.string()),
  activeTabIndex: z.number().int().nonnegative(),
});
export type WorkspaceData = z.infer<typeof schema>;

export class WorkspaceStore {
  data: WorkspaceData = {
    permissionMode: 'full',
    conversations: [],
    bookmarks: [],
    history: [],
    downloads: [],
    tabs: [],
    activeTabIndex: 0,
  };
  #pending: Promise<void> = Promise.resolve();
  #loadFailed = false;
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    try {
      this.data = schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      for (const conversation of this.data.conversations) {
        for (const item of conversation.messages)
          if (item.status === 'running') item.status = 'cancelled';
      }
      for (const item of this.data.downloads)
        if (item.status === 'progressing' || item.status === 'paused') item.status = 'interrupted';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#loadFailed = true;
        throw error;
      }
    }
  }
  save(): Promise<void> {
    if (this.#loadFailed)
      return Promise.reject(new Error('已有工作区读取失败，停止写入以保留原文件'));
    const body = JSON.stringify(this.data);
    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        await writeFile(`${this.path}.tmp`, body, { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      });
    return this.#pending;
  }
  get current(): Conversation | undefined {
    return this.data.conversations.find((item) => item.id === this.data.activeConversationId);
  }
  create(id: string, agentId?: string): Conversation {
    const conversation: Conversation = {
      id,
      title: '新对话',
      agentId,
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.data.conversations.unshift(conversation);
    this.data.activeConversationId = id;
    return conversation;
  }
  append(item: ConversationMessage): void {
    if (!this.current) throw new Error('No active conversation');
    this.current.messages.push(item);
    this.current.updatedAt = item.time;
    if (item.role === 'user' && this.current.title === '新对话')
      this.current.title = item.text.slice(0, 36);
  }
  visit(page: SavedPage): void {
    if (!/^https?:\/\//.test(page.url)) return;
    this.data.history = [page, ...this.data.history.filter((item) => item.url !== page.url)].slice(
      0,
      200,
    );
  }
  addDownload(item: DownloadRecord): void {
    this.data.downloads = [
      item,
      ...this.data.downloads.filter((existing) => existing.id !== item.id),
    ].slice(0, 100);
  }
}
