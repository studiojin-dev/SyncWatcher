import { describe, expect, it } from 'vitest';
import enTranslation from '../../locales/en/translation.json';
import koTranslation from '../../locales/ko/translation.json';
import jaTranslation from '../../locales/ja/translation.json';
import zhTranslation from '../../locales/zh/translation.json';
import zhTwTranslation from '../../locales/zh-TW/translation.json';
import esTranslation from '../../locales/es/translation.json';
import { BUILT_IN_SAVE_RULE_PRESETS } from '../../utils/saveRuleTemplateDisplay';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectLeafPaths(value: unknown, prefix = ''): string[] {
    if (isRecord(value)) {
        return Object.entries(value).flatMap(([key, child]) =>
            collectLeafPaths(child, prefix ? `${prefix}.${key}` : key),
        );
    }
    return prefix ? [prefix] : [];
}

function readPath(value: unknown, path: string): unknown {
    let cursor: unknown = value;
    for (const part of path.split('.')) {
        if (!isRecord(cursor)) {
            return undefined;
        }
        cursor = cursor[part];
    }
    return cursor;
}

describe('save rules locale keys', () => {
    const enSaveRules = enTranslation.translation.saveRules as unknown;
    const requiredLeafPaths = collectLeafPaths(enSaveRules);

    const localeTargets: Array<[string, unknown]> = [
        ['ko', koTranslation.translation.saveRules as unknown],
        ['ja', jaTranslation.translation.saveRules as unknown],
        ['zh', zhTranslation.translation.saveRules as unknown],
        ['zh-TW', zhTwTranslation.translation.saveRules as unknown],
        ['es', esTranslation.translation.saveRules as unknown],
    ];

    it.each(localeTargets)('contains every english saveRules key in %s locale', (locale, node) => {
        const missing = requiredLeafPaths.filter((path) => readPath(node, path) === undefined);
        expect(missing, `${locale} locale is missing saveRules keys: ${missing.join(', ')}`).toEqual([]);
    });

    it('has a preset name and description for every built-in template id', () => {
        for (const id of Object.keys(BUILT_IN_SAVE_RULE_PRESETS)) {
            expect(readPath(enSaveRules, `presets.${id}.name`), `en presets.${id}.name`).toBeTypeOf('string');
            expect(readPath(enSaveRules, `presets.${id}.description`), `en presets.${id}.description`).toBeTypeOf(
                'string',
            );
        }
    });

    it('keeps the ISO shapes of the date tokens in every locale', () => {
        for (const [locale, node] of [['en', enSaveRules] as [string, unknown], ...localeTargets]) {
            const help = readPath(node, 'tokensDateHelp');
            expect(help, `${locale} tokensDateHelp`).toBeTypeOf('string');
            const text = help as string;
            expect(text, `${locale} {date}`).toContain('{date} = {yyyy}-{MM}-{dd}');
            expect(text, `${locale} {time}`).toContain('{time} = {HH}{mm}{ss}');
            expect(text, `${locale} {datetime}`).toContain('{datetime} = {yyyy}{MM}{dd}_{HH}{mm}{ss}');
            expect(text, `${locale} regional example`).toContain('{dd}-{MM}-{yyyy}');
            expect(readPath(node, 'folderTemplatePlaceholder'), `${locale} folder placeholder`).toContain(
                '{dd}-{MM}-{yyyy}',
            );
        }
    });
});
