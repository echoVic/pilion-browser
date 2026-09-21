import { z } from 'zod';
import { PressKeySchema, PressModifierSchema } from '../../shared/contracts.js';

const url = z.string().min(1).max(8192);

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
        version: z.literal(1),
        name: z.string().min(1).max(120),
        recordedAt: z.string().min(1).max(64),
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
