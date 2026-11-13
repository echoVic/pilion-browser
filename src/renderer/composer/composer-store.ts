import type { AgentStatus, PromptAttachment } from '../../shared/contracts.js';
import { enqueue, mergeQueue, recall, remove, type QueuedMessage } from './queue.js';

/**
 * 每条对话一份的输入框状态：草稿、附件与待发队列。放在 App 级的 ComposerStore 里，
 * 面板收起、切换对话（ConversationThread 按对话 key 重挂载）都不会丢；只随渲染进程一起消失。
 *
 * 发送遵循「主进程收下才清」：提交时这里什么都不动，等主进程把用户消息记进这条对话的历史，
 * 才用 retractSent 把真正发出去的那部分移掉。没被收下就原样留着，用户不用重打。
 */
export interface ComposerEntry {
  readonly draft: string;
  readonly attachments: readonly PromptAttachment[];
  readonly queue: readonly QueuedMessage[];
  /** 自动发出队列被主进程拒绝的原因。留着队列给用户看、不再自动重试，直到用户动了队列或下一条消息被收下。 */
  readonly queueBlocked?: string;
}

export const EMPTY_COMPOSER: ComposerEntry = Object.freeze({
  draft: '',
  attachments: Object.freeze([]) as readonly PromptAttachment[],
  queue: Object.freeze([]) as readonly QueuedMessage[],
});

/** 按对话 id 存放输入框状态的小型外部 store；update 只在内容对象变化时通知该对话的订阅者。 */
export class ComposerStore {
  private readonly entries = new Map<string, ComposerEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(id: string): ComposerEntry {
    return this.entries.get(id) ?? EMPTY_COMPOSER;
  }

  update(id: string, change: (entry: ComposerEntry) => ComposerEntry): void {
    const before = this.get(id);
    const after = change(before);
    if (after === before) return;
    this.entries.set(id, after);
    for (const listener of [...(this.listeners.get(id) ?? [])]) listener();
  }

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

/** 一次提交带走的内容。draft 只在这次提交包含输入框时给出；附件按引用、队列按 id 认领。 */
export interface SentPrompt {
  /** 实际交给主进程的文本。 */
  readonly text: string;
  /** 提交时输入框的原文。被收下后只有输入框没被改过才清空，用户新打的字不会被吞掉。 */
  readonly draft?: string;
  readonly attachments: readonly PromptAttachment[];
  readonly queueIds: readonly string[];
}

function withoutBlock(entry: ComposerEntry): ComposerEntry {
  if (entry.queueBlocked === undefined) return entry;
  return { draft: entry.draft, attachments: entry.attachments, queue: entry.queue };
}

/** 主进程收下后：把发出去的草稿、附件与队列条目移走；新回合已开始，之前卡住的队列等它结束再试一次。 */
export function retractSent(entry: ComposerEntry, sent: SentPrompt): ComposerEntry {
  const attachments = new Set(sent.attachments);
  const queueIds = new Set(sent.queueIds);
  return {
    draft: sent.draft !== undefined && entry.draft === sent.draft ? '' : entry.draft,
    attachments: entry.attachments.filter((item) => !attachments.has(item)),
    queue: entry.queue.filter((item) => !queueIds.has(item.id)),
  };
}

export function setDraft(entry: ComposerEntry, draft: string): ComposerEntry {
  return entry.draft === draft ? entry : { ...entry, draft };
}

export function setAttachments(
  entry: ComposerEntry,
  attachments: readonly PromptAttachment[],
): ComposerEntry {
  if (
    attachments.length === entry.attachments.length &&
    attachments.every((item, index) => item === entry.attachments[index])
  )
    return entry;
  return { ...entry, attachments: [...attachments] };
}

export function enqueueEntry(
  entry: ComposerEntry,
  text: string,
  attachments: readonly PromptAttachment[],
): ComposerEntry {
  if (!text.trim() && attachments.length === 0) return entry;
  return withoutBlock({ ...entry, queue: enqueue(entry.queue, text, attachments) });
}

/** 撤回回输入框：文本前置拼接，附件并到当前附件前面。 */
export function recallEntry(entry: ComposerEntry, id: string): ComposerEntry {
  const { queue, item } = recall(entry.queue, id);
  if (!item) return entry;
  return {
    draft: [item.text, entry.draft].filter(Boolean).join('\n'),
    attachments: [...item.attachments, ...entry.attachments],
    queue,
  };
}

export function removeQueued(entry: ComposerEntry, id: string): ComposerEntry {
  if (!entry.queue.some((item) => item.id === id)) return entry;
  return withoutBlock({ ...entry, queue: remove(entry.queue, id) });
}

export function blockQueue(entry: ComposerEntry, reason: string): ComposerEntry {
  if (entry.queue.length === 0 || entry.queueBlocked === reason) return entry;
  return { ...entry, queueBlocked: reason };
}

/**
 * 队列为什么停着、不会自动发出；undefined 表示它只是在等 Agent 空闲。
 * 接管中不自动发：那会替用户把任务继续下去、结束接管。只有图片的队列主进程收不下（任务必须有文字）。
 */
export function queueHold(
  entry: Pick<ComposerEntry, 'queue' | 'queueBlocked'>,
  manual: boolean,
): string | undefined {
  if (entry.queue.length === 0) return undefined;
  if (manual) return '你已接管任务，队列暂不发出：继续任务后会在回合结束时发出，也可撤回到输入框';
  if (entry.queueBlocked) return `队列未能自动发出：${entry.queueBlocked}`;
  if (!mergeQueue(entry.queue).text) return '队列里只有图片：撤回到输入框补一句文字说明再发送';
  return undefined;
}

export interface QueueGate {
  hasAgent: boolean;
  agentStatus: AgentStatus;
  /** 任务处于人工接管。 */
  manual: boolean;
  /** 面板正在打断、提交、切 Agent 或改配置。 */
  settling: boolean;
  /** 正在录制或回放：主进程这时不收任务，等结束再发。 */
  paused: boolean;
}

/** 自动发出队列的唯一条件：有待发内容、Agent 空闲就绪、面板没有别的操作在途、队列没被挡住。 */
export function canAutoFlush(
  entry: Pick<ComposerEntry, 'queue' | 'queueBlocked'>,
  gate: QueueGate,
): boolean {
  return (
    entry.queue.length > 0 &&
    gate.hasAgent &&
    gate.agentStatus === 'ready' &&
    !gate.settling &&
    !gate.paused &&
    queueHold(entry, gate.manual) === undefined
  );
}
