import type { Observation, ObservedElement } from '../browser/types.js';
import { normalizeName, toStepTarget } from './resolve.js';
import { Projector } from './project.js';
import {
  MAX_URL_LENGTH,
  type ElementDescription,
  type LoggedEvent,
  type RawEvent,
  type StepTarget,
} from './types.js';

/** 日志上限：条数与字节数先到者为准，到顶就停止记录，绝不让停止录制失败。 */
export const MAX_EVENTS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * `Omit<LoggedEvent, 'seq' | 'at'>` 会先把判别联合拍扁成交集再减字段，
 * 结果只剩 `kind`。裸类型参数放进条件类型能让它逐个成员分发，减完 seq/at 还留着判别联合。
 */
type Unstamped<T> = T extends unknown ? Omit<T, 'seq' | 'at'> : never;

// fromDescription / sameElement 从 recorder.ts 原样搬来，是目标解析的全部逻辑。

function fromDescription(el: ElementDescription): StepTarget {
  return {
    role: el.role,
    name: el.name,
    tagName: el.tagName,
    ...(el.inputType ? { inputType: el.inputType } : {}),
    ...(el.optionValues?.length ? { optionValues: [...el.optionValues] } : {}),
    ...(el.duplicates && el.duplicates > 1 && el.position ? { nth: el.position } : {}),
  };
}

/**
 * 序号只在产出它的那份文档里成立。同一序号上的行如果角色或名字都对不上，
 * 说明手里这份 observe 已经过期，宁可退回脚本的描述，也不要拿别的元素的词去取名。
 */
function sameElement(row: ObservedElement, el: ElementDescription): boolean {
  if (row.tagName !== el.tagName) return false;
  if (row.role !== el.role && el.role !== 'generic') return false;
  const left = normalizeName(row.name);
  const right = normalizeName(el.name);
  // 脚本与 observe 算可访问名的路径不同，一方是另一方的子串很常见（"导出" 与 "导出 CSV"）。
  return left === right || left.includes(right) || right.includes(left) || el.name === '';
}

/**
 * 每一个进入日志的地址都过这一道：页面脚本的 href() 已经截过，这里是给脚本之外来源
 * （主进程模型报的页面条目、地址栏、备注）的把关，顺带也对脚本那份做防御性的再截一次。
 */
function clampUrl(url: string): { url: string; truncated: boolean } {
  if (url.length <= MAX_URL_LENGTH) return { url, truncated: false };
  return { url: url.slice(0, MAX_URL_LENGTH), truncated: true };
}

/**
 * 有副作用的那一层：持有时钟、拿实时 observe 解析目标、维护上限。
 * 它只产出日志；步骤是 Projector 的事，这里持有一个只为录制条实时显示步数。
 */
export class RecordingCapture {
  readonly #events: LoggedEvent[] = [];
  readonly #projector = new Projector();
  readonly #now: () => Date;
  readonly #startedAt: string;
  #bytes = 0;
  #capped = false;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now().toISOString();
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  /** 日志到顶或投影到顶，对人来说都是「后面的没记下」。 */
  get capped(): boolean {
    return this.#capped || this.#projector.capped;
  }

  get counts(): { steps: number; unsupported: number } {
    return this.#projector.counts;
  }

  /**
   * `cause` 有值时先补一条 navigate 再写 page：前进后退刷新是不是真的落地，
   * 由会话层判定好了才传进来，这一层不再自己留一份挂起状态去猜。
   * 地址栏与这里是导航唯一的两个出口，两边都要截断，否则一次超长的后退落地
   * 也能把整份录制写挂——不是只有人在地址栏敲才会出现超长地址。
   */
  page(
    entry: { url: string; title: string; text: string },
    cause?: 'back' | 'forward' | 'reload',
  ): void {
    const { url, truncated } = clampUrl(entry.url);
    if (cause) this.#add({ kind: 'navigate', url, cause, ...(truncated ? { truncated } : {}) });
    this.#add({
      kind: 'page',
      url,
      title: entry.title.slice(0, 400),
      text: entry.text.slice(0, 2000),
    });
  }

  /** 地址栏导航。前进后退刷新原因这份状态已经全部搬去了会话层，这里不需要再清什么。 */
  navigate(url: string): void {
    const clamped = clampUrl(url);
    this.#add({
      kind: 'navigate',
      url: clamped.url,
      cause: 'address',
      ...(clamped.truncated ? { truncated: true } : {}),
    });
  }

  note(text: string, onUrl?: string): void {
    this.#add({
      kind: 'note',
      text: text.slice(0, 2000),
      ...(onUrl ? { onUrl: clampUrl(onUrl).url } : {}),
    });
  }

  raw(event: RawEvent, observed?: Observation): void {
    if (event.kind === 'scroll') {
      this.#add({ kind: 'scroll', url: clampUrl(event.url).url, x: event.x, y: event.y });
      return;
    }
    if (event.kind === 'unsupported') {
      this.#add({
        kind: 'unsupported',
        url: clampUrl(event.url).url,
        reason: event.reason,
        ...(event.el ? { el: event.el } : {}),
      });
      return;
    }
    const { target, ambiguous } = this.#target(event.el, event.index, observed);
    const { kind, url, index, el, at, ...rest } = event;
    this.#add({
      kind,
      url: clampUrl(url).url,
      index,
      el,
      pageAt: at,
      target,
      ambiguous,
      ...rest,
    } as Unstamped<LoggedEvent>);
  }

  finish(): LoggedEvent[] {
    return [...this.#events];
  }

  #add(partial: Unstamped<LoggedEvent>): void {
    if (this.#events.length >= MAX_EVENTS || this.#bytes >= MAX_BYTES) {
      this.#capped = true;
      return;
    }
    const event = {
      seq: this.#events.length + 1,
      at: this.#now().toISOString(),
      ...partial,
    } as LoggedEvent;
    this.#bytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    this.#events.push(event);
    this.#projector.push(event);
  }

  #target(
    el: ElementDescription,
    index: number,
    observed: Observation | undefined,
  ): { target: StepTarget; ambiguous: boolean } {
    const row = observed?.elements[index];
    if (row && sameElement(row, el)) {
      const { target, duplicates } = toStepTarget(row, observed!.elements);
      return { target, ambiguous: duplicates > 1 };
    }
    return { target: fromDescription(el), ambiguous: Boolean(el.duplicates && el.duplicates > 1) };
  }
}
