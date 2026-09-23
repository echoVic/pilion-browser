import { z } from 'zod';
import { PressKeySchema, PressModifierSchema } from '../../shared/contracts.js';

/** 地址字段的统一上限；页面脚本通过模板注入同一个值，采集层与投影层也都认它。 */
export const MAX_URL_LENGTH = 8192;
const url = z.string().min(1).max(MAX_URL_LENGTH);

export const StepTargetSchema = z
  .object({
    role: z.string().min(1).max(120),
    name: z.string().max(400),
    tagName: z.string().min(1).max(40),
    inputType: z.string().max(40).optional(),
    optionValues: z.array(z.string().max(10_000)).max(200).optional(),
    /** 只在 role + name + tagName 完全相同的候选多于一个时出现，按文档顺序第几个，从 1 起。 */
    nth: z.number().int().min(1).max(200).optional(),
    /** localFingerprint 的前 8 位十六进制，匹配的第 0 层。 */
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .optional(),
  })
  .strict();
export type StepTarget = z.infer<typeof StepTargetSchema>;

export const ElementDescriptionSchema = z
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
export type ElementDescription = z.infer<typeof ElementDescriptionSchema>;

/** 页面脚本发过来的原始事件；`at` 是页面时钟。 */
const rawBase = {
  url: z.string().max(MAX_URL_LENGTH),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  at: z.number(),
};
export const RawEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), ...rawBase }).strict(),
  z.object({ kind: z.literal('click'), ...rawBase }).strict(),
  z.object({ kind: z.literal('input'), ...rawBase, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('select'), ...rawBase, value: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal('check'), ...rawBase, checked: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('key'), ...rawBase, key: PressKeySchema, shift: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('secret'), ...rawBase, otp: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('edit'), ...rawBase, length: z.number().int().min(0).max(1_000_000) })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      url: z.string().max(MAX_URL_LENGTH),
      at: z.number(),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unsupported'),
      url: z.string().max(MAX_URL_LENGTH),
      reason: z.enum(['iframe', 'out-of-scope', 'gesture']),
      el: ElementDescriptionSchema.optional(),
      at: z.number(),
    })
    .strict(),
]);
export type RawEvent = z.infer<typeof RawEventSchema>;

export const NAVIGATE_CAUSES = ['address', 'back', 'forward', 'reload'] as const;

/**
 * 落盘的一条过程记录。`at` 是采集层用主进程时钟打的，投影原样抄进条目，
 * 所以投影里不需要、也不许有时钟；`pageAt` 保留页面时钟，双击折叠比的是它。
 */
const stamped = {
  seq: z.number().int().min(1).max(1_000_000),
  at: z.string().min(1).max(64),
};
const loggedElement = {
  ...stamped,
  url: z.string().max(MAX_URL_LENGTH),
  index: z.number().int().min(-1).max(1_000_000),
  el: ElementDescriptionSchema,
  pageAt: z.number(),
  /**
   * 采集时解析出来的目标：先拿实时 observe 那一行，对不上就退回脚本的描述。
   * 两条路都有结果，所以这里是必填的 —— 投影层因此没有任何回退分支，也就不需要 `fromDescription`。
   */
  target: StepTargetSchema,
  ambiguous: z.boolean(),
};
export const LoggedEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...stamped,
      kind: z.literal('page'),
      url,
      title: z.string().max(400),
      text: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('navigate'),
      url,
      cause: z.enum(NAVIGATE_CAUSES),
      /** 地址超过 MAX_URL_LENGTH 被截断过：投影据此产出「需要我」，不能当真实导航回放。 */
      truncated: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('note'),
      text: z.string().max(2000),
      onUrl: url.optional(),
    })
    .strict(),
  z.object({ ...loggedElement, kind: z.literal('pointer') }).strict(),
  z.object({ ...loggedElement, kind: z.literal('click') }).strict(),
  z.object({ ...loggedElement, kind: z.literal('input'), value: z.string().max(100_000) }).strict(),
  z.object({ ...loggedElement, kind: z.literal('select'), value: z.string().max(10_000) }).strict(),
  z.object({ ...loggedElement, kind: z.literal('check'), checked: z.boolean() }).strict(),
  z
    .object({ ...loggedElement, kind: z.literal('key'), key: PressKeySchema, shift: z.boolean() })
    .strict(),
  z.object({ ...loggedElement, kind: z.literal('secret'), otp: z.boolean() }).strict(),
  z
    .object({
      ...loggedElement,
      kind: z.literal('edit'),
      length: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('scroll'),
      url: z.string().max(MAX_URL_LENGTH),
      x: z.number(),
      y: z.number(),
    })
    .strict(),
  z
    .object({
      ...stamped,
      kind: z.literal('unsupported'),
      url: z.string().max(MAX_URL_LENGTH),
      reason: z.enum(['iframe', 'out-of-scope', 'gesture']),
      el: ElementDescriptionSchema.optional(),
    })
    .strict(),
]);
export type LoggedEvent = z.infer<typeof LoggedEventSchema>;

export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url }).strict(),
  z.object({ kind: z.literal('click'), onUrl: url, target: StepTargetSchema }).strict(),
  z
    .object({
      kind: z.literal('type'),
      onUrl: url,
      target: StepTargetSchema,
      text: z.string().max(100_000),
      /** 录制记的是字段最终值而非增量，回放整体覆盖。 */
      replace: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      onUrl: url,
      target: StepTargetSchema,
      value: z.string().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      onUrl: url,
      target: StepTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('press'),
      onUrl: url,
      target: StepTargetSchema,
      key: PressKeySchema,
      modifiers: z.array(PressModifierSchema).max(1).default([]),
    })
    .strict(),
  z.object({ kind: z.literal('human'), onUrl: url, reason: z.string().min(1).max(500) }).strict(),
  z
    .object({
      kind: z.literal('note'),
      onUrl: url.optional(),
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export const UNSUPPORTED_REASONS = [
  'iframe',
  'out-of-scope',
  'gesture',
  'beyond-observe-limit',
  'rich-text',
  'url-too-long',
] as const;

export const PageEntrySchema = z
  .object({
    kind: z.literal('page'),
    at: z.string().min(1).max(64),
    url,
    title: z.string().max(400),
    text: z.string().max(2000),
  })
  .strict();

export const RecordedStepSchema = z
  .object({
    kind: z.literal('step'),
    at: z.string().min(1).max(64),
    step: StepSchema,
    /** 录制当场判定：这一步回放不了，原因是什么。 */
    unsupported: z.enum(UNSUPPORTED_REASONS).optional(),
    /** 录制当时那份 observe 里这个描述就不唯一。 */
    ambiguous: z.boolean().optional(),
  })
  .strict();

export const TrajectoryEntrySchema = z.discriminatedUnion('kind', [
  PageEntrySchema,
  RecordedStepSchema,
]);
export type TrajectoryEntry = z.infer<typeof TrajectoryEntrySchema>;

export const TrajectorySchema = z
  .object({
    meta: z
      .object({
        app: z.literal('pilion'),
        version: z.union([z.literal(1), z.literal(2)]),
        name: z.string().min(1).max(120),
        recordedAt: z.string().min(1).max(64),
        /**
         * 有日志时指向它：条数、全文 sha256，以及 entries 数组自己的 sha256。没有这一段的
         * 就是第一期的老录制。两个哈希各管各的：hash 对不上说明日志换了，entriesHash 对不上
         * 说明 entries 被单独动过（比如手改这个文件的步骤块）——只查前者查不出后一种篡改，
         * 因为改 entries 从不触碰 events.jsonl。entriesHash 是可选的，好让缺它的旧版 v2
         * 轨迹仍然能解析，由读取时的比对把「缺失」当成一种不合就自愈重算。
         */
        source: z
          .object({
            events: z.number().int().min(0).max(20_000),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            entriesHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    entries: z.array(TrajectoryEntrySchema).max(2000),
  })
  .strict();
export type Trajectory = z.infer<typeof TrajectorySchema>;

/** 占位符的唯一判定处：提炼用它隐去个人数据，回放到这一步交给人。 */
export const PLACEHOLDER_PATTERN = /^\{\{[^{}]{1,60}\}\}$/;
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

export const SkillSchema = z
  .object({
    meta: z
      .object({
        app: z.literal('pilion'),
        version: z.literal(1),
        kind: z.literal('skill'),
        name: z.string().min(1).max(120),
        about: z.string().max(200),
        recordedAt: z.string().min(1).max(64),
        /** 提炼它的 Agent 配置 id；人手工创建时为 'person'。 */
        distilledBy: z.string().min(1).max(120),
        trajectory: z.literal('trajectory.md'),
      })
      .strict(),
    steps: z.array(StepSchema).max(500),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;
