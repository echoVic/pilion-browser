import { describe, expect, it, vi } from 'vitest';
import {
  enqueue,
  mergeQueue,
  recall,
  remove,
  waitUntilIdle,
  type QueuedMessage,
} from '../src/renderer/composer/queue.js';
import type { PromptAttachment } from '../src/shared/contracts.js';

function img(name: string): PromptAttachment {
  return { mimeType: 'image/png', data: 'aGVsbG8=', name };
}

describe('运行中排队', () => {
  it('enqueue 忽略空文本且无附件的条目', () => {
    expect(enqueue([], '   ', [])).toEqual([]);
    expect(enqueue([], '', [img('a.png')])).toHaveLength(1);
  });

  it('回合结束合并成一条：文本空行拼接、附件按序并起来', () => {
    const queue = [...enqueue([], '第一条', []), ...enqueue([], '第二条', [img('b.png')])];
    const merged = mergeQueue(queue);
    expect(merged.text).toBe('第一条\n\n第二条');
    expect(merged.attachments.map((a) => a.name)).toEqual(['b.png']);
  });

  it('recall 把消息退回输入框并从队列移除', () => {
    const [one] = enqueue([], '想撤回', [img('r.png')]);
    const { queue, item } = recall([one], one!.id);
    expect(queue).toEqual([]);
    expect(item?.text).toBe('想撤回');
    expect(item?.attachments).toEqual([img('r.png')]);
  });

  it('remove 直接丢弃，不退回输入框', () => {
    const [one] = enqueue([], '丢掉', []);
    expect(remove([one!], one!.id)).toEqual([]);
  });

  it('recall 不存在的 id 不改队列', () => {
    const queue: QueuedMessage[] = [];
    expect(recall(queue, 'nope')).toEqual({ queue: [] });
  });
});

describe('⌘/Ctrl+Enter 打断后发送的等待状态机', () => {
  it('已经空闲就立即返回，不轮询', async () => {
    const getState = vi.fn(async () => ({ agentStatus: 'ready' }));
    await waitUntilIdle(getState);
    expect(getState).toHaveBeenCalledOnce();
  });

  it('从 running/stopping 轮询到 ready 才返回', async () => {
    const statuses = ['running', 'running', 'ready'];
    const getState = vi.fn(async () => ({ agentStatus: statuses.shift() ?? 'ready' }));
    await waitUntilIdle(getState, { intervalMs: 1 });
    expect(getState).toHaveBeenCalledTimes(3);
  });

  it('超时也返回，避免 Agent 不收尾时永久卡住', async () => {
    const getState = vi.fn(async () => ({ agentStatus: 'running' }));
    const start = Date.now();
    await waitUntilIdle(getState, { timeoutMs: 20, intervalMs: 5 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(getState.mock.calls.length).toBeGreaterThan(1);
  });
});
