/**
 * 기본(built-in) 저장 규칙 템플릿의 이름·설명을 UI 언어로 보여주기 위한 도우미.
 *
 * 백엔드(`save_rules::built_in_templates()`)는 영어 문구를 YAML에 저장하고, 사용자는 기본 템플릿도
 * 편집할 수 있다. 그래서 저장된 문구가 영어 기본값과 정확히 같을 때만 번역을 보여주고,
 * 사용자가 바꾼 문구는 그대로 둔다. 저장된 데이터는 건드리지 않는다.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export interface BuiltInSaveRulePresetText {
    name: string;
    description: string;
}

/** `src-tauri/src/save_rules/mod.rs`의 `built_in_templates()`와 글자 단위로 같아야 한다. */
export const BUILT_IN_SAVE_RULE_PRESETS: Readonly<Record<string, BuiltInSaveRulePresetText>> = {
    'camera-by-type': {
        name: 'Camera: by file type',
        description: 'Proxy / Video / RAW / Photo / Metadata folders, original file names.',
    },
    'camera-by-date-type': {
        name: 'Camera: by capture date, then type',
        description: 'YYYY-MM-DD/<type>/ folders from the capture date, original file names.',
    },
    'camera-by-date': {
        name: 'Camera: by capture date',
        description: 'YYYY/YYYY-MM-DD/ folders from the capture date, all types together.',
    },
    'camera-dated-filenames': {
        name: 'Camera: dated folders and file names',
        description: 'YYYY-MM-DD/<type>/ folders; files renamed to YYYYMMDD_HHMMSS_<original>.',
    },
};

export interface SaveRuleTemplateTextSource {
    id: string;
    name: string;
    description?: string;
    builtIn?: boolean;
}

function presetFor(template: SaveRuleTemplateTextSource): BuiltInSaveRulePresetText | undefined {
    return template.builtIn ? BUILT_IN_SAVE_RULE_PRESETS[template.id] : undefined;
}

/** 표시용 템플릿 이름. 편집되지 않은 기본 템플릿만 번역된다. */
export function localizeSaveRuleTemplateName(template: SaveRuleTemplateTextSource, t: TranslateFn): string {
    const preset = presetFor(template);
    if (!preset || preset.name !== template.name) {
        return template.name;
    }
    return t(`saveRules.presets.${template.id}.name`, { defaultValue: preset.name });
}

/** 표시용 템플릿 설명. 편집되지 않은 기본 템플릿만 번역된다. */
export function localizeSaveRuleTemplateDescription(
    template: SaveRuleTemplateTextSource,
    t: TranslateFn,
): string {
    const description = template.description ?? '';
    const preset = presetFor(template);
    if (!preset || preset.description !== description) {
        return description;
    }
    return t(`saveRules.presets.${template.id}.description`, { defaultValue: preset.description });
}
