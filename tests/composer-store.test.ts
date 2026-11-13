import { describe, expect, it, vi } from 'vitest';
import type { PromptAttachment } from '../src/shared/contracts';
import {
  blockQueue,
  canAutoFlush,
  ComposerStore,
  EMPTY_COMPOSER,
  enqueueEntry,
  queueHold,
  recallEntry,
  removeQueued,
  retractSent,
  type ComposerEntry,
  type QueueGate,
} from '../src/renderer/composer/composer-store';
import { composerLocked, composerPhase, IDLE_PHASE } from '../src/renderer/composer/phase';

const image = (name: string): PromptAttachment => ({
  name,
  mimeType: 'image/png',
  data: 'aGVsbG8=',
});
const ready: QueueGate = {
  hasAgent: true,
  agentStatus: 'ready',
  manual: false,
  settling: false,
  paused: false,
};
function withQueue(...texts: string[]): ComposerEntry {
  return texts.reduce((entry, text) => enqueueEntry(entry, text, []), EMPTY_COMPOSER);
}

describe('ComposerStore', () => {
  it('keeps one entry per conversation and notifies only that conversation on a real change', () => {
    const store = new ComposerStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe('A', a);
    const offB = store.subscribe('B', b);
    store.update('A', (entry) => ({ ...entry, draft: 'hello' }));
    store.update('A', (entry) => entry);
    expect(store.get('A').draft).toBe('hello');
    expect(store.get('B')).toBe(EMPTY_COMPOSER);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    offB();
    store.update('B', (entry) => ({ ...entry, draft: 'b' }));
    expect(b).not.toHaveBeenCalled();
  });
});

describe('retractSent', () => {
  it('removes only what was sent and keeps text typed after pressing send', () => {
    const sentImage = image('sent.png');
    const laterImage = image('later.png');
    const queued = enqueueEntry(withQueue('first'), 'second', []);
    const entry: ComposerEntry = {
      ...queued,
      draft: 'typed later',
      attachments: [sentImage, laterImage],
      queueBlocked: 'old reason',
    };
    const next = retractSent(entry, {
      text: 'sent\n\nfirst',
      draft: 'sent',
      attachments: [sentImage],
      queueIds: [queued.queue[0].id],
    });
    expect(next.draft).toBe('typed later');
    expect(next.attachments).toEqual([laterImage]);
    expect(next.queue.map((item) => item.text)).toEqual(['second']);
    expect(next.queueBlocked).toBeUndefined();
  });

  it('clears the draft when it is unchanged and leaves it when only the queue was sent', () => {
    const entry: ComposerEntry = { ...withQueue('q'), draft: 'hello' };
    expect(
      retractSent(entry, { text: 'hello', draft: 'hello', attachments: [], queueIds: [] }).draft,
    ).toBe('');
    expect(
      retractSent(entry, { text: 'q', attachments: [], queueIds: [entry.queue[0].id] }).draft,
    ).toBe('hello');
  });
});

describe('queue edits', () => {
  it('recalls an item into the draft and the attachments, ahead of what is there', () => {
    const entry: ComposerEntry = {
      ...enqueueEntry(EMPTY_COMPOSER, 'queued', [image('q.png')]),
      draft: 'current',
      attachments: [image('c.png')],
    };
    const next = recallEntry(blockQueue(entry, 'refused'), entry.queue[0].id);
    expect(next.draft).toBe('queued\ncurrent');
    expect(next.attachments).toEqual([image('q.png'), image('c.png')]);
    expect(next.queue).toEqual([]);
    expect(next.queueBlocked).toBeUndefined();
  });

  it('lets the person unblock a refused queue by changing it', () => {
    const blocked = blockQueue(withQueue('a', 'b'), 'refused');
    expect(blocked.queueBlocked).toBe('refused');
    expect(enqueueEntry(blocked, 'c', []).queueBlocked).toBeUndefined();
    expect(removeQueued(blocked, blocked.queue[0].id).queueBlocked).toBeUndefined();
    expect(blockQueue(EMPTY_COMPOSER, 'nothing to block')).toBe(EMPTY_COMPOSER);
  });
});

describe('canAutoFlush', () => {
  it('flushes a non-empty queue only while the Agent is idle and ready', () => {
    const entry = withQueue('hello');
    expect(canAutoFlush(entry, ready)).toBe(true);
    expect(canAutoFlush(EMPTY_COMPOSER, ready)).toBe(false);
    for (const agentStatus of ['running', 'stopping', 'starting', 'error', 'disconnected'] as const)
      expect(canAutoFlush(entry, { ...ready, agentStatus })).toBe(false);
    expect(canAutoFlush(entry, { ...ready, hasAgent: false })).toBe(false);
    expect(canAutoFlush(entry, { ...ready, settling: true })).toBe(false);
    expect(canAutoFlush(entry, { ...ready, paused: true })).toBe(false);
  });

  it('holds the queue during takeover, after a refusal and when it has no text', () => {
    const entry = withQueue('hello');
    expect(canAutoFlush(entry, { ...ready, manual: true })).toBe(false);
    expect(queueHold(entry, true)).toContain('你已接管任务');
    const blocked = blockQueue(entry, '请等待当前任务结束');
    expect(canAutoFlush(blocked, ready)).toBe(false);
    expect(queueHold(blocked, false)).toBe('队列未能自动发出：请等待当前任务结束');
    const imageOnly = enqueueEntry(EMPTY_COMPOSER, '', [image('a.png')]);
    expect(canAutoFlush(imageOnly, ready)).toBe(false);
    expect(queueHold(imageOnly, false)).toContain('队列里只有图片');
    expect(queueHold(entry, false)).toBeUndefined();
  });
});

describe('composerPhase', () => {
  it('moves through submit, acceptance and settlement for one token', () => {
    let phase = composerPhase(IDLE_PHASE, { type: 'submit', token: 1 });
    expect(composerLocked(phase)).toBe(true);
    phase = composerPhase(phase, { type: 'accepted', token: 1 });
    expect(phase).toEqual({ kind: 'awaiting-turn', token: 1 });
    expect(composerLocked(phase)).toBe(false);
    expect(composerPhase(phase, { type: 'settled', token: 1 })).toBe(IDLE_PHASE);
  });

  it('does not let a late settlement of an earlier turn end a newer interrupt or submission', () => {
    const awaiting = composerPhase(composerPhase(IDLE_PHASE, { type: 'submit', token: 1 }), {
      type: 'accepted',
      token: 1,
    });
    const interrupting = composerPhase(awaiting, { type: 'interrupt' });
    expect(composerPhase(interrupting, { type: 'settled', token: 1 })).toBe(interrupting);
    const second = composerPhase(interrupting, { type: 'submit', token: 2 });
    expect(composerPhase(second, { type: 'settled', token: 1 })).toBe(second);
    expect(composerPhase(second, { type: 'accepted', token: 1 })).toBe(second);
    expect(composerPhase(second, { type: 'interrupt' })).toBe(second);
    expect(composerPhase(interrupting, { type: 'interrupt-aborted' })).toBe(IDLE_PHASE);
  });
});
