import { describe, expect, it } from 'vitest';
import enTranslation from '../locales/en/translation.json';
import koTranslation from '../locales/ko/translation.json';
import jaTranslation from '../locales/ja/translation.json';
import zhTranslation from '../locales/zh/translation.json';
import zhTwTranslation from '../locales/zh-TW/translation.json';
import esTranslation from '../locales/es/translation.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectLeafPaths(value: unknown, prefix = ''): string[] {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return prefix ? [prefix] : [];
    }

    return entries.flatMap(([key, child]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      return collectLeafPaths(child, nextPrefix);
    });
  }

  return prefix ? [prefix] : [];
}

function hasPath(value: unknown, path: string): boolean {
  const parts = path.split('.');
  let cursor: unknown = value;

  for (const part of parts) {
    if (!isRecord(cursor)) {
      return false;
    }

    cursor = cursor[part];
  }

  return cursor !== undefined;
}

describe('recurring schedules locale keys', () => {
  const enRecurringSchedules = enTranslation.translation.recurringSchedules as unknown;
  const requiredLeafPaths = collectLeafPaths(enRecurringSchedules);

  const localeTargets: Array<[string, unknown]> = [
    ['ko', koTranslation.translation.recurringSchedules as unknown],
    ['ja', jaTranslation.translation.recurringSchedules as unknown],
    ['zh', zhTranslation.translation.recurringSchedules as unknown],
    ['zh-TW', zhTwTranslation.translation.recurringSchedules as unknown],
    ['es', esTranslation.translation.recurringSchedules as unknown],
  ];

  it.each(localeTargets)(
    'contains every english recurringSchedules key in %s locale',
    (locale, recurringSchedulesNode) => {
      const missing = requiredLeafPaths.filter((path) => !hasPath(recurringSchedulesNode, path));
      expect(
        missing,
        `${locale} locale is missing recurringSchedules keys: ${missing.join(', ')}`
      ).toEqual([]);
    }
  );
});
