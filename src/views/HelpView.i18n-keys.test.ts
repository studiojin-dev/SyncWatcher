import { describe, expect, it } from 'vitest';
import enTranslation from '../locales/en/translation.json';
import koTranslation from '../locales/ko/translation.json';
import jaTranslation from '../locales/ja/translation.json';
import zhTranslation from '../locales/zh/translation.json';
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

describe('help locale keys', () => {
  const enHelp = enTranslation.translation.help as unknown;
  const requiredLeafPaths = collectLeafPaths(enHelp);

  const localeTargets: Array<[string, unknown]> = [
    ['ko', koTranslation.translation.help as unknown],
    ['ja', jaTranslation.translation.help as unknown],
    ['zh', zhTranslation.translation.help as unknown],
    ['es', esTranslation.translation.help as unknown],
  ];

  it.each(localeTargets)('contains every english help key in %s locale', (locale, helpNode) => {
    const missing = requiredLeafPaths.filter((path) => !hasPath(helpNode, path));
    expect(
      missing,
      `${locale} locale is missing help keys: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
