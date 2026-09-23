import { randomBytes } from 'node:crypto';
import type { Observation } from '../browser/types.js';
import { RecordingCapture } from './capture.js';
import { project } from './project.js';
import { RECORDER_WORLD, buildRecorderScript } from './recorder-script.js';
import { RawEventSchema, TrajectorySchema, type LoggedEvent, type Trajectory } from './types.js';

/**
 * 录制只用得到页面适配器的这几个方法。写成结构类型照着
 * `electron-page-adapter.ts` 的签名来，这一层就不必认识 Electron。
 */
export interface RecordingPage {
  startRecording?(options: {
    script: string;
    bindingName: string;
    worldName: string;
    onMessage(payload: string): void;
  }): Promise<void>;
  stopRecording?(): Promise<void>;
  /** 页面自己报的地址、标题与正文比主进程模型准；给不出就用调用方传来的那份。 */
  snapshot?(): Promise<{ url: string; title: string }>;
  /**
   * 摘录用的正文，输入框、文本域与编辑区里的字都已跳过。Agent 读页面的 readText 带着它们，
   * 所以这里不认 readText：适配器没有这个方法时摘录就空着。
   */
  readRecordableText?(): Promise<string>;
}

export interface RecordingSessionDeps {
  /** 取页面适配器与文档 epoch；就是 main.ts 里的 BrowserService。 */
  browser: {
    registry: {
      has(tabId: string): boolean;
      get(tabId: string): { page: RecordingPage; documentEpoch: number };
    };
    observe(input: { principalId: string; tabId: string }): Promise<Observation>;
  };
  library: {
    create(name: string, trajectory: Trajectory, events?: readonly LoggedEvent[]): Promise<string>;
  };
  /** 台账：录制开始与停止这两条事实，aggregateType 固定是 recording，由主进程钉住。 */
  recordEvent(tabId: string, eventType: string, payload: Record<string, unknown>): void;
  /** 状态变了就通知渲染进程；就是 main.ts 的 emit。 */
  emit(): void;
  log(line: string): void;
  /** 当前有别的东西在开浏览器时返回中文原因，录制据此拒绝开始。 */
  busy(): string | undefined;
  principalId: string;
  now?: () => Date;
}

export interface RecordingSession {
  isRecording(): boolean;
  tabId(): string | undefined;
  /** 给 state() 用：就是 RecordingState 那几项，多出来的字段过桥也没人读。 */
  snapshot(): { tabId: string; startedAt: string; steps: number; unsupported: number } | undefined;
  start(tabId: string): Promise<void>;
  stop(name: string): Promise<string | undefined>;
  /** 地址栏导航；录制的不是这个标签就什么也不做。 */
  navigate(tabId: string, url: string): void;
  /** 前进后退刷新：把原因绑定到预期的落地地址，下一条 page 的地址对不上就不算数。 */
  pendingCause(tabId: string, cause: 'back' | 'forward' | 'reload', expectedUrl: string): void;
  note(text: string): void;
  /** 文档开始加载：上一份 observe 的序号作废。 */
  dropObservation(tabId: string): void;
  /** 文档加载完：记一条 page，并为新文档预取 observe。 */
  pageLoaded(tabId: string, entry: { url: string; title: string; text: string }): void;
  /** 焦点要离开录制标签了（切标签、关标签、崩溃、退出）：自动停止并保存。 */
  leaveTab(nextTabId: string | undefined, name: string): Promise<void>;
}

type Active = {
  tabId: string;
  capture: RecordingCapture;
  /** 该文档预取的 observe 结果，用来给步骤取词；文档一换就清。 */
  observed?: Observation;
  observing?: Promise<void>;
  /** 每换一次文档加一：在途的那次 observe 回来时对不上号就直接作废。 */
  observeGeneration: number;
  /** 主进程模型报过来的地址，用来给 page 去重。 */
  lastPageUrl?: string;
  /**
   * 挂起的前进后退刷新原因：绑定着预期落地的地址，`loadStarted` 记着挂起之后
   * 是否真的有文档开始加载过（由 dropObservation 打上）。这份状态现在只有会话层
   * 一个主人，采集层不再自己留一份，两处不会再各说各话。三者一起交给 pageLoaded
   * 判定下一条 page 该消费、留着还是丢弃这个原因。
   */
  pendingNavigation?: {
    cause: 'back' | 'forward' | 'reload';
    expectedUrl: string;
    loadStarted: boolean;
  };
  /** 真正落进日志的那个地址，备注挂在它上面。 */
  currentUrl?: string;
  /** 队列排空之后才置位：在此之前排在队里的事件仍然要进日志。 */
  finished: boolean;
  /** 脚本消息与页面条目串行处理，顺序就是人的顺序。 */
  queue: Promise<void>;
};

/**
 * 录制的全部编排：开关、页面进出、事件入队、observe 预取、停止落盘。
 * 主进程只往里传依赖与触点，不再自己持有录制状态。
 */
export function createRecordingSession(deps: RecordingSessionDeps): RecordingSession {
  let active: Active | undefined;

  /**
   * 文档换了：手里那份 observe 作废，在途的那次也不要再落地。主进程在文档开始加载时
   * 已经会调这个（经 dropObservation(tabId)），顺带把挂起原因标记为「真的加载过」——
   * recordPage 里也会调它做同样的失效处理，那时原因已经被 pageLoaded 消费或丢弃过了，
   * 这里的标记因此是个空操作，不会张冠李戴到下一次挂起。
   */
  function dropObservation(current: Active): void {
    current.observeGeneration += 1;
    current.observed = undefined;
    current.observing = undefined;
    if (current.pendingNavigation) current.pendingNavigation.loadStarted = true;
  }

  /** 只有还和当前文档同一个 epoch 的 observe 才配给步骤取词。 */
  function freshObservation(current: Active): Observation | undefined {
    const observation = current.observed;
    if (!observation || !deps.browser.registry.has(current.tabId)) return undefined;
    return observation.documentEpoch === deps.browser.registry.get(current.tabId).documentEpoch
      ? observation
      : undefined;
  }

  /** 所有写入都走这条队，顺序才等于人的顺序。 */
  function enqueue(current: Active, task: () => Promise<void> | void): void {
    current.queue = current.queue
      .then(async () => {
        if (current.finished) return;
        await task();
      })
      .catch(() => undefined);
  }

  function enqueueRawEvent(current: Active, payload: string): void {
    enqueue(current, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const parsed = RawEventSchema.safeParse(raw);
      if (!parsed.success) return;
      await current.observing?.catch(() => undefined);
      current.capture.raw(parsed.data, freshObservation(current));
      deps.emit();
    });
  }

  /** 页面加载完成：记 URL、标题与正文摘录，并预取一次 observe 供后续步骤取词。 */
  async function recordPage(
    current: Active,
    tabId: string,
    entry: { url: string; title: string; text: string },
    cause?: 'back' | 'forward' | 'reload',
  ): Promise<void> {
    if (!deps.browser.registry.has(tabId)) return;
    const page = deps.browser.registry.get(tabId).page;
    let resolved = entry;
    if (page.snapshot) {
      const snapshot = await page.snapshot();
      const text = (await page.readRecordableText?.().catch(() => '')) ?? '';
      resolved = { url: snapshot.url, title: snapshot.title, text };
    }
    current.capture.page(resolved, cause);
    current.currentUrl = resolved.url;
    dropObservation(current);
    const generation = current.observeGeneration;
    current.observing = deps.browser
      .observe({ principalId: deps.principalId, tabId })
      .then((observation) => {
        if (!current.finished && current.observeGeneration === generation)
          current.observed = observation;
      })
      .catch(() => undefined);
    deps.emit();
  }

  /** 停止并保存。没有录到步骤时不建文件，返回 undefined。 */
  async function stop(name: string): Promise<string | undefined> {
    const current = active;
    if (!current) throw new Error('当前没有在录制');
    active = undefined;
    const page = deps.browser.registry.has(current.tabId)
      ? deps.browser.registry.get(current.tabId).page
      : undefined;
    await page?.stopRecording?.().catch(() => undefined);
    // 通道的监听在 stop() 里同步摘掉，所以队列排空之后不会再有事件；排空之前的都还算数。
    await current.queue.catch(() => undefined);
    current.finished = true;
    const events = current.capture.finish();
    const { entries } = project(events);
    const trajectory = TrajectorySchema.parse({
      meta: { app: 'pilion', version: 2, name, recordedAt: current.capture.startedAt },
      entries,
    });
    // 只有滚动的录制不值得留一堆空目录：没有动作步骤就不落盘。
    const hasSteps = entries.some((entry) => entry.kind === 'step');
    const id = hasSteps ? await deps.library.create(name, trajectory, events) : undefined;
    deps.recordEvent(current.tabId, 'recording.stopped', { id, entries: entries.length });
    deps.log(
      id
        ? current.capture.capped
          ? `录制已保存（已达到步骤上限）：${name}`
          : `录制已保存：${name}`
        : '录制结束，没有记录到任何步骤',
    );
    deps.emit();
    return id;
  }

  return {
    isRecording: () => Boolean(active),
    tabId: () => active?.tabId,
    snapshot: () =>
      active
        ? {
            tabId: active.tabId,
            startedAt: active.capture.startedAt,
            steps: active.capture.counts.steps,
            unsupported: active.capture.counts.unsupported,
          }
        : undefined,

    async start(tabId: string): Promise<void> {
      if (active) throw new Error('已经在录制了');
      const busy = deps.busy();
      if (busy) throw new Error(busy);
      const page = deps.browser.registry.get(tabId).page;
      if (!page.startRecording) throw new Error('当前页面不支持录制');
      const bindingName = `pilion_${randomBytes(8).toString('hex')}`;
      const current: Active = {
        tabId,
        capture: new RecordingCapture({ now: deps.now }),
        finished: false,
        observeGeneration: 0,
        queue: Promise.resolve(),
      };
      active = current;
      try {
        await page.startRecording({
          script: buildRecorderScript(bindingName),
          bindingName,
          worldName: RECORDER_WORLD,
          onMessage: (payload) => enqueueRawEvent(current, payload),
        });
      } catch (error) {
        active = undefined;
        throw error;
      }
      deps.recordEvent(tabId, 'recording.started', { startedAt: current.capture.startedAt });
      deps.log('开始录制');
      deps.emit();
    },

    stop,

    navigate(tabId: string, url: string): void {
      const current = active;
      if (current?.tabId !== tabId) return;
      // 人改用地址栏了：挂着的前进后退刷新原因作废，不能安到这次导航头上。
      current.pendingNavigation = undefined;
      enqueue(current, () => {
        current.capture.navigate(url);
        deps.emit();
      });
    },

    pendingCause(tabId: string, cause: 'back' | 'forward' | 'reload', expectedUrl: string): void {
      const current = active;
      if (current?.tabId !== tabId) return;
      // 这是纯状态，不进日志，所以不必走队列：真正的日志写入在 pageLoaded 判完之后才发生，
      // 那时会把这里存的 cause 原样传给排队的页面记录，不会被后续的挂起覆盖或抢跑。
      current.pendingNavigation = { cause, expectedUrl, loadStarted: false };
    },

    note(text: string): void {
      const current = active;
      if (!current) throw new Error('当前没有在录制');
      enqueue(current, () => {
        current.capture.note(text, current.currentUrl);
        deps.emit();
      });
    },

    dropObservation(tabId: string): void {
      if (active?.tabId !== tabId) return;
      dropObservation(active);
    },

    pageLoaded(tabId: string, entry: { url: string; title: string; text: string }): void {
      const current = active;
      if (current?.tabId !== tabId) return;
      const pending = current.pendingNavigation;
      // 有原因挂着时，按顺序判断这一条 page 是消费、留着还是丢弃它。
      if (
        pending &&
        entry.url === pending.expectedUrl &&
        (entry.url !== current.lastPageUrl || pending.loadStarted)
      ) {
        // 规则一：落地地址对得上预期，而且不是「还没加载就已经同址」的假象——
        // 这就是那次导航的落地。消费原因，这一条不去重，把原因带进排队的页面记录，
        // 由采集层在 page 之前先写一条 navigate。
        current.pendingNavigation = undefined;
        current.lastPageUrl = entry.url;
        enqueue(current, () => recordPage(current, tabId, entry, pending.cause));
        return;
      }
      if (pending && entry.url === current.lastPageUrl && !pending.loadStarted) {
        // 规则二：地址跟当前页一样，而且没有文档真的开始加载过——只是当前页的一次
        // 普通同步（标题变化、缩放、加载状态抖动），不是导航落地。照常去重，原因继续挂着，
        // 等真正的下一次换页；否则原因会被这类抖动凭空消费掉，多出一条刷新步骤。
        return;
      }
      // 规则三：其它情况——落到了预期之外的地方（重定向），或者根本没发生、人已经去了
      // 别的页面。丢弃原因，不能让它继续悬着贴到更后面某次不相关的换页上；这一条按
      // 没有原因时的规则去重与记录。
      current.pendingNavigation = undefined;
      if (entry.url === current.lastPageUrl) return;
      current.lastPageUrl = entry.url;
      enqueue(current, () => recordPage(current, tabId, entry));
    },

    /** 录制跟着它开始时的标签走：焦点一离开那个标签，就停止并保存。 */
    async leaveTab(nextTabId: string | undefined, name: string): Promise<void> {
      if (!active || active.tabId === nextTabId) return;
      await stop(name);
    },
  };
}
