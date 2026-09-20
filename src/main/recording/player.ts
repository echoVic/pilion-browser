import type { Observation, PageSnapshot } from '../browser/types.js';
import type { ToolName } from '../../shared/contracts.js';
import { describeStep } from './format.js';
import { resolveTarget } from './resolve.js';
import type { Step } from './types.js';

export type PlayerExecute = (name: ToolName, args: Record<string, unknown>) => Promise<unknown>;
export type PlayFailure =
  'WRONG_PAGE' | 'NO_MATCH' | 'AMBIGUOUS' | 'EFFECT_FAILED' | 'TIMEOUT' | 'CANCELLED';
export type PlayOutcome =
  | { ok: true; steps: number; finalUrl: string }
  | {
      ok: false;
      reason: 'HUMAN';
      at: number;
      step: string;
      humanReason: string;
      url: string;
      title: string;
    }
  | {
      ok: false;
      reason: PlayFailure;
      failedAt: number;
      step: string;
      url: string;
      title: string;
      remaining: string[];
      message?: string;
    };

export interface PlayOptions {
  execute: PlayerExecute;
  /** 1 起。 */
  fromStep?: number;
  signal?: AbortSignal;
  /** 整场预算，留在 10 分钟 prompt 上限内。 */
  budgetMs?: number;
  /** 导航或点击之后等 loading 变 false 的上限。 */
  settleMs?: number;
  onProgress?(step: number, total: number): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const DEFAULT_BUDGET_MS = 4 * 60_000;
const DEFAULT_SETTLE_MS = 15_000;
const SETTLE_POLL_MS = 200;

/** 前置条件只比 origin 与 path；query 与 hash 常随会话变化，不该让回放停下。 */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/';
    return left.origin === right.origin && path(left) === path(right);
  } catch {
    return false;
  }
}

const TOOL_FOR: Record<'click' | 'type' | 'select' | 'check' | 'press', ToolName> = {
  click: 'browser.click',
  type: 'browser.type',
  select: 'browser.select',
  check: 'browser.check',
  press: 'browser.press',
};

function effectArgs(step: Step): Record<string, unknown> {
  switch (step.kind) {
    case 'type':
      return { text: step.text, replace: true };
    case 'select':
      return { value: step.value };
    case 'check':
      return { checked: step.checked };
    case 'press':
      return { key: step.key, modifiers: step.modifiers };
    default:
      return {};
  }
}

/**
 * 逐步执行：断言页面 → observe → 匹配 → 用与 Agent 相同的工具执行。
 * 任何一步解析不到目标就停下并把现场交出去，不猜。
 */
export async function playSteps(
  steps: ReadonlyArray<Step>,
  options: PlayOptions,
): Promise<PlayOutcome> {
  const execute = options.execute;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const total = steps.length;
  let lastUrl = '';

  const snapshot = async (): Promise<PageSnapshot> =>
    (await execute('browser.snapshot', {})) as PageSnapshot;
  const settle = async () => {
    await sleep(50);
    const until = now() + settleMs;
    for (;;) {
      const current = await snapshot();
      lastUrl = current.url;
      if (!current.loading || now() >= until) return current;
      await sleep(SETTLE_POLL_MS);
    }
  };
  const remaining = (index: number) => steps.slice(index).map(describeStep);
  const fail = async (
    index: number,
    reason: PlayFailure,
    step: Step,
    message?: string,
    page?: PageSnapshot,
  ): Promise<PlayOutcome> => {
    const current =
      page ?? (await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false })));
    return {
      ok: false,
      reason,
      failedAt: index,
      step: describeStep(step),
      url: current.url,
      title: current.title,
      remaining: remaining(index),
      ...(message ? { message } : {}),
    };
  };

  for (let index = options.fromStep ?? 1; index <= total; index += 1) {
    const step = steps[index - 1];
    options.onProgress?.(index, total);
    if (options.signal?.aborted) return fail(index, 'CANCELLED', step);
    if (now() > deadline) return fail(index, 'TIMEOUT', step);
    if (step.kind === 'note') continue;
    if (step.kind === 'human') {
      const current = await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false }));
      return {
        ok: false,
        reason: 'HUMAN',
        at: index,
        step: describeStep(step),
        humanReason: step.reason,
        url: current.url,
        title: current.title,
      };
    }
    if (step.kind === 'navigate') {
      try {
        await execute('browser.navigate', { url: step.url });
      } catch (error) {
        return fail(
          index,
          'EFFECT_FAILED',
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
      await settle();
      continue;
    }
    const page = await snapshot();
    lastUrl = page.url;
    if (!samePage(page.url, step.onUrl)) return fail(index, 'WRONG_PAGE', step, undefined, page);
    const observation = (await execute('browser.observe', {})) as Observation;
    const resolved = resolveTarget(step.target, observation);
    if (!resolved.ok) return fail(index, resolved.reason, step, undefined, page);
    if (options.signal?.aborted) return fail(index, 'CANCELLED', step, undefined, page);
    try {
      await execute(TOOL_FOR[step.kind], { elementRef: resolved.ref, ...effectArgs(step) });
    } catch (error) {
      return fail(
        index,
        'EFFECT_FAILED',
        step,
        error instanceof Error ? error.message : String(error),
        page,
      );
    }
    if (step.kind === 'click' || step.kind === 'press') await settle();
  }
  const finalPage = await snapshot().catch(() => ({ url: lastUrl, title: '', loading: false }));
  return { ok: true, steps: total, finalUrl: finalPage.url };
}
