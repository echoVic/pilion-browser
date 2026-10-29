import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeRule,
  nextRunAfter,
  parseCron,
  previewRuns,
  ScheduleRuleSchema,
  type ScheduleRule,
} from '../src/shared/schedule';

const PREV_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  process.env.TZ = PREV_TZ;
});

/** 2026-10-13 是周二，UTC+8。 */
const NOW = new Date('2026-10-13T09:30:00+08:00');

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

describe('interval', () => {
  it('is relative and advances by the configured minutes', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'interval', every: 30, unit: 'minute' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-13 10:00');
  });
  it('converts hours to minutes', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'interval', every: 2, unit: 'hour' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-13 11:30');
  });
  it('enforces the 10-minute floor', () => {
    expect(
      ScheduleRuleSchema.safeParse({ kind: 'interval', every: 5, unit: 'minute' }).success,
    ).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'interval', every: 1, unit: 'hour' }).success).toBe(
      true,
    );
  });
});

describe('daily', () => {
  it('fires later today when the time is in the future', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'daily', time: '18:00' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-13 18:00');
  });
  it('rolls to the next day when the time already passed today', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'daily', time: '08:00' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-14 08:00');
  });
  it('crosses month boundaries', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'daily', time: '09:00' });
    const endOfMonth = new Date('2026-10-31T23:00:00+08:00');
    expect(iso(nextRunAfter(rule, endOfMonth))).toBe('2026-11-01 09:00');
  });
});

describe('weekdays', () => {
  it('skips the weekend when only weekdays are selected', () => {
    const rule = ScheduleRuleSchema.parse({
      kind: 'weekdays',
      days: [1, 2, 3, 4, 5],
      time: '09:00',
    });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-14 09:00');
  });
  it('jumps over the whole weekend to Monday', () => {
    const rule = ScheduleRuleSchema.parse({
      kind: 'weekdays',
      days: [1, 2, 3, 4, 5],
      time: '09:00',
    });
    const saturday = new Date('2026-10-17T10:00:00+08:00');
    expect(iso(nextRunAfter(rule, saturday))).toBe('2026-10-19 09:00');
  });
  it('honors an explicit weekday selection', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'weekdays', days: [0], time: '10:00' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-18 10:00');
  });
});

describe('cron parsing', () => {
  it('accepts standard five-field expressions', () => {
    expect(parseCron('*/15 9-18 * * 1-5')?.minute).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 8 1 * *')?.dom).toEqual([1]);
  });
  it('rejects wrong field count, out-of-range and garbage', () => {
    for (const bad of [
      '*/15 * * *',
      '0 25 * * *',
      '0 0 32 * *',
      '0 0 * * 8',
      '@reboot',
      '0 0 * * * *',
      'every day',
    ])
      expect(parseCron(bad), bad).toBeNull();
  });
  it('rejects unsatisfiable or malformed input at the schema level', () => {
    expect(ScheduleRuleSchema.safeParse({ kind: 'cron', expr: '0 0 * * 9' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'cron', expr: 'every day' }).success).toBe(false);
  });
  it('computes the next weekday 09:00 with cron', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'cron', expr: '0 9 * * 1-5' });
    expect(iso(nextRunAfter(rule, NOW))).toBe('2026-10-14 09:00');
  });
  it('combines day-of-month and day-of-week with OR semantics', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'cron', expr: '30 7 1 * 1' });
    const runs = previewRuns(rule, NOW, 3).map(iso);
    expect(runs).toEqual(['2026-10-19 07:30', '2026-10-26 07:30', '2026-11-01 07:30']);
  });
});

describe('preview and description', () => {
  it('previews the next three fires for a daily rule', () => {
    const rule: ScheduleRule = { kind: 'daily', time: '09:00' };
    expect(previewRuns(rule, NOW, 3).map(iso)).toEqual([
      '2026-10-14 09:00',
      '2026-10-15 09:00',
      '2026-10-16 09:00',
    ]);
  });
  it('describes rules in Chinese', () => {
    expect(describeRule({ kind: 'daily', time: '09:00' })).toBe('每天 09:00');
    expect(describeRule({ kind: 'interval', every: 30, unit: 'minute' })).toBe('每 30 分钟');
  });
});

describe('DST boundary (America/New_York)', () => {
  it('yields a wall-clock time on the spring-forward day without crashing', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const rule: ScheduleRule = { kind: 'daily', time: '02:30' };
      const before = new Date('2026-03-08T00:30:00-05:00');
      const fired = nextRunAfter(rule, before);
      expect(fired.getHours()).toBeGreaterThanOrEqual(2);
      expect(fired.getDate() === 8 || fired.getDate() === 9).toBe(true);
      const fallback = nextRunAfter(
        { kind: 'daily', time: '02:30' },
        new Date('2026-10-31T20:00:00-04:00'),
      );
      expect(fallback.getDate()).toBe(1);
    } finally {
      process.env.TZ = previous;
    }
  });
});
