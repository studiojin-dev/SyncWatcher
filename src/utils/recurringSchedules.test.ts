import { describe, expect, it } from 'vitest';
import {
  buildCronExpressionFromPreset,
  normalizeRecurringSchedule,
  parseCronExpressionToBuilder,
} from './recurringSchedules';

describe('recurringSchedules utilities', () => {
  it('normalizes recurring schedules with defaults', () => {
    expect(
      normalizeRecurringSchedule({
        id: 'schedule-1',
        cronExpression: ' 15   9  * * 1,3 ',
        timezone: 'Asia/Seoul',
      }),
    ).toEqual({
      id: 'schedule-1',
      cronExpression: '15 9 * * 1,3',
      timezone: 'Asia/Seoul',
      enabled: true,
      checksumMode: false,
      retentionCount: 20,
    });
  });

  it('round-trips recognized weekly cron expressions through builder mode', () => {
    const parsed = parseCronExpressionToBuilder('15 9 * * 1,3');
    expect(parsed).toEqual({
      preset: 'weekly',
      time: '09:15',
      weekdays: ['1', '3'],
      dayOfMonth: '1',
    });
    expect(buildCronExpressionFromPreset(parsed!)).toBe('15 9 * * 1,3');
  });

  it('round-trips hourly presets through minute-only builder time', () => {
    expect(parseCronExpressionToBuilder('5 * * * *')).toEqual({
      preset: 'hourly',
      time: '00:05',
      weekdays: [],
      dayOfMonth: '1',
    });

    expect(
      buildCronExpressionFromPreset({
        preset: 'hourly',
        time: '00:05',
        weekdays: [],
        dayOfMonth: '1',
      }),
    ).toBe('5 * * * *');
  });

  it('handles monthly presets', () => {
    expect(
      buildCronExpressionFromPreset({
        preset: 'monthly',
        time: '23:00',
        weekdays: [],
        dayOfMonth: '30',
      }),
    ).toBe('0 23 30 * *');
  });

  it('returns null for custom cron expressions that do not fit preset UI', () => {
    expect(parseCronExpressionToBuilder('*/15 9-17 * * 1-5')).toBeNull();
  });
});
