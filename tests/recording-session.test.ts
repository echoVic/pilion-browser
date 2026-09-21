import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/main/browser/index';
import { createRecordingSession, type RecordingSessionDeps } from '../src/main/recording/session';
import type { LoggedEvent, Trajectory } from '../src/main/recording/types';

const el = { tagName: 'button', role: 'button', name: '导出 CSV' };
const HOME_URL = 'https://example.com/';
const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 12, 0, (tick += 1)));
};
const click = (url = HOME_URL, index = 1) => ({ kind: 'click', url, index, el, at: 1 });

/** 全套假依赖：不碰 Electron，页面只实现录制通道那两个方法。 */
function fakeDeps() {
  const created: { name: string; trajectory: Trajectory; events: LoggedEvent[] }[] = [];
  const ledger: { tabId: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let onMessage: ((payload: string) => void) | undefined;
  let observes = 0;
  let stopped = 0;
  const observation: Observation = {
    observationId: 'o',
    tabId: 'tab-1',
    documentEpoch: 1,
    elements: [],
  };
  const deps: RecordingSessionDeps = {
    browser: {
      registry: {
        has: () => true,
        get: () => ({
          documentEpoch: 1,
          page: {
            startRecording: (options) => {
              onMessage = options.onMessage;
              return Promise.resolve();
            },
            stopRecording: () => {
              stopped += 1;
              return Promise.resolve();
            },
          },
        }),
      },
      observe: () => {
        observes += 1;
        return Promise.resolve(observation);
      },
    },
    library: {
      create: (name, trajectory, events) => {
        created.push({ name, trajectory, events: [...(events ?? [])] });
        return Promise.resolve('slug');
      },
    },
    recordEvent: (tabId, eventType, payload) => {
      ledger.push({ tabId, eventType, payload });
    },
    emit: () => undefined,
    log: (line) => lines.push(line),
    busy: () => undefined,
    principalId: 'local-user',
    now: clock(),
  };
  return {
    created,
    ledger,
    lines,
    deps,
    send: (event: unknown) => onMessage?.(JSON.stringify(event)),
    counts: () => ({ observes, stopped }),
  };
}

const kinds = (events: readonly LoggedEvent[]) => events.map((event) => event.kind);

describe('createRecordingSession', () => {
  it('停止时把日志和轨迹一起交给技能库', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    expect(await session.stop('月度导出')).toBe('slug');
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('月度导出');
    expect(kinds(created[0].events)).toEqual(['page', 'click']);
    expect(created[0].trajectory.meta).toMatchObject({
      app: 'pilion',
      version: 2,
      name: '月度导出',
    });
    expect(created[0].trajectory.entries.map((entry) => entry.kind)).toEqual(['page', 'step']);
  });

  it('轨迹的 recordedAt 用注入的时钟，不用真实时间', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.stop('钉住时间');
    expect(created[0].trajectory.meta.recordedAt).toBe('2026-09-21T12:00:01.000Z');
  });

  it('一步都没有就不落盘', async () => {
    const { deps, created, lines } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    expect(await session.stop('空的')).toBeUndefined();
    expect(created).toHaveLength(0);
    expect(lines).toContain('录制结束，没有记录到任何步骤');
  });

  it('后退的原因经会话层挂起，落在下一条 page 之前', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    send(click());
    session.pendingCause('tab-1', 'back');
    session.pageLoaded('tab-1', { url: 'https://example.com/list', title: '二', text: '' });
    await session.stop('带后退的');
    expect(kinds(created[0].events)).toEqual(['page', 'click', 'navigate', 'page']);
    expect(created[0].events[2]).toMatchObject({ kind: 'navigate', cause: 'back' });
  });

  it('刷新与前进各记自己的原因', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    send(click());
    session.pendingCause('tab-1', 'reload');
    session.pageLoaded('tab-1', { url: 'https://example.com/a', title: '二', text: '' });
    session.pendingCause('tab-1', 'forward');
    session.pageLoaded('tab-1', { url: 'https://example.com/b', title: '三', text: '' });
    await session.stop('前进后退');
    expect(created[0].events.filter((event) => event.kind === 'navigate')).toMatchObject([
      { cause: 'reload' },
      { cause: 'forward' },
    ]);
  });

  it('地址栏导航记成 address，挂着的前进后退原因作废', async () => {
    const { deps, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    session.pendingCause('tab-1', 'back');
    session.navigate('tab-1', 'https://example.com/typed');
    session.pageLoaded('tab-1', { url: 'https://example.com/typed', title: '二', text: '' });
    await session.stop('地址栏');
    expect(created[0].events.filter((event) => event.kind === 'navigate')).toMatchObject([
      { cause: 'address', url: 'https://example.com/typed' },
    ]);
  });

  it('别的东西在开浏览器时拒绝开始录制', async () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession({ ...deps, busy: () => 'Agent 正在操作页面' });
    await expect(session.start('tab-1')).rejects.toThrow('Agent 正在操作页面');
    expect(session.isRecording()).toBe(false);
  });

  it('已经在录制时再开一次会被拒绝', async () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    await expect(session.start('tab-2')).rejects.toThrow('已经在录制了');
    expect(session.tabId()).toBe('tab-1');
  });

  it('切到别的标签会自动停止并保存', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.leaveTab('tab-2', '自动保存');
    expect(session.isRecording()).toBe(false);
    expect(created[0].name).toBe('自动保存');
  });

  it('还在同一个标签上就不自动停止', async () => {
    const { deps, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    await session.leaveTab('tab-1', '不该保存');
    expect(session.isRecording()).toBe(true);
    expect(created).toHaveLength(0);
  });

  it('不是录制的那个标签，事件一概不收', () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession(deps);
    session.pageLoaded('tab-9', { url: 'https://other/', title: '', text: '' });
    expect(session.snapshot()).toBeUndefined();
    expect(session.isRecording()).toBe(false);
  });

  it('录着 tab-1 时 tab-9 的导航与页面都不进日志', async () => {
    const { deps, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    session.navigate('tab-9', 'https://other/');
    session.pendingCause('tab-9', 'reload');
    session.pageLoaded('tab-9', { url: 'https://other/', title: '别的', text: '' });
    session.note('记一笔');
    await session.stop('只有本标签');
    expect(kinds(created[0].events)).toEqual(['page', 'note']);
  });

  it('同一个地址不会连记两条 page', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.stop('去重');
    expect(kinds(created[0].events)).toEqual(['page', 'click']);
  });

  it('snapshot 给出录制条要显示的东西', async () => {
    const { deps, send } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    send(click(HOME_URL, 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.snapshot()).toEqual({
      tabId: 'tab-1',
      startedAt: '2026-09-21T12:00:01.000Z',
      steps: 2,
      unsupported: 0,
      capped: false,
    });
  });

  it('开始与停止都进台账', async () => {
    const { deps, send, ledger } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.stop('台账');
    expect(ledger.map((row) => row.eventType)).toEqual(['recording.started', 'recording.stopped']);
    expect(ledger[0]).toMatchObject({ tabId: 'tab-1' });
    expect(ledger[1].payload).toMatchObject({ id: 'slug', entries: 2 });
  });

  it('没在录制时停止会报错，备注也一样', async () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession(deps);
    await expect(session.stop('没开')).rejects.toThrow('当前没有在录制');
    expect(() => session.note('没开')).toThrow('当前没有在录制');
  });

  it('页面不支持录制时开不起来，也不会留下半开的会话', async () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession({
      ...deps,
      browser: {
        ...deps.browser,
        registry: { has: () => true, get: () => ({ documentEpoch: 1, page: {} }) },
      },
    });
    await expect(session.start('tab-1')).rejects.toThrow('当前页面不支持录制');
    expect(session.isRecording()).toBe(false);
  });

  it('startRecording 失败时会话不残留', async () => {
    const { deps } = fakeDeps();
    const session = createRecordingSession({
      ...deps,
      browser: {
        ...deps.browser,
        registry: {
          has: () => true,
          get: () => ({
            documentEpoch: 1,
            page: {
              startRecording: () => Promise.reject(new Error('通道没开起来')),
              stopRecording: () => Promise.resolve(),
            },
          }),
        },
      },
    });
    await expect(session.start('tab-1')).rejects.toThrow('通道没开起来');
    expect(session.isRecording()).toBe(false);
    expect(session.tabId()).toBeUndefined();
  });

  it('停止时摘掉页面上的录制通道，并为新文档预取过 observe', async () => {
    const { deps, send, counts } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.stop('收尾');
    expect(counts()).toEqual({ observes: 1, stopped: 1 });
  });
});
