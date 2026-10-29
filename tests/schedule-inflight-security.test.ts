import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulerEngine } from '../src/main/schedule/engine.js';
import { SchedulesStore } from '../src/main/schedule/store.js';
import type {
  ScheduledPromptOutcome,
  ScheduledPromptRunInput,
} from '../src/main/schedule/runner.js';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const body = files.get(path);
    if (body === undefined) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
    return body;
  },
  writeFile: async (path: string, body: string) => {
    files.set(path, body);
  },
  rename: async (from: string, to: string) => {
    const body = files.get(from);
    if (body === undefined) throw new Error('Missing temporary fixture');
    files.set(to, body);
    files.delete(from);
  },
}));

afterEach(() => files.clear());

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Deferred not initialized');
      resolve(value);
    },
  };
}

function setup() {
  const now = new Date('2026-10-29T08:00:00Z');
  const store = new SchedulesStore('/synthetic/schedule-inflight.json');
  const create = (name: string) =>
    store.create(
      {
        name,
        agentId: 'synthetic-agent',
        prompt: `Synthetic task ${name}`,
        rule: { kind: 'interval', every: 10, unit: 'minute' },
        enabled: true,
        permissionMode: 'ask',
      },
      { kind: 'user' },
      now,
    );
  const first = create('A');
  const queued = create('B');
  first.nextRunAt = '2026-10-29T07:59:00Z';
  queued.nextRunAt = now.toISOString();
  const firstDone = deferred<ScheduledPromptOutcome>();
  const calls: ScheduledPromptRunInput[] = [];
  const engine = new SchedulerEngine({
    store,
    now: () => now,
    runner: {
      isRunning: () => false,
      run: async (input) => {
        calls.push(input);
        return input.scheduleId === first.id
          ? firstDone.promise
          : { status: 'ok', conversationId: 'synthetic-B' };
      },
    },
    recordEvent() {},
    notify() {},
  });
  return { now, store, first, queued, firstDone, calls, engine };
}

describe('SchedulerEngine in-flight task changes', () => {
  it('does not rerun a queued task completed by an overlapping resume tick', async () => {
    const { store, first, queued, firstDone, calls, engine } = setup();
    const tick = engine.tick('tick');
    try {
      await engine.tick('resume');
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      expect(calls.map((call) => call.scheduleId)).toEqual([first.id, queued.id]);
    } finally {
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      await store.idle();
    }
  });

  it.each(['delete', 'disable'] as const)(
    'does not start a queued task after %s while the earlier task is running',
    async (action) => {
      const { store, first, queued, firstDone, calls, engine } = setup();
      const tick = engine.tick('tick');
      try {
        if (action === 'delete') store.remove(queued.id);
        else store.setEnabled(queued.id, false);
        firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
        await tick;
        expect(calls.map((call) => call.scheduleId)).toEqual([first.id]);
        if (action === 'delete') expect(store.get(queued.id)).toBeUndefined();
        else expect(store.get(queued.id)?.enabled).toBe(false);
      } finally {
        firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
        await tick;
        await store.idle();
      }
    },
  );

  it('uses the updated nextRunAt when a queued task finishes through another runner', async () => {
    const { now, store, first, queued, firstDone, calls, engine } = setup();
    const tick = engine.tick('tick');
    try {
      store.recordRun(queued.id, { status: 'ok', at: now.toISOString() }, now);
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      expect(calls.map((call) => call.scheduleId)).toEqual([first.id]);
      expect(store.get(queued.id)?.nextRunAt).toBe('2026-10-29T08:10:00.000Z');
    } finally {
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      await store.idle();
    }
  });

  it('lets an already started task finish without recreating its deleted schedule', async () => {
    const { store, first, queued, firstDone, calls, engine } = setup();
    store.remove(queued.id);
    const tick = engine.tick('tick');
    try {
      expect(engine.isRunning(first.id)).toBe(true);
      store.remove(first.id);
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      expect(calls.map((call) => call.scheduleId)).toEqual([first.id]);
      expect(store.items).toEqual([]);
      expect(engine.isRunning(first.id)).toBe(false);
    } finally {
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      await store.idle();
    }
  });

  it('preserves a disable applied to an already started task when it records the result', async () => {
    const { store, first, queued, firstDone, engine } = setup();
    store.remove(queued.id);
    const tick = engine.tick('tick');
    try {
      store.setEnabled(first.id, false);
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      expect(store.get(first.id)?.enabled).toBe(false);
      expect(store.get(first.id)?.lastOutcome?.status).toBe('ok');
      expect(engine.isRunning(first.id)).toBe(false);
    } finally {
      firstDone.resolve({ status: 'ok', conversationId: 'synthetic-A' });
      await tick;
      await store.idle();
    }
  });
});
