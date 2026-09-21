import {
  StepSchema,
  type LoggedEvent,
  type Step,
  type StepTarget,
  type TrajectoryEntry,
  UNSUPPORTED_REASONS,
} from './types.js';

/** observe 截断到 200 个元素，序号在此之后的目标回放永远够不到。 */
const OBSERVE_LIMIT = 200;
const DOUBLE_CLICK_MS = 400;
/** 轨迹 schema 允许的条目上限；到顶就停止增长，投影照样算得完。 */
const MAX_ENTRIES = 2000;

type Pending = {
  index: number;
  target: StepTarget;
  text: string;
  onUrl: string;
  ambiguous: boolean;
  at: string;
};
type Pointer = {
  index: number;
  url: string;
  target: StepTarget;
  ambiguous: boolean;
  beyond: boolean;
  at: string;
};

function beyondReason(target: StepTarget): string {
  return `手动完成对 "${target.name || target.tagName}" 的操作`;
}

/** 步骤不合法时只剩「人当时想做什么」还有用；`onUrl` 是必填项，所以这里保证它非空。 */
function stepUrl(step: Step): string {
  const raw = step.kind === 'navigate' ? step.url : (step.onUrl ?? '');
  return raw.slice(0, 8192) || 'about:blank';
}

function describeAttempt(step: Step): string {
  const what = (target: StepTarget) => `"${target.name || target.tagName}"`;
  switch (step.kind) {
    case 'navigate':
      return '打开录制时的那个地址';
    case 'note':
      return '补上这条备注';
    case 'human':
      return step.reason || '完成这一步';
    case 'click':
      return `点击 ${what(step.target)}`;
    case 'type':
      return `在 ${what(step.target)} 里填写内容`;
    case 'select':
      return `在 ${what(step.target)} 里选择${step.value ? ` "${step.value}"` : '空选项'}`;
    case 'check':
      return `${step.checked ? '勾选' : '取消勾选'} ${what(step.target)}`;
    case 'press':
      return `在 ${what(step.target)} 上按 ${step.key}`;
  }
}

/**
 * 日志到步骤的纯状态机：没有时钟、没有 I/O、不碰 Electron。
 * 每个条目的 `at` 都抄自产生它的那条事件，所以同一份日志算多少次都一样。
 */
export class Projector {
  readonly #entries: TrajectoryEntry[] = [];
  #currentUrl = '';
  #pending: Pending | undefined;
  #pointer: Pointer | undefined;
  #lastClick: { index: number; at: number } | undefined;
  #lastSecretIndex: number | undefined;
  #capped = false;
  #finished = false;

  get capped(): boolean {
    return this.#capped;
  }

  get counts(): { steps: number; unsupported: number } {
    const steps = this.#entries.filter((entry) => entry.kind === 'step');
    return {
      steps: steps.length + (this.#pending ? 1 : 0),
      unsupported: steps.filter((entry) => entry.unsupported).length,
    };
  }

  push(event: LoggedEvent): void {
    if (this.#finished) throw new Error('投影已结束，不能再喂事件');
    switch (event.kind) {
      case 'scroll':
        // 规则 3 同样适用：滚动之后再换页，那次 mousedown 不该被补成点击（多半是拖拽滚动）。
        // 但不提交挂起的输入：边打字边滚动很常见，滚动不是对另一个元素的操作。
        this.#pointer = undefined;
        return;
      case 'page':
        return this.#page(event);
      case 'navigate':
        return this.#navigate(event);
      case 'note':
        return this.#note(event);
      default:
        return this.#element(event);
    }
  }

  done(): { entries: TrajectoryEntry[]; capped: boolean } {
    if (!this.#finished) {
      this.#flushPending();
      this.#pointer = undefined;
      this.#finished = true;
    }
    return { entries: [...this.#entries], capped: this.#capped };
  }

  #page(event: Extract<LoggedEvent, { kind: 'page' }>): void {
    this.#flushPending();
    this.#lastClick = undefined;
    this.#flushPointerAsClick(event.url);
    this.#currentUrl = event.url;
    this.#add({
      kind: 'page',
      at: event.at,
      url: event.url,
      title: event.title.slice(0, 400),
      text: event.text.slice(0, 2000),
    });
  }

  #navigate(event: Extract<LoggedEvent, { kind: 'navigate' }>): void {
    this.#flushPending();
    this.#lastClick = undefined;
    this.#pointer = undefined;
    // cause 只进日志给人和 Agent 看；四种来源产出的步骤完全一样，回放都是「打开这个地址」。
    this.#push(event.at, { kind: 'navigate', url: event.url });
  }

  #note(event: Extract<LoggedEvent, { kind: 'note' }>): void {
    this.#pointer = undefined;
    const onUrl = event.onUrl || this.#currentUrl;
    this.#push(event.at, {
      kind: 'note',
      text: event.text.slice(0, 2000),
      ...(onUrl ? { onUrl } : {}),
    });
  }

  #element(event: Exclude<LoggedEvent, { kind: 'page' | 'navigate' | 'note' | 'scroll' }>): void {
    // 规则 3：除了 pointer 自己，任何事件都清掉挂着的 pointer。
    if (event.kind !== 'pointer') this.#pointer = undefined;

    if (event.kind === 'unsupported') {
      this.#flushPending();
      const what = event.el ? `"${event.el.name || event.el.tagName}"` : '页面内嵌框架';
      const why =
        event.reason === 'gesture'
          ? `手动完成在 ${what} 上的拖拽或右键操作`
          : event.reason === 'iframe'
            ? '手动完成内嵌框架里的操作'
            : `手动点击 ${what}`;
      this.#push(
        event.at,
        { kind: 'human', onUrl: this.#onUrl(event.url), reason: why },
        { unsupported: event.reason },
      );
      return;
    }

    const { target, ambiguous } = event;
    const onUrl = this.#onUrl(event.url);

    // 富文本要在超纲判断之前处理：它的 index 通常是 -1（不在 observe 选择器里），
    // 落进超纲分支就会给出「手动完成对 "" 的操作」这种没用的话。
    if (event.kind === 'edit') {
      this.#flushPending();
      this.#push(
        event.at,
        { kind: 'human', onUrl, reason: '手动填写富文本内容' },
        { unsupported: 'rich-text' },
      );
      return;
    }

    const beyond = event.index >= OBSERVE_LIMIT || event.index < 0;
    // pointerdown 与 click 成对出现，超纲也只该提醒一次：pointer 只挂起，
    // 由紧随的 click（或换页时的补点击）落那唯一一条。
    if (beyond && event.kind === 'pointer') {
      this.#flushPending(event.index);
      this.#pointer = {
        index: event.index,
        url: onUrl,
        target,
        ambiguous,
        beyond: true,
        at: event.at,
      };
      return;
    }
    if (beyond && event.kind !== 'secret') {
      this.#flushPending();
      this.#push(
        event.at,
        { kind: 'human', onUrl, reason: beyondReason(target) },
        { unsupported: 'beyond-observe-limit' },
      );
      return;
    }
    // 点进正在输入的那个框不算换元素；其它任何事件（包括同一字段上的回车）都先提交挂起的输入。
    if (event.kind !== 'input')
      this.#flushPending(event.kind === 'pointer' ? event.index : undefined);
    if (event.kind !== 'secret') this.#lastSecretIndex = undefined;

    switch (event.kind) {
      case 'pointer':
        this.#pointer = {
          index: event.index,
          url: onUrl,
          target,
          ambiguous,
          beyond: false,
          at: event.at,
        };
        return;
      case 'click': {
        if (
          this.#lastClick &&
          this.#lastClick.index === event.index &&
          event.pageAt - this.#lastClick.at <= DOUBLE_CLICK_MS
        )
          return;
        this.#lastClick = { index: event.index, at: event.pageAt };
        this.#push(event.at, { kind: 'click', onUrl, target }, { ambiguous });
        return;
      }
      case 'input':
        if (this.#pending && this.#pending.index !== event.index) this.#flushPending();
        this.#pending = {
          index: event.index,
          target,
          text: event.value,
          onUrl,
          ambiguous,
          at: event.at,
        };
        return;
      case 'select':
        this.#push(event.at, { kind: 'select', onUrl, target, value: event.value }, { ambiguous });
        return;
      case 'check':
        this.#push(
          event.at,
          { kind: 'check', onUrl, target, checked: event.checked },
          { ambiguous },
        );
        return;
      case 'key':
        this.#push(
          event.at,
          { kind: 'press', onUrl, target, key: event.key, modifiers: event.shift ? ['Shift'] : [] },
          { ambiguous },
        );
        return;
      case 'secret':
        if (this.#lastSecretIndex === event.index) return;
        this.#lastSecretIndex = event.index;
        this.#push(event.at, {
          kind: 'human',
          onUrl,
          reason: event.otp ? '填写验证码' : '填写密码',
        });
        return;
    }
  }

  #onUrl(eventUrl: string): string {
    return this.#currentUrl || eventUrl || 'about:blank';
  }

  /** 唯一的写入口：到上限就丢，绝不让投影因为超长而整份失败。 */
  #add(entry: TrajectoryEntry): void {
    if (this.#entries.length >= MAX_ENTRIES) {
      this.#capped = true;
      return;
    }
    this.#entries.push(entry);
  }

  #push(
    at: string,
    step: Step,
    marks: { unsupported?: (typeof UNSUPPORTED_REASONS)[number]; ambiguous?: boolean } = {},
  ): void {
    // 当场校验：空值下拉、超长 URL 这类步骤放进去，序列化时 schema 会把整份轨迹一起拒掉。
    // 换成一条人看得懂的「需要我」，别的步骤照样留着。
    if (!StepSchema.safeParse(step).success) {
      this.#add({
        kind: 'step',
        at,
        step: {
          kind: 'human',
          onUrl: stepUrl(step),
          reason: `手动完成：${describeAttempt(step)}`.slice(0, 500),
        },
        unsupported: 'out-of-scope',
      });
      return;
    }
    this.#add({
      kind: 'step',
      at,
      step,
      ...(marks.unsupported ? { unsupported: marks.unsupported } : {}),
      ...(marks.ambiguous ? { ambiguous: true } : {}),
    });
  }

  /** 挂起的输入在这些时刻提交：别的元素有动作、页面切换、结束。同一元素的 pointer 不提交。 */
  #flushPending(exceptIndex?: number): void {
    const pending = this.#pending;
    if (!pending) return;
    if (exceptIndex !== undefined && exceptIndex === pending.index) return;
    this.#pending = undefined;
    this.#push(
      pending.at,
      {
        kind: 'type',
        onUrl: pending.onUrl,
        target: pending.target,
        text: pending.text,
        replace: true,
      },
      { ambiguous: pending.ambiguous },
    );
  }

  /** mousedown 之后页面就跳走了：没有 click 事件，但人确实点了。到这里 pointer 还挂着，说明中间没有别的事件。 */
  #flushPointerAsClick(newUrl: string): void {
    const pointer = this.#pointer;
    this.#pointer = undefined;
    if (!pointer || newUrl === pointer.url) return;
    if (pointer.beyond) {
      this.#push(
        pointer.at,
        { kind: 'human', onUrl: pointer.url, reason: beyondReason(pointer.target) },
        { unsupported: 'beyond-observe-limit' },
      );
      return;
    }
    this.#push(
      pointer.at,
      { kind: 'click', onUrl: pointer.url, target: pointer.target },
      { ambiguous: pointer.ambiguous },
    );
  }
}

export function project(events: readonly LoggedEvent[]): {
  entries: TrajectoryEntry[];
  capped: boolean;
} {
  const projector = new Projector();
  for (const event of events) projector.push(event);
  return projector.done();
}
