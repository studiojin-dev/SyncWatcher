export const DEFAULT_RECURRING_SCHEDULE_RETENTION_COUNT = 20;
export const MIN_RECURRING_SCHEDULE_RETENTION_COUNT = 1;
export const MAX_RECURRING_SCHEDULE_RETENTION_COUNT = 200;

export type RecurringSchedulePreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface RecurringSchedule {
  id: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  checksumMode: boolean;
  retentionCount: number;
}

export interface RecurringScheduleHistoryDetailEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
}

export interface RecurringScheduleHistoryEntry {
  scheduledFor: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'failure';
  checksumMode: boolean;
  cronExpression: string;
  timezone: string;
  message: string;
  errorDetail?: string | null;
  conflictCount: number;
  detailEntries: RecurringScheduleHistoryDetailEntry[];
}

export interface ParsedRecurringScheduleBuilder {
  preset: Exclude<RecurringSchedulePreset, 'custom'>;
  time: string;
  weekdays: string[];
  dayOfMonth: string;
}

export function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function normalizeCronExpression(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function clampRetentionCount(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_RECURRING_SCHEDULE_RETENTION_COUNT;
  }

  return Math.min(
    MAX_RECURRING_SCHEDULE_RETENTION_COUNT,
    Math.max(MIN_RECURRING_SCHEDULE_RETENTION_COUNT, Math.trunc(value)),
  );
}

export function normalizeRecurringSchedule(
  schedule: Partial<RecurringSchedule> & Pick<RecurringSchedule, 'id'>,
): RecurringSchedule {
  return {
    id: schedule.id,
    cronExpression: normalizeCronExpression(schedule.cronExpression ?? '0 9 * * *'),
    timezone: schedule.timezone?.trim() || getSystemTimezone(),
    enabled: schedule.enabled ?? true,
    checksumMode: schedule.checksumMode ?? false,
    retentionCount: clampRetentionCount(schedule.retentionCount),
  };
}

export function normalizeRecurringSchedules(
  schedules?: Array<Partial<RecurringSchedule> & Pick<RecurringSchedule, 'id'>> | null,
): RecurringSchedule[] {
  return (schedules ?? []).map(normalizeRecurringSchedule);
}

function parseTime(time: string): { hour: string; minute: string } {
  const [hour = '00', minute = '00'] = time.split(':');
  return {
    hour: hour.padStart(2, '0'),
    minute: minute.padStart(2, '0'),
  };
}

function sortWeekdays(weekdays: string[]): string[] {
  const seen = new Set<string>();
  return weekdays
    .map((day) => (day === '7' ? '0' : day))
    .filter((day) => /^[0-6]$/.test(day))
    .sort((left, right) => Number(left) - Number(right))
    .filter((day) => {
      if (seen.has(day)) {
        return false;
      }
      seen.add(day);
      return true;
    });
}

export function buildCronExpressionFromPreset(builder: ParsedRecurringScheduleBuilder): string {
  const { hour, minute } = parseTime(builder.time);

  switch (builder.preset) {
    case 'hourly':
      return `${Number(minute)} * * * *`;
    case 'daily':
      return `${Number(minute)} ${Number(hour)} * * *`;
    case 'weekly': {
      const weekdays = sortWeekdays(builder.weekdays);
      return `${Number(minute)} ${Number(hour)} * * ${weekdays.join(',') || '1'}`;
    }
    case 'monthly':
      return `${Number(minute)} ${Number(hour)} ${Number(builder.dayOfMonth || '1')} * *`;
  }
}

function isPlainNumber(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const parsed = Number(value);
  return parsed >= min && parsed <= max;
}

function parseWeekdayField(value: string): string[] | null {
  const weekdays = sortWeekdays(value.split(','));
  if (!weekdays.length) {
    return null;
  }

  if (weekdays.length !== value.split(',').filter(Boolean).length) {
    return null;
  }

  return weekdays;
}

export function parseCronExpressionToBuilder(
  cronExpression: string,
): ParsedRecurringScheduleBuilder | null {
  const normalized = normalizeCronExpression(cronExpression);
  const [minute, hour, dayOfMonth, month, weekday] = normalized.split(' ');

  if (![minute, hour, dayOfMonth, month, weekday].every(Boolean)) {
    return null;
  }

  if (hour === '*' && dayOfMonth === '*' && month === '*' && weekday === '*' && isPlainNumber(minute, 0, 59)) {
    return {
      preset: 'hourly',
      time: `00:${minute.padStart(2, '0')}`,
      weekdays: [],
      dayOfMonth: '1',
    };
  }

  if (
    dayOfMonth === '*'
    && month === '*'
    && weekday === '*'
    && isPlainNumber(minute, 0, 59)
    && isPlainNumber(hour, 0, 23)
  ) {
    return {
      preset: 'daily',
      time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      weekdays: [],
      dayOfMonth: '1',
    };
  }

  const weekdayList = parseWeekdayField(weekday);
  if (
    dayOfMonth === '*'
    && month === '*'
    && weekdayList
    && isPlainNumber(minute, 0, 59)
    && isPlainNumber(hour, 0, 23)
  ) {
    return {
      preset: 'weekly',
      time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      weekdays: weekdayList,
      dayOfMonth: '1',
    };
  }

  if (
    month === '*'
    && weekday === '*'
    && isPlainNumber(minute, 0, 59)
    && isPlainNumber(hour, 0, 23)
    && isPlainNumber(dayOfMonth, 1, 31)
  ) {
    return {
      preset: 'monthly',
      time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      weekdays: [],
      dayOfMonth,
    };
  }

  return null;
}
