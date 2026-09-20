import { z } from 'zod';
import type { Observation } from '../browser/types.js';
import { PressKeySchema } from '../../shared/contracts.js';
import { toStepTarget } from './resolve.js';
import {
  TrajectorySchema,
  type Step,
  type StepTarget,
  type Trajectory,
  type TrajectoryEntry,
  UNSUPPORTED_REASONS,
} from './types.js';

/** observe 截断到 200 个元素，序号在此之后的目标回放永远够不到。 */
const OBSERVE_LIMIT = 200;
const DOUBLE_CLICK_MS = 400;

const ElementDescriptionSchema = z
  .object({
    tagName: z.string().min(1).max(40),
    role: z.string().max(120),
    name: z.string().max(400),
    inputType: z.string().max(40).optional(),
    optionValues: z.array(z.string().max(10_000)).max(200).optional(),
    checked: z.boolean().optional(),
    duplicates: z.number().int().min(1).max(10_000).optional(),
    position: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();
type ElementDescription = z.infer<typeof ElementDescriptionSchema>;

const base = {
  url: z.string().max(8192),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  at: z.number(),
};
export const RawEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), ...base }).strict(),
  z.object({ kind: z.literal('click'), ...base }).strict(),
  z.object({ kind: z.literal('input'), ...base, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('select'), ...base, value: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal('check'), ...base, checked: z.boolean() }).strict(),
  z.object({ kind: z.literal('key'), ...base, key: PressKeySchema, shift: z.boolean() }).strict(),
  z.object({ kind: z.literal('secret'), ...base, otp: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('unsupported'),
      url: z.string().max(8192),
      reason: z.enum(['iframe', 'out-of-scope', 'gesture']),
      el: ElementDescriptionSchema.optional(),
      at: z.number(),
    })
    .strict(),
]);
export type RawEvent = z.infer<typeof RawEventSchema>;

type Pending = {
  index: number;
  target: StepTarget;
  text: string;
  onUrl: string;
  ambiguous: boolean;
};
type Pointer = { index: number; url: string; target: StepTarget; ambiguous: boolean };

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
 * 脚本只发原始事件；这里把它们变成人读得懂、player 播得动的步骤。
 * 纯函数式状态机，不碰 Electron，所以中文输入法、双击、mousedown 即跳转这些细节都能用单测钉住。
 */
export class TrajectoryRecorder {
  readonly #name: string;
  readonly #now: () => Date;
  readonly #startedAt: string;
  readonly #entries: TrajectoryEntry[] = [];
  #currentUrl = '';
  #pending: Pending | undefined;
  #pointer: Pointer | undefined;
  #lastClick: { index: number; at: number } | undefined;
  #lastSecretIndex: number | undefined;

  constructor(options: { name: string; now?: () => Date }) {
    this.#name = options.name;
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now().toISOString();
  }

  get counts(): { steps: number; unsupported: number } {
    const steps = this.#entries.filter((entry) => entry.kind === 'step');
    return {
      steps: steps.length + (this.#pending ? 1 : 0),
      unsupported: steps.filter((entry) => entry.unsupported).length,
    };
  }

  page(entry: { url: string; title: string; text: string }): void {
    this.#flushPending();
    this.#flushPointerAsClick(entry.url);
    this.#currentUrl = entry.url;
    this.#entries.push({
      kind: 'page',
      at: this.#stamp(),
      url: entry.url,
      title: entry.title.slice(0, 400),
      text: entry.text.slice(0, 2000),
    });
  }

  navigate(url: string): void {
    this.#flushPending();
    this.#pointer = undefined;
    this.#push({ kind: 'navigate', url });
  }

  note(text: string): void {
    this.#push({
      kind: 'note',
      text: text.slice(0, 2000),
      ...(this.#currentUrl ? { onUrl: this.#currentUrl } : {}),
    });
  }

  raw(event: RawEvent, observed?: Observation): void {
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
        { kind: 'human', onUrl: this.#onUrl(event.url), reason: why },
        { unsupported: event.reason },
      );
      return;
    }
    const { target, ambiguous } = this.#target(event.el, event.index, observed);
    const onUrl = this.#onUrl(event.url);
    const beyond = event.index >= OBSERVE_LIMIT || event.index < 0;
    if (beyond && event.kind !== 'secret') {
      this.#flushPending();
      this.#push(
        { kind: 'human', onUrl, reason: `手动完成对 "${target.name || target.tagName}" 的操作` },
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
        this.#pointer = { index: event.index, url: onUrl, target, ambiguous };
        return;
      case 'click': {
        this.#pointer = undefined;
        if (
          this.#lastClick &&
          this.#lastClick.index === event.index &&
          event.at - this.#lastClick.at <= DOUBLE_CLICK_MS
        )
          return;
        this.#lastClick = { index: event.index, at: event.at };
        this.#push({ kind: 'click', onUrl, target }, { ambiguous });
        return;
      }
      case 'input':
        if (this.#pending && this.#pending.index !== event.index) this.#flushPending();
        this.#pointer = undefined;
        this.#pending = { index: event.index, target, text: event.value, onUrl, ambiguous };
        return;
      case 'select':
        this.#push({ kind: 'select', onUrl, target, value: event.value }, { ambiguous });
        return;
      case 'check':
        this.#push({ kind: 'check', onUrl, target, checked: event.checked }, { ambiguous });
        return;
      case 'key':
        this.#push(
          { kind: 'press', onUrl, target, key: event.key, modifiers: event.shift ? ['Shift'] : [] },
          { ambiguous },
        );
        return;
      case 'secret':
        if (this.#lastSecretIndex === event.index) return;
        this.#lastSecretIndex = event.index;
        this.#push({ kind: 'human', onUrl, reason: event.otp ? '填写验证码' : '填写密码' });
        return;
    }
  }

  finish(): Trajectory {
    this.#flushPending();
    this.#pointer = undefined;
    return TrajectorySchema.parse({
      meta: { app: 'pilion', version: 1, name: this.#name, recordedAt: this.#startedAt },
      entries: this.#entries,
    });
  }

  #onUrl(eventUrl: string): string {
    return this.#currentUrl || eventUrl || 'about:blank';
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #push(
    step: Step,
    marks: { unsupported?: (typeof UNSUPPORTED_REASONS)[number]; ambiguous?: boolean } = {},
  ): void {
    this.#entries.push({
      kind: 'step',
      at: this.#stamp(),
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
    this.#push(
      { kind: 'click', onUrl: pointer.url, target: pointer.target },
      { ambiguous: pointer.ambiguous },
    );
  }

  #target(
    el: ElementDescription,
    index: number,
    observed: Observation | undefined,
  ): { target: StepTarget; ambiguous: boolean } {
    const row = observed?.elements[index];
    if (row && row.tagName === el.tagName) {
      const { target, duplicates } = toStepTarget(row, observed!.elements);
      return { target, ambiguous: duplicates > 1 };
    }
    return { target: fromDescription(el), ambiguous: Boolean(el.duplicates && el.duplicates > 1) };
  }
}
