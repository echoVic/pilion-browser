import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextRunAfter, previewRuns, ScheduleRuleSchema } from '../src/shared/schedule';

const PREV_TZ = process.env.TZ;
beforeAll(() => {
  // 固定美东时区，钉死夏令时跳变：
  // 2026 春令时 3/8 02:00 -> 03:00（2 点不存在）；2026 秋令时 11/1 02:00 -> 01:00（1 点重复）。
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  process.env.TZ = PREV_TZ;
});

function wall(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

describe('夏令时：春令时跳变', () => {
  it('daily 在不存在的时刻顺延到跳变后（2:30 落到 3:30）', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'daily', time: '02:30' });
    // 3/7 正午（EST）。
    const after = new Date('2026-03-07T12:00:00-05:00');
    expect(wall(nextRunAfter(rule, after))).toBe('2026-03-08 03:30');
  });

  it('cron 在不存在的时刻同样顺延，而不是跳过整天', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'cron', expr: '30 2 * * *' });
    const after = new Date('2026-03-07T12:00:00-05:00');
    expect(wall(nextRunAfter(rule, after))).toBe('2026-03-08 03:30');
  });
});

describe('夏令时：秋令时把重复的小时只触发一次', () => {
  it('daily 取第一次出现的 1:30，下一次直接是第二天', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'daily', time: '01:30' });
    const after = new Date('2026-10-31T12:00:00-04:00');
    const first = nextRunAfter(rule, after);
    expect(wall(first)).toBe('2026-11-01 01:30');
    // 不应再把当天第二次出现的 1:30（EST）当作一次新触发。
    expect(wall(nextRunAfter(rule, first))).toBe('2026-11-02 01:30');
  });

  it('cron preview 不重复同一天的重复小时', () => {
    const rule = ScheduleRuleSchema.parse({ kind: 'cron', expr: '30 1 * * *' });
    const after = new Date('2026-10-31T12:00:00-04:00');
    expect(previewRuns(rule, after, 3).map(wall)).toEqual([
      '2026-11-01 01:30',
      '2026-11-02 01:30',
      '2026-11-03 01:30',
    ]);
  });
});
