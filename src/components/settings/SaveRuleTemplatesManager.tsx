import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MultiSelect } from '@mantine/core';
import {
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconCopy,
    IconEdit,
    IconPlus,
    IconRestore,
    IconTrash,
    IconX,
} from '@tabler/icons-react';
import {
    DEFAULT_CATEGORY_NAMES,
    MEDIA_CATEGORIES,
    SAVE_RULE_TOKENS,
    createEmptySaveRule,
    type MediaCategory,
    type SaveRule,
    type SaveRulePreviewEntry,
    type SaveRuleTemplate,
} from '../../hooks/useSaveRuleTemplates';
import { useSaveRuleTemplatesContext } from '../../context/SaveRuleTemplatesContext';
import { useToast } from '../ui/Toast';
import { getErrorMessage } from '../../views/sync-tasks/helpers';
import {
    localizeSaveRuleTemplateDescription,
    localizeSaveRuleTemplateName,
} from '../../utils/saveRuleTemplateDisplay';

type TemplateDraft = Omit<SaveRuleTemplate, 'id' | 'builtIn'>;

function emptyDraft(): TemplateDraft {
    return {
        name: '',
        description: '',
        dateSource: 'capture',
        videoTimestamp: 'local',
        categoryNames: { ...DEFAULT_CATEGORY_NAMES },
        rules: [createEmptySaveRule()],
    };
}

function draftFromTemplate(template: SaveRuleTemplate): TemplateDraft {
    return {
        name: template.name,
        description: template.description,
        dateSource: template.dateSource,
        videoTimestamp: template.videoTimestamp,
        categoryNames: { ...template.categoryNames },
        rules: template.rules.map((rule) => ({
            categories: [...rule.categories],
            extensions: [...rule.extensions],
            folder: rule.folder,
            fileName: rule.fileName,
        })),
    };
}

function parseExtensions(value: string): string[] {
    return value
        .split(/[\s,]+/)
        .map((item) => item.trim().replace(/^\./, '').toLowerCase())
        .filter((item) => item.length > 0);
}

const mantineStyles = {
    input: {
        border: '2px solid var(--border-main)',
        borderRadius: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        transform: 'none',
    },
    dropdown: {
        border: '2px solid var(--border-main)',
        borderRadius: 0,
        boxShadow: '4px 4px 0 0 black',
        transform: 'none',
    },
};

interface RuleEditorProps {
    index: number;
    rule: SaveRule;
    total: number;
    categoryLabel: (category: MediaCategory) => string;
    onChange: (rule: SaveRule) => void;
    onMove: (direction: -1 | 1) => void;
    onRemove: () => void;
}

function RuleEditor({ index, rule, total, categoryLabel, onChange, onMove, onRemove }: RuleEditorProps) {
    const { t } = useTranslation();
    const [extensionsText, setExtensionsText] = useState(rule.extensions.join(', '));

    useEffect(() => {
        setExtensionsText(rule.extensions.join(', '));
        // 규칙 순서가 바뀌면 입력 텍스트를 다시 맞춘다.
    }, [rule.extensions]);

    return (
        <div
            className="border-2 border-[var(--border-main)] p-3 bg-[var(--bg-primary)] space-y-2"
            data-testid={`save-rule-editor-${index}`}
        >
            <div className="flex justify-between items-center">
                <span className="text-xs font-bold uppercase font-mono">
                    {t('saveRules.ruleNumber', { index: index + 1, defaultValue: 'Rule {{index}}' })}
                </span>
                <div className="flex gap-1">
                    <button
                        type="button"
                        className="p-1 border border-[var(--border-main)] disabled:opacity-30"
                        onClick={() => onMove(-1)}
                        disabled={index === 0}
                        title={t('saveRules.moveUp', { defaultValue: 'Move up' })}
                        aria-label={t('saveRules.moveUp', { defaultValue: 'Move up' })}
                    >
                        <IconArrowUp size={14} />
                    </button>
                    <button
                        type="button"
                        className="p-1 border border-[var(--border-main)] disabled:opacity-30"
                        onClick={() => onMove(1)}
                        disabled={index === total - 1}
                        title={t('saveRules.moveDown', { defaultValue: 'Move down' })}
                        aria-label={t('saveRules.moveDown', { defaultValue: 'Move down' })}
                    >
                        <IconArrowDown size={14} />
                    </button>
                    <button
                        type="button"
                        className="p-1 border border-[var(--border-main)] hover:text-[var(--color-accent-error)] disabled:opacity-30"
                        onClick={onRemove}
                        disabled={total <= 1}
                        title={t('saveRules.removeRule', { defaultValue: 'Remove rule' })}
                        aria-label={t('saveRules.removeRule', { defaultValue: 'Remove rule' })}
                    >
                        <IconTrash size={14} />
                    </button>
                </div>
            </div>
            <div className="grid md:grid-cols-2 gap-2">
                <div>
                    <label className="block text-[11px] font-bold uppercase font-mono mb-1">
                        {t('saveRules.matchCategories', { defaultValue: 'File types (empty = any)' })}
                    </label>
                    <MultiSelect
                        data={MEDIA_CATEGORIES.map((category) => ({
                            value: category,
                            label: categoryLabel(category),
                        }))}
                        value={rule.categories}
                        onChange={(value) => onChange({ ...rule, categories: value as MediaCategory[] })}
                        clearable
                        comboboxProps={{ withinPortal: true }}
                        styles={mantineStyles}
                        aria-label={t('saveRules.matchCategories', { defaultValue: 'File types (empty = any)' })}
                    />
                </div>
                <div>
                    <label className="block text-[11px] font-bold uppercase font-mono mb-1">
                        {t('saveRules.matchExtensions', { defaultValue: 'Extensions (empty = any)' })}
                    </label>
                    <input
                        className="neo-input w-full font-mono text-xs"
                        value={extensionsText}
                        onChange={(event) => setExtensionsText(event.target.value)}
                        onBlur={() => onChange({ ...rule, extensions: parseExtensions(extensionsText) })}
                        placeholder="arw, jpg, mp4"
                        aria-label={t('saveRules.matchExtensions', { defaultValue: 'Extensions (empty = any)' })}
                    />
                </div>
                <div>
                    <label className="block text-[11px] font-bold uppercase font-mono mb-1">
                        {t('saveRules.folderTemplate', { defaultValue: 'Folder template' })}
                    </label>
                    <input
                        className="neo-input w-full font-mono text-xs"
                        value={rule.folder}
                        onChange={(event) => onChange({ ...rule, folder: event.target.value })}
                        placeholder={t('saveRules.folderTemplatePlaceholder', {
                            defaultValue: '{yyyy}-{MM}-{dd}/{category} or {dd}-{MM}-{yyyy}/{category}',
                        })}
                        aria-label={t('saveRules.folderTemplate', { defaultValue: 'Folder template' })}
                    />
                </div>
                <div>
                    <label className="block text-[11px] font-bold uppercase font-mono mb-1">
                        {t('saveRules.fileNameTemplate', { defaultValue: 'File name template' })}
                    </label>
                    <input
                        className="neo-input w-full font-mono text-xs"
                        value={rule.fileName}
                        onChange={(event) => onChange({ ...rule, fileName: event.target.value })}
                        placeholder={t('saveRules.fileNameTemplatePlaceholder', {
                            defaultValue: '{datetime}_{name}.{ext} or {dd}-{MM}-{yyyy}_{name}.{ext}',
                        })}
                        aria-label={t('saveRules.fileNameTemplate', { defaultValue: 'File name template' })}
                    />
                </div>
            </div>
        </div>
    );
}

interface TemplateFormProps {
    draft: TemplateDraft;
    onChange: (draft: TemplateDraft) => void;
    onSave: () => void;
    onCancel: () => void;
    saving: boolean;
    preview: SaveRulePreviewEntry[];
    previewError: string | null;
}

function TemplateForm({ draft, onChange, onSave, onCancel, saving, preview, previewError }: TemplateFormProps) {
    const { t } = useTranslation();
    const categoryLabel = useCallback(
        (category: MediaCategory) =>
            t(`saveRules.category.${category}`, {
                defaultValue: DEFAULT_CATEGORY_NAMES[category],
            }),
        [t],
    );

    const updateRule = (index: number, rule: SaveRule) => {
        const rules = draft.rules.map((candidate, candidateIndex) => (candidateIndex === index ? rule : candidate));
        onChange({ ...draft, rules });
    };
    const moveRule = (index: number, direction: -1 | 1) => {
        const target = index + direction;
        if (target < 0 || target >= draft.rules.length) {
            return;
        }
        const rules = [...draft.rules];
        const [moved] = rules.splice(index, 1);
        rules.splice(target, 0, moved);
        onChange({ ...draft, rules });
    };
    const removeRule = (index: number) => {
        if (draft.rules.length <= 1) {
            return;
        }
        onChange({ ...draft, rules: draft.rules.filter((_, candidateIndex) => candidateIndex !== index) });
    };

    return (
        <div className="space-y-4" data-testid="save-rule-template-form">
            <div className="grid md:grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs font-bold uppercase font-mono mb-1">
                        {t('saveRules.templateName', { defaultValue: 'Template name' })}
                    </label>
                    <input
                        className="neo-input w-full"
                        value={draft.name}
                        onChange={(event) => onChange({ ...draft, name: event.target.value })}
                        placeholder={t('saveRules.templateNamePlaceholder', {
                            defaultValue: 'My camera layout',
                        })}
                        aria-label={t('saveRules.templateName', { defaultValue: 'Template name' })}
                        autoFocus
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase font-mono mb-1">
                        {t('saveRules.description', { defaultValue: 'Description' })}
                    </label>
                    <input
                        className="neo-input w-full"
                        value={draft.description}
                        onChange={(event) => onChange({ ...draft, description: event.target.value })}
                        aria-label={t('saveRules.description', { defaultValue: 'Description' })}
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase font-mono mb-1">
                        {t('saveRules.dateSource', { defaultValue: 'Date tokens use' })}
                    </label>
                    <select
                        className="neo-input w-full font-mono text-xs"
                        value={draft.dateSource}
                        onChange={(event) =>
                            onChange({ ...draft, dateSource: event.target.value as TemplateDraft['dateSource'] })
                        }
                        aria-label={t('saveRules.dateSource', { defaultValue: 'Date tokens use' })}
                    >
                        <option value="capture">
                            {t('saveRules.dateSourceCapture', {
                                defaultValue: 'Capture time (EXIF / video), else file modified time',
                            })}
                        </option>
                        <option value="modified">
                            {t('saveRules.dateSourceModified', { defaultValue: 'File modified time only' })}
                        </option>
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-bold uppercase font-mono mb-1">
                        {t('saveRules.videoTimestamp', { defaultValue: 'MP4/MOV creation time is' })}
                    </label>
                    <select
                        className="neo-input w-full font-mono text-xs"
                        value={draft.videoTimestamp}
                        onChange={(event) =>
                            onChange({
                                ...draft,
                                videoTimestamp: event.target.value as TemplateDraft['videoTimestamp'],
                            })
                        }
                        aria-label={t('saveRules.videoTimestamp', { defaultValue: 'MP4/MOV creation time is' })}
                    >
                        <option value="local">
                            {t('saveRules.videoTimestampLocal', {
                                defaultValue: 'Local time as recorded (most cameras)',
                            })}
                        </option>
                        <option value="utc">
                            {t('saveRules.videoTimestampUtc', {
                                defaultValue: 'UTC, convert to this Mac’s time zone',
                            })}
                        </option>
                    </select>
                </div>
            </div>

            <div>
                <div className="text-xs font-bold uppercase font-mono mb-1">
                    {t('saveRules.categoryNames', { defaultValue: 'Folder names for {category}' })}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {MEDIA_CATEGORIES.map((category) => (
                        <label key={category} className="text-[11px] font-mono">
                            <span className="block mb-0.5 text-[var(--text-secondary)]">{categoryLabel(category)}</span>
                            <input
                                className="neo-input w-full font-mono text-xs"
                                value={draft.categoryNames[category]}
                                onChange={(event) =>
                                    onChange({
                                        ...draft,
                                        categoryNames: { ...draft.categoryNames, [category]: event.target.value },
                                    })
                                }
                                aria-label={`${t('saveRules.categoryNames', {
                                    defaultValue: 'Folder names for {category}',
                                })} ${categoryLabel(category)}`}
                            />
                        </label>
                    ))}
                </div>
            </div>

            <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <span className="text-xs font-bold uppercase font-mono">
                        {t('saveRules.rules', { defaultValue: 'Rules (first match wins)' })}
                    </span>
                    <button
                        type="button"
                        className="px-2 py-1 text-xs border-2 border-[var(--border-main)] font-bold uppercase flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
                        onClick={() => onChange({ ...draft, rules: [...draft.rules, createEmptySaveRule()] })}
                    >
                        <IconPlus size={14} />
                        {t('saveRules.addRule', { defaultValue: 'Add rule' })}
                    </button>
                </div>
                {draft.rules.map((rule, index) => (
                    <RuleEditor
                        // 순서 이동 시 입력 상태가 섞이지 않도록 index 기반 키 사용
                        key={index}
                        index={index}
                        rule={rule}
                        total={draft.rules.length}
                        categoryLabel={categoryLabel}
                        onChange={(next) => updateRule(index, next)}
                        onMove={(direction) => moveRule(index, direction)}
                        onRemove={() => removeRule(index)}
                    />
                ))}
                <div className="text-[11px] text-[var(--text-secondary)] font-mono">
                    {t('saveRules.unmatchedHint', {
                        defaultValue: 'Files that match no rule keep their original relative path.',
                    })}
                </div>
            </div>

            <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] p-2 border border-[var(--border-main)] font-mono">
                <p className="font-bold mb-1">{t('saveRules.tokensTitle', { defaultValue: 'Tokens' })}</p>
                <div className="flex flex-wrap gap-1 mb-1">
                    {SAVE_RULE_TOKENS.map((token) => (
                        <code key={token} className="px-1 border border-[var(--border-main)] bg-[var(--bg-primary)]">
                            {`{${token}}`}
                        </code>
                    ))}
                </div>
                <p>
                    {t('saveRules.tokensHelp', {
                        defaultValue:
                            '{yyyy}{MM}{dd} {HH}{mm}{ss} date/time · {name} original stem · {ext}/{EXT}/{ext_lower} extension · {folder} source folder · {path} source sub-path · {category} folder name above · {camera}/{make}/{model}/{serial}/{iso}/{fnumber}/{aperture}/{shutter}/{focal} from EXIF. Missing values render empty; the original extension is kept.',
                    })}
                </p>
                <p className="mt-1">
                    {t('saveRules.tokensDateHelp', {
                        defaultValue:
                            '{date} = {yyyy}-{MM}-{dd}, {time} = {HH}{mm}{ss}, {datetime} = {yyyy}{MM}{dd}_{HH}{mm}{ss}. Date tokens always use this year-first ISO order regardless of the system language, so target paths never change when you switch languages. For a regional order, combine tokens yourself, e.g. {dd}-{MM}-{yyyy} or {MM}-{dd}-{yyyy}; note that only year-first folder names sort chronologically in the Finder.',
                    })}
                </p>
                <p className="mt-1">
                    {t('saveRules.metadataCoverage', {
                        defaultValue:
                            'Capture time and camera data come from JPEG, HEIF/HEIC and TIFF-based RAW (ARW, NEF, CR2, DNG, ORF, RW2, RAF…). MP4/MOV use the Sony XML sidecar or the file header. Other formats (CR3, MXF, AVI…) fall back to the file modified time.',
                    })}
                </p>
            </div>

            <div>
                <div className="text-xs font-bold uppercase font-mono mb-1">
                    {t('saveRules.preview', { defaultValue: 'Preview (sample files)' })}
                </div>
                {previewError ? (
                    <div
                        className="text-xs font-mono text-[var(--color-accent-error)] border-l-2 border-[var(--color-accent-error)] pl-2"
                        data-testid="save-rule-preview-error"
                    >
                        {previewError}
                    </div>
                ) : (
                    <div className="border border-[var(--border-main)] font-mono text-[11px]" data-testid="save-rule-preview">
                        {preview.map((entry) => (
                            <div
                                key={entry.sourcePath}
                                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 px-2 py-1 border-b border-dashed border-[var(--border-main)] last:border-b-0"
                            >
                                <span className="truncate text-[var(--text-secondary)]" title={entry.sourcePath}>
                                    {entry.sourcePath}
                                </span>
                                <span className="truncate" title={entry.targetPath}>
                                    → {entry.targetPath}
                                </span>
                            </div>
                        ))}
                        {preview.length === 0 ? (
                            <div className="px-2 py-1 text-[var(--text-secondary)]">…</div>
                        ) : null}
                    </div>
                )}
            </div>

            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 border-2 border-[var(--border-main)] font-bold uppercase"
                    disabled={saving}
                >
                    {t('common.cancel')}
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    className="px-4 py-2 border-2 border-[var(--border-main)] bg-[var(--accent-main)] text-white font-bold uppercase shadow-[2px_2px_0_0_black] disabled:opacity-60"
                    disabled={saving}
                >
                    {saving ? t('common.loading') : t('common.save')}
                </button>
            </div>
        </div>
    );
}

export function SaveRuleTemplatesManager() {
    const { t } = useTranslation();
    const { showToast } = useToast();
    const { templates, addTemplate, updateTemplate, deleteTemplate, resetTemplates, previewTemplate } =
        useSaveRuleTemplatesContext();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
    const [saving, setSaving] = useState(false);
    const [preview, setPreview] = useState<SaveRulePreviewEntry[]>([]);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const formOpen = isCreating || editingId !== null;
    const draftKey = useMemo(() => JSON.stringify(draft), [draft]);

    useEffect(() => {
        if (!formOpen) {
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            const candidate: SaveRuleTemplate = {
                id: editingId ?? 'preview',
                builtIn: false,
                ...(JSON.parse(draftKey) as TemplateDraft),
            };
            previewTemplate(candidate)
                .then((entries) => {
                    if (!cancelled) {
                        setPreview(entries);
                        setPreviewError(null);
                    }
                })
                .catch((error) => {
                    if (!cancelled) {
                        setPreviewError(getErrorMessage(error));
                    }
                });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [draftKey, editingId, formOpen, previewTemplate]);

    const startCreating = (base?: SaveRuleTemplate) => {
        setIsCreating(true);
        setEditingId(null);
        setDraft(
            base
                ? {
                    ...draftFromTemplate(base),
                    name: `${localizeSaveRuleTemplateName(base, t)} (${t('saveRules.copySuffix', { defaultValue: 'copy' })})`,
                }
                : emptyDraft(),
        );
        setPreview([]);
        setPreviewError(null);
    };

    const startEditing = (template: SaveRuleTemplate) => {
        setEditingId(template.id);
        setIsCreating(false);
        setDraft(draftFromTemplate(template));
        setPreview([]);
        setPreviewError(null);
    };

    const cancel = () => {
        setIsCreating(false);
        setEditingId(null);
        setDraft(emptyDraft());
        setPreview([]);
        setPreviewError(null);
    };

    const save = async () => {
        setSaving(true);
        try {
            if (isCreating) {
                await addTemplate(draft);
            } else if (editingId) {
                await updateTemplate(editingId, draft);
            }
            showToast(
                t('saveRules.saved', { defaultValue: 'Save rule template saved.' }),
                'success',
            );
            cancel();
        } catch (error) {
            showToast(getErrorMessage(error), 'error');
        } finally {
            setSaving(false);
        }
    };

    const confirmDelete = async () => {
        if (!confirmDeleteId) {
            return;
        }
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        try {
            await deleteTemplate(id);
            if (editingId === id) {
                cancel();
            }
        } catch (error) {
            showToast(getErrorMessage(error), 'error');
        }
    };

    const handleReset = async () => {
        try {
            await resetTemplates();
            showToast(
                t('saveRules.resetDone', { defaultValue: 'Built-in templates restored.' }),
                'success',
            );
        } catch (error) {
            showToast(getErrorMessage(error), 'error');
        }
    };

    return (
        <section data-testid="save-rule-templates-manager">
            <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-info)]">
                {t('saveRules.title', { defaultValue: 'Save Rule Templates' })}
            </h2>
            <div className="neo-box p-6 space-y-6">
                <p className="text-xs font-mono text-[var(--text-secondary)]">
                    {t('saveRules.intro', {
                        defaultValue:
                            'A save rule template decides the target folder and file name for each copied file: by file type (proxy, video, RAW, photo, metadata), capture date, or EXIF values. Pick a template in a task’s settings.',
                    })}
                </p>
                <div className="space-y-4">
                    {templates.map((template) => {
                        const displayName = localizeSaveRuleTemplateName(template, t);
                        const displayDescription = localizeSaveRuleTemplateDescription(template, t);
                        return (
                        <div
                            key={template.id}
                            className="border-2 border-[var(--border-main)] p-4 bg-[var(--bg-primary)]"
                            data-testid={`save-rule-template-${template.id}`}
                        >
                            {editingId === template.id ? (
                                <TemplateForm
                                    draft={draft}
                                    onChange={setDraft}
                                    onSave={() => void save()}
                                    onCancel={cancel}
                                    saving={saving}
                                    preview={preview}
                                    previewError={previewError}
                                />
                            ) : (
                                <div>
                                    <div className="flex justify-between items-start mb-2 gap-2">
                                        <div className="min-w-0">
                                            <h3 className="font-bold uppercase truncate">
                                                {displayName}
                                                {template.builtIn ? (
                                                    <span className="ml-2 text-[10px] px-1 border border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] align-middle">
                                                        {t('saveRules.builtIn', { defaultValue: 'BUILT-IN' })}
                                                    </span>
                                                ) : null}
                                            </h3>
                                            {displayDescription ? (
                                                <p className="text-xs text-[var(--text-secondary)] font-mono">
                                                    {displayDescription}
                                                </p>
                                            ) : null}
                                        </div>
                                        <div className="flex gap-2 shrink-0">
                                            <button
                                                type="button"
                                                onClick={() => startEditing(template)}
                                                className="p-1 hover:text-[var(--accent-main)]"
                                                title={t('common.edit')}
                                                aria-label={`${t('common.edit')} ${displayName}`}
                                            >
                                                <IconEdit size={18} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => startCreating(template)}
                                                className="p-1 hover:text-[var(--accent-main)]"
                                                title={t('saveRules.duplicate', { defaultValue: 'Duplicate' })}
                                                aria-label={`${t('saveRules.duplicate', { defaultValue: 'Duplicate' })} ${displayName}`}
                                            >
                                                <IconCopy size={18} />
                                            </button>
                                            {!template.builtIn ? (
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirmDeleteId(template.id)}
                                                    className="p-1 hover:text-[var(--color-accent-error)]"
                                                    title={t('common.delete')}
                                                    aria-label={`${t('common.delete')} ${displayName}`}
                                                >
                                                    <IconTrash size={18} />
                                                </button>
                                            ) : null}
                                        </div>
                                    </div>
                                    {confirmDeleteId === template.id ? (
                                        <div className="flex items-center gap-2 text-xs font-mono border-l-2 border-[var(--color-accent-error)] pl-2 mb-2">
                                            <span>
                                                {t('saveRules.confirmDelete', {
                                                    name: displayName,
                                                    defaultValue: 'Delete template "{{name}}"?',
                                                })}
                                            </span>
                                            <button
                                                type="button"
                                                className="p-1 border border-[var(--border-main)]"
                                                onClick={() => void confirmDelete()}
                                                aria-label={t('common.confirm')}
                                            >
                                                <IconCheck size={14} />
                                            </button>
                                            <button
                                                type="button"
                                                className="p-1 border border-[var(--border-main)]"
                                                onClick={() => setConfirmDeleteId(null)}
                                                aria-label={t('common.cancel')}
                                            >
                                                <IconX size={14} />
                                            </button>
                                        </div>
                                    ) : null}
                                    <div className="space-y-1">
                                        {template.rules.map((rule, index) => (
                                            <div key={index} className="flex flex-wrap gap-1 items-center text-[11px] font-mono">
                                                <span className="text-[var(--text-secondary)]">
                                                    {rule.categories.length > 0
                                                        ? rule.categories
                                                            .map((category) =>
                                                                t(`saveRules.category.${category}`, {
                                                                    defaultValue: DEFAULT_CATEGORY_NAMES[category],
                                                                }),
                                                            )
                                                            .join(', ')
                                                        : t('saveRules.anyType', { defaultValue: 'Any type' })}
                                                    {rule.extensions.length > 0 ? ` [${rule.extensions.join(', ')}]` : ''}
                                                </span>
                                                <span>→</span>
                                                <code className="px-1 border border-[var(--border-main)] bg-[var(--bg-secondary)]">
                                                    {rule.folder ? `${rule.folder}/` : ''}
                                                    {rule.fileName}
                                                </code>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                        );
                    })}
                </div>

                {isCreating ? (
                    <div className="border-2 border-[var(--border-main)] p-4 bg-[var(--bg-secondary)]">
                        <TemplateForm
                            draft={draft}
                            onChange={setDraft}
                            onSave={() => void save()}
                            onCancel={cancel}
                            saving={saving}
                            preview={preview}
                            previewError={previewError}
                        />
                    </div>
                ) : (
                    <div className="flex flex-col md:flex-row gap-2">
                        <button
                            type="button"
                            onClick={() => startCreating()}
                            className="flex-1 py-2 border-2 border-dashed border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex justify-center items-center gap-2 font-bold uppercase"
                        >
                            <IconPlus size={20} />
                            {t('saveRules.addTemplate', { defaultValue: 'Add Save Rule Template' })}
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleReset()}
                            className="py-2 px-4 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex justify-center items-center gap-2 font-bold uppercase text-xs"
                            title={t('saveRules.resetHint', {
                                defaultValue: 'Restore built-in templates; your own templates are kept.',
                            })}
                        >
                            <IconRestore size={16} />
                            {t('saveRules.reset', { defaultValue: 'Restore built-ins' })}
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}

export default SaveRuleTemplatesManager;
