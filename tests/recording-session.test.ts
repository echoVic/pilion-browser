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

/**
 * observe 报出的名字比脚本自己算的那份更全。两者都能匹配上同一个元素，
 * 所以步骤里最后留下哪一个名字，就是「这份 observe 到底有没有被采信」的唯一证据。
 */
const OBSERVED_NAME = '导出 CSV 报表';
function observationAt(documentEpoch: number): Observation {
  const ref = (id: string) => ({
    id,
    tabId: 'tab-1',
    frameId: 'main',
    documentEpoch,
    frameEpoch: 0,
    localFingerprint: 'e'.repeat(64),
  });
  return {
    observationId: `o-${documentEpoch}`,
    tabId: 'tab-1',
    documentEpoch,
    elements: [
      { ref: ref('r0'), role: 'link', name: '首页', disabled: false, tagName: 'a' },
      { ref: ref('r1'), role: 'button', name: OBSERVED_NAME, disabled: false, tagName: 'button' },
    ],
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 让排在队里的微任务都跑完。 */
const drain = () => new Promise((resolve) => setImmediate(resolve));

type FakeOptions = {
  /** 页面适配器自己报得出地址、标题与正文，走的就是生产那条路。 */
  reports?: { url: string; title: string; text: string };
  /** observe 挂住不返回，由测试放行，用来做「在途的那一次」。 */
  holdObserve?: boolean;
  /** 摘录制通道挂住不返回，用来看清停止过程中的会话状态。 */
  holdStop?: boolean;
};

/** 全套假依赖：不碰 Electron。 */
function fakeDeps(options: FakeOptions = {}) {
  const created: { name: string; trajectory: Trajectory; events: LoggedEvent[] }[] = [];
  const ledger: { tabId: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let onMessage: ((payload: string) => void) | undefined;
  let observes = 0;
  let stopped = 0;
  let emits = 0;
  /** 标签当前这份文档的 epoch；测试换页就把它推上去。 */
  let liveEpoch = 1;
  let served = observationAt(1);
  const observeGate = deferred();
  const observeArrived = deferred();
  const stopGate = deferred();
  const page = {
    startRecording: (opts: { onMessage: (payload: string) => void }) => {
      onMessage = opts.onMessage;
      return Promise.resolve();
    },
    stopRecording: () => {
      stopped += 1;
      return options.holdStop ? stopGate.promise : Promise.resolve();
    },
    ...(options.reports
      ? {
          snapshot: () =>
            Promise.resolve({ url: options.reports!.url, title: options.reports!.title }),
          readText: () => Promise.resolve(options.reports!.text),
        }
      : {}),
  };
  const deps: RecordingSessionDeps = {
    browser: {
      registry: {
        has: () => true,
        get: () => ({ documentEpoch: liveEpoch, page }),
      },
      observe: () => {
        observes += 1;
        if (!options.holdObserve) return Promise.resolve(served);
        observeArrived.release();
        return observeGate.promise.then(() => served);
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
    emit: () => {
      emits += 1;
    },
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
    counts: () => ({ observes, stopped, emits }),
    /** 标签换了文档：把 registry 报的 epoch 推上去，手里那份 observe 就过期了。 */
    setLiveEpoch: (epoch: number) => {
      liveEpoch = epoch;
    },
    serve: (observation: Observation) => {
      served = observation;
    },
    observeArrived: observeArrived.promise,
    releaseObserve: observeGate.release,
    releaseStop: stopGate.release,
  };
}

const kinds = (events: readonly LoggedEvent[]) => events.map((event) => event.kind);
/** 轨迹里落下来的步骤种类，按顺序。 */
const stepKinds = (trajectory: Trajectory) =>
  trajectory.entries.flatMap((entry) => (entry.kind === 'step' ? [entry.step.kind] : []));
/** 日志里那条 click 记下来的目标名字。 */
function clickName(events: readonly LoggedEvent[]): string | undefined {
  const event = events.find((item) => item.kind === 'click');
  return event && 'target' in event ? event.target.name : undefined;
}

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

  it('刷新落在同一个地址：导航照样记下，人按下去的那一下不会被吞掉', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    session.pendingCause('tab-1', 'reload');
    // 刷新按定义就落在同一个地址：page 去重会把这一条吃掉，原因就没人消费了。
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    // 人按下去、页面立刻跳走：这一下只能靠换页时的补点击留下来。
    send({ kind: 'pointer', url: HOME_URL, index: 1, el, at: 1 });
    session.pageLoaded('tab-1', { url: 'https://example.com/next', title: '二', text: '' });
    await session.stop('刷新');
    expect(kinds(created[0].events)).toEqual(['page', 'navigate', 'page', 'pointer', 'page']);
    expect(created[0].events[1]).toMatchObject({
      kind: 'navigate',
      cause: 'reload',
      url: HOME_URL,
    });
    // 原因悬到下一次换页的话，投影会先清掉挂起的 pointer，这一下点击就没了。
    expect(stepKinds(created[0].trajectory)).toEqual(['navigate', 'click']);
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
    expect(counts()).toMatchObject({ observes: 1, stopped: 1 });
  });

  it('挂起的原因会一直等到下一条 page，会话分不出那次导航到底有没有发生', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '一', text: '' });
    session.pendingCause('tab-1', 'back');
    // 这一次后退没真的发生：没有新文档提交，原因就悬在这里。
    send(click());
    session.pageLoaded('tab-1', { url: 'https://example.com/next', title: '二', text: '' });
    await session.stop('悬着的原因');
    // 它会安到下一次换页头上，多出一条 navigate，还会顺手清掉挂起的 pointer。
    // 会话层没法分辨，所以 main.ts 的 tabBack/tabForward 在没有历史可走时根本不挂原因。
    expect(created[0].events.filter((event) => event.kind === 'navigate')).toMatchObject([
      { cause: 'back', url: 'https://example.com/next' },
    ]);
  });

  it('epoch 对得上时，步骤用 observe 报出的名字', async () => {
    const { deps, send, created } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    await drain();
    send(click());
    await session.stop('新鲜的 observe');
    expect(clickName(created[0].events)).toBe(OBSERVED_NAME);
  });

  it('文档已经换过，手里那份 observe 不再采信，步骤退回脚本自己的描述', async () => {
    const { deps, send, created, setLiveEpoch } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    await drain();
    // 标签换了文档：registry 报的 epoch 已经比手里那份 observe 新，序号指的不是同一批元素了。
    setLiveEpoch(2);
    send(click());
    await session.stop('过期的 observe');
    expect(clickName(created[0].events)).toBe('导出 CSV');
  });

  it('在途的 observe 回来时文档已经又换了一轮，这份结果作废', async () => {
    const { deps, send, created, observeArrived, releaseObserve } = fakeDeps({ holdObserve: true });
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    await observeArrived; // observe 已经发出去，还没回来
    session.dropObservation('tab-1'); // 新文档开始加载，这一代作废
    releaseObserve(); // 它这时候才回来，已经晚了
    await drain();
    send(click());
    await session.stop('作废的 observe');
    expect(clickName(created[0].events)).toBe('导出 CSV');
  });

  it('页面正文摘录经页面适配器进日志，不用调用方给的那份', async () => {
    const { deps, send, created } = fakeDeps({
      reports: { url: 'https://example.com/report', title: '月度报表', text: '本月导出 42 笔' },
    });
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '主进程模型里的标题', text: '' });
    send(click());
    await session.stop('正文摘录');
    // 提炼读的就是这段正文，主进程模型里没有它，只有页面适配器拿得到。
    expect(created[0].events[0]).toMatchObject({
      kind: 'page',
      url: 'https://example.com/report',
      title: '月度报表',
      text: '本月导出 42 笔',
    });
  });

  it('停止之后才到的事件不再处理', async () => {
    const { deps, send, created, counts } = fakeDeps();
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    await session.stop('收尾');
    const settled = counts().emits;
    send(click(HOME_URL, 2));
    await drain();
    // 处理一条事件必然以 emit 收尾；一次都没有，就是这条事件被丢掉了。
    expect(counts().emits).toBe(settled);
    expect(kinds(created[0].events)).toEqual(['page', 'click']);
  });

  it('停止一发出，会话立刻就不算在录制，这期间再停一次会被拒绝', async () => {
    const { deps, send, created, releaseStop } = fakeDeps({ holdStop: true });
    const session = createRecordingSession(deps);
    await session.start('tab-1');
    session.pageLoaded('tab-1', { url: HOME_URL, title: '页', text: '' });
    send(click());
    const stopping = session.stop('第一次');
    await drain();
    // 通道还没摘完，停止远没结束，但会话已经不该再收任何东西了。
    expect(session.isRecording()).toBe(false);
    expect(session.tabId()).toBeUndefined();
    await expect(session.stop('第二次')).rejects.toThrow('当前没有在录制');
    releaseStop();
    await stopping;
    expect(created).toHaveLength(1);
    // 停止之前排进队里的那条点击照样算数。
    expect(kinds(created[0].events)).toEqual(['page', 'click']);
  });
});
