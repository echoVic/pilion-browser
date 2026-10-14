import { z } from 'zod';
import { PermissionModeSchema, type PermissionMode } from './contracts.js';

/**
 * 定时 prompt 的规则模型与下一次触发时间计算。
 *
 * 这里只做纯函数：不读时钟、不做 I/O，时间一律以传入的 `after` 为基准。
 * 调度是「墙上时钟」：所有计算都走 Date 的本地时间访问器（getHours/getDate/…），
 * 因此时区由运行进程的本地时区（或测试里固定的 TZ）决定。持久化只存 ISO 时间戳，
 * 真正的触发判定永远是 `nextRunAt <= now`，由主进程的 tick 负责。
 */

/** HH:MM（24 小时制）。 */
export const ScheduleTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, '时间格式应为 HH:MM');

/** 每 N 分钟 / 每 N 小时；任何单位换算后都不得小于 10 分钟。 */
export const IntervalRuleSchema = z
  .object({
    kind: z.literal('interval'),
    every: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    unit: z.enum(['minute', 'hour']),
  })
  .strict()
  .refine((rule) => intervalMinutes(rule) >= 10, '最小间隔为 10 分钟');
export const DailyRuleSchema = z
  .object({ kind: z.literal('daily'), time: ScheduleTimeSchema })
  .strict();

/** 指定星期（0=周日 … 6=周六）+ HH:MM；「工作日」就是 days = [1,2,3,4,5]。 */
export const WeekdaysRuleSchema = z
  .object({
    kind: z.literal('weekdays'),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: ScheduleTimeSchema,
  })
  .strict();

export const CronRuleSchema = z
  .object({
    kind: z.literal('cron'),
    /** 五段：分 时 日 月 周。不支持秒、年字段与 @reboot。 */
    expr: z.string().trim().min(1).max(120),
  })
  .strict()
  .refine((rule) => parseCron(rule.expr) !== null, '非法的 cron 表达式（应为 分 时 日 月 周）');

export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  IntervalRuleSchema,
  DailyRuleSchema,
  WeekdaysRuleSchema,
  CronRuleSchema,
]);
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

/** 这条任务是谁发起的：人从设置页，或某个 Agent 对话通过 MCP 创建。 */
export const ScheduleOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('agent'), conversationId: z.string().min(1).max(256) }).strict(),
]);
export type ScheduleOrigin = z.infer<typeof ScheduleOriginSchema>;

export const SCHEDULE_LIMIT = 20;
export const SCHEDULE_MIN_INTERVAL_MINUTES = 10;

export const ScheduleOutcomeSchema = z
  .object({
    status: z.enum(['ok', 'failed', 'skipped']),
    at: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export type ScheduleOutcome = z.infer<typeof ScheduleOutcomeSchema>;

/** 持久化到 userData/schedules.json 的一条定时任务。 */
export interface ScheduledPrompt {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  rule: ScheduleRule;
  enabled: boolean;
  origin: ScheduleOrigin;
  createdAt: string;
  lastRunAt?: string;
  /** 下次触发时间（ISO，本地墙上时钟语义）。 */
  nextRunAt: string;
  lastOutcome?: ScheduleOutcome;
  /** 本任务后台对话的权限模式；缺省/旧数据一律按 ask（操作前确认）。 */
  permissionMode: PermissionMode;
}

export const ScheduledPromptSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(120),
    agentId: z.string().min(1).max(256),
    prompt: z.string().min(1).max(100_000),
    rule: ScheduleRuleSchema,
    enabled: z.boolean(),
    origin: ScheduleOriginSchema,
    createdAt: z.string(),
    lastRunAt: z.string().optional(),
    nextRunAt: z.string(),
    lastOutcome: ScheduleOutcomeSchema.optional(),
    // 旧数据没有该字段：迁移为 ask，避免无人在场时自动执行浏览器操作。
    permissionMode: PermissionModeSchema.default('ask'),
  })
  .strict();

/** 创建/编辑时从渲染层或 MCP 提交的载荷（id/时间戳由主进程补）。 */
export const ScheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    agentId: z.string().min(1).max(256),
    prompt: z.string().trim().min(1).max(100_000),
    rule: ScheduleRuleSchema,
    enabled: z.boolean().default(true),
    // 人从设置页可选 full；Agent 经 MCP 创建时主进程会强制改回 ask（见 runScheduleTool）。
    // 缺省在 store.create 里落为 ask。
    permissionMode: PermissionModeSchema.optional(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export const ScheduleSetEnabledSchema = z
  .object({ id: z.string().min(1).max(256), enabled: z.boolean() })
  .strict();
export const SchedulePreviewSchema = z.object({ rule: ScheduleRuleSchema }).strict();

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function intervalMinutes(rule: { every: number; unit: 'minute' | 'hour' }): number {
  return rule.unit === 'hour' ? rule.every * 60 : rule.every;
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':').map((part) => Number(part));
  return { hour, minute };
}

/** 人类可读的规则摘要，用于设置页与审批。 */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'interval': {
      const minutes = intervalMinutes(rule);
      if (rule.unit === 'hour') return `每 ${rule.every} 小时（≈每 ${minutes} 分钟）`;
      return `每 ${rule.every} 分钟`;
    }
    case 'daily':
      return `每天 ${rule.time}`;
    case 'weekdays': {
      const days = [...rule.days]
        .sort()
        .map((day) => WEEKDAY_LABELS[day])
        .join('、');
      return `每 ${days} ${rule.time}`;
    }
    case 'cron':
      return `cron：${rule.expr.trim()}`;
    default: {
      const exhaustive: never = rule;
      throw new Error(`未知规则类型：${String(exhaustive)}`);
    }
  }
}

interface CronExpr {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** 日/周是否被「限定」（而非 * 或全域步进），决定二者走 OR 还是 AND。 */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const CRON_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week
] as const;

/** 解析单个 cron 字段；非法时返回 null。支持全域、步进、单值、区间与逗号并列。 */
function parseCronField(
  raw: string,
  min: number,
  max: number,
): { values: number[]; restricted: boolean } | null {
  const out = new Set<number>();
  const restricted = raw !== '*' && !/^\*\/\d+$/.test(raw);
  for (const part of raw.split(',')) {
    let step = 1;
    let rangePart = part;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      rangePart = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const dash = rangePart.indexOf('-');
      if (dash >= 0) {
        lo = Number(rangePart.slice(0, dash));
        hi = Number(rangePart.slice(dash + 1));
      } else {
        if (!/^\d+$/.test(rangePart)) return null;
        lo = hi = Number(rangePart);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let value = lo; value <= hi; value += step) out.add(value);
  }
  return { values: [...out].sort((a, b) => a - b), restricted };
}

/** 解析并校验五段 cron；非法（段数不对、字段越界、无解）返回 null。 */
export function parseCron(expr: string): CronExpr | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: { values: number[]; restricted: boolean }[] = [];
  for (let index = 0; index < 5; index++) {
    const parsed = parseCronField(parts[index], CRON_RANGES[index].min, CRON_RANGES[index].max);
    if (!parsed) return null;
    fields.push(parsed);
  }
  return {
    minute: fields[0].values,
    hour: fields[1].values,
    dom: fields[2].values,
    month: fields[3].values,
    dow: fields[4].values,
    domRestricted: fields[2].restricted,
    dowRestricted: fields[4].restricted,
  };
}

/** 某天是否命中 cron 的「日/周」约束：两者都受限时走 OR，只一个受限时按那个。 */
function cronDayMatches(day: Date, cron: CronExpr): boolean {
  const domMatch = cron.dom.includes(day.getDate());
  const dowMatch = cron.dow.includes(day.getDay());
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  if (cron.domRestricted) return domMatch;
  if (cron.dowRestricted) return dowMatch;
  return true;
}

/**
 * 从 `after`（含）之后找下一次命中 cron 的时刻。
 *
 * 以「天」为粒度：先判断 dom/dow，再枚举该天命中的 (hour, minute)。候选时刻用
 * `new Date(y,m,d,hour,minute)` 构造——本地时区在春令时跳变会把不存在的时刻顺延到跳变后
 * （与 Vixie cron 一致，例如 2:30 在 2 点消失的那天落到 3:30）；秋令时把重复的小时固定取
 * 第一次，且按天步进，同一墙上时刻一天只触发一次。
 */
function nextCronRun(after: Date, cron: CronExpr): Date {
  for (let dayOffset = 0; dayOffset <= 366; dayOffset += 1) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + dayOffset);
    if (!cronDayMatches(day, cron)) continue;
    for (const hour of cron.hour) {
      for (const minute of cron.minute) {
        const candidate = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          hour,
          minute,
          0,
          0,
        );
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }
  throw new Error('cron 表达式在一年内没有可触发的时间');
}

/** 在「每天 hour:minute 且 dayMatches」的规则下，找 after 之后第一次命中的时刻。 */
function nextWallClockRun(
  after: Date,
  hour: number,
  minute: number,
  dayMatches: (day: Date) => boolean,
): Date {
  const base = new Date(after);
  base.setHours(hour, minute, 0, 0);
  for (let offsetDays = 0; offsetDays < 400; offsetDays += 1) {
    const candidate = new Date(base);
    candidate.setDate(base.getDate() + offsetDays);
    if (candidate.getTime() > after.getTime() && dayMatches(candidate)) return candidate;
  }
  throw new Error('没有可触发的时间');
}

/** 计算 `after` 之后规则的下一次触发时刻（本地墙上时钟，严格晚于 after）。 */
export function nextRunAfter(rule: ScheduleRule, after: Date): Date {
  switch (rule.kind) {
    case 'interval': {
      return new Date(after.getTime() + intervalMinutes(rule) * 60_000);
    }
    case 'daily': {
      const { hour, minute } = parseTime(rule.time);
      return nextWallClockRun(after, hour, minute, () => true);
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(rule.time);
      const days = new Set(rule.days);
      return nextWallClockRun(after, hour, minute, (day) => days.has(day.getDay()));
    }
    case 'cron': {
      const cron = parseCron(rule.expr);
      if (!cron) throw new Error('非法的 cron 表达式');
      return nextCronRun(after, cron);
    }
    default: {
      const exhaustive: never = rule;
      throw new Error(`未知规则类型：${String(exhaustive)}`);
    }
  }
}

/** 预览 `after` 之后接下来的 `count` 次触发时间。 */
export function previewRuns(rule: ScheduleRule, after: Date, count = 3): Date[] {
  const runs: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    cursor = nextRunAfter(rule, cursor);
    runs.push(cursor);
  }
  return runs;
}
