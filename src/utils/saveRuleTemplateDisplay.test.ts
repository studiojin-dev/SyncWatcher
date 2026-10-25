import { describe, expect, it } from 'vitest';
// Rust 기본 템플릿 소스를 그대로 읽어 영어 기본 문구가 어긋나지 않는지 확인한다.
import rustBuiltInSource from '../../src-tauri/src/save_rules/mod.rs?raw';
import {
    BUILT_IN_SAVE_RULE_PRESETS,
    localizeSaveRuleTemplateDescription,
    localizeSaveRuleTemplateName,
} from './saveRuleTemplateDisplay';

const t = (key: string, options?: Record<string, unknown>): string => {
    const translated: Record<string, string> = {
        'saveRules.presets.camera-by-type.name': '카메라: 파일 종류별',
        'saveRules.presets.camera-by-type.description': 'Proxy / Video / RAW / Photo / Metadata 폴더, 원본 파일명 유지.',
    };
    return translated[key] ?? String(options?.defaultValue ?? key);
};

describe('saveRuleTemplateDisplay', () => {
    const preset = BUILT_IN_SAVE_RULE_PRESETS['camera-by-type'];

    it('translates an untouched built-in template', () => {
        const template = { id: 'camera-by-type', builtIn: true, ...preset };
        expect(localizeSaveRuleTemplateName(template, t)).toBe('카메라: 파일 종류별');
        expect(localizeSaveRuleTemplateDescription(template, t)).toBe(
            'Proxy / Video / RAW / Photo / Metadata 폴더, 원본 파일명 유지.',
        );
    });

    it('keeps user edits on a built-in template', () => {
        const template = { id: 'camera-by-type', builtIn: true, name: 'My cards', description: preset.description };
        expect(localizeSaveRuleTemplateName(template, t)).toBe('My cards');
        // 설명은 기본값 그대로이므로 설명만 번역된다.
        expect(localizeSaveRuleTemplateDescription(template, t)).toBe(
            'Proxy / Video / RAW / Photo / Metadata 폴더, 원본 파일명 유지.',
        );
    });

    it('never translates user templates, even with a preset-looking id and text', () => {
        const template = { id: 'camera-by-type', builtIn: false, ...preset };
        expect(localizeSaveRuleTemplateName(template, t)).toBe(preset.name);
        expect(localizeSaveRuleTemplateDescription(template, t)).toBe(preset.description);
    });

    it('falls back to the English default when no translation exists', () => {
        const byDate = BUILT_IN_SAVE_RULE_PRESETS['camera-by-date'];
        const template = { id: 'camera-by-date', builtIn: true, ...byDate };
        expect(localizeSaveRuleTemplateName(template, t)).toBe(byDate.name);
        expect(localizeSaveRuleTemplateDescription(template, t)).toBe(byDate.description);
    });

    it('matches the English defaults in the Rust built_in_templates()', () => {
        const rustSource: string = rustBuiltInSource;
        for (const [id, text] of Object.entries(BUILT_IN_SAVE_RULE_PRESETS)) {
            expect(rustSource, `preset id ${id}`).toContain(`"${id}"`);
            expect(rustSource, `name of ${id}`).toContain(`name: "${text.name}"`);
            expect(rustSource, `description of ${id}`).toContain(`"${text.description}"`);
        }
    });
});
