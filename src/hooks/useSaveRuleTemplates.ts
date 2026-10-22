import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { YamlStoreError } from './useYamlStore';
import {
    listenConfigStoreChanged,
    parseConfigError,
    readConfigCollection,
    readConfigRecord,
} from '../utils/configStore';

export type MediaCategory = 'proxy' | 'video' | 'raw' | 'image' | 'metadata' | 'other';

export const MEDIA_CATEGORIES: MediaCategory[] = [
    'proxy',
    'video',
    'raw',
    'image',
    'metadata',
    'other',
];

export type SaveRuleDateSource = 'capture' | 'modified';
export type SaveRuleVideoTimestampMode = 'local' | 'utc';

export interface SaveRuleCategoryNames {
    proxy: string;
    video: string;
    raw: string;
    image: string;
    metadata: string;
    other: string;
}

export interface SaveRule {
    categories: MediaCategory[];
    extensions: string[];
    folder: string;
    fileName: string;
}

export interface SaveRuleTemplate {
    id: string;
    name: string;
    description: string;
    builtIn: boolean;
    dateSource: SaveRuleDateSource;
    videoTimestamp: SaveRuleVideoTimestampMode;
    categoryNames: SaveRuleCategoryNames;
    rules: SaveRule[];
}

export interface SaveRulePreviewEntry {
    sourcePath: string;
    targetPath: string;
    category: MediaCategory;
}

export type SaveRuleTemplateUpdate = Partial<Omit<SaveRuleTemplate, 'id' | 'builtIn'>>;

export const DEFAULT_CATEGORY_NAMES: SaveRuleCategoryNames = {
    proxy: 'Proxy',
    video: 'Video',
    raw: 'RAW',
    image: 'Photo',
    metadata: 'Metadata',
    other: 'Other',
};

/** 템플릿 문법에서 쓸 수 있는 토큰 목록 (백엔드 `save_rules::template::Token`과 동일). */
export const SAVE_RULE_TOKENS: string[] = [
    'yyyy', 'yy', 'MM', 'dd', 'HH', 'mm', 'ss', 'date', 'time', 'datetime',
    'name', 'ext', 'EXT', 'ext_lower', 'folder', 'path', 'category',
    'make', 'model', 'camera', 'serial', 'iso', 'fnumber', 'aperture', 'shutter', 'focal',
];

export function createEmptySaveRule(): SaveRule {
    return { categories: [], extensions: [], folder: '', fileName: '{name}.{ext}' };
}

function normalizeTemplate(template: Partial<SaveRuleTemplate>): SaveRuleTemplate {
    return {
        id: template.id ?? '',
        name: template.name ?? '',
        description: template.description ?? '',
        builtIn: template.builtIn ?? false,
        dateSource: template.dateSource ?? 'capture',
        videoTimestamp: template.videoTimestamp ?? 'local',
        categoryNames: { ...DEFAULT_CATEGORY_NAMES, ...(template.categoryNames ?? {}) },
        rules: (template.rules ?? []).map((rule) => ({
            categories: rule.categories ?? [],
            extensions: rule.extensions ?? [],
            folder: rule.folder ?? '',
            fileName: rule.fileName ?? '{name}.{ext}',
        })),
    };
}

export function useSaveRuleTemplates() {
    const [templates, setTemplates] = useState<SaveRuleTemplate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<YamlStoreError | null>(null);
    const templatesRef = useRef<SaveRuleTemplate[]>([]);

    const commit = useCallback((next: SaveRuleTemplate[]) => {
        templatesRef.current = next;
        setTemplates(next);
    }, []);

    const loadTemplates = useCallback(async () => {
        try {
            const response = await invoke<unknown>('list_save_rule_templates');
            const next = readConfigCollection<Partial<SaveRuleTemplate>>(response, [
                'templates',
                'saveRuleTemplates',
            ]).map(normalizeTemplate);
            commit(next);
            setError(null);
        } catch (err) {
            const nextError = readConfigRecord<YamlStoreError>(parseConfigError(err), ['error']);
            setError(nextError && nextError.type === 'PARSE_ERROR' ? (nextError as YamlStoreError) : null);
            console.error('Failed to load save rule templates:', err);
        } finally {
            setLoaded(true);
        }
    }, [commit]);

    useEffect(() => {
        void loadTemplates();

        let disposed = false;
        const unlistenPromise = listenConfigStoreChanged(['saveRuleTemplates'], () => {
            if (!disposed) {
                void loadTemplates();
            }
        });

        return () => {
            disposed = true;
            void unlistenPromise
                .then((unlisten) => unlisten())
                .catch((err) => {
                    console.warn('Failed to unlisten config-store-changed for save rule templates', err);
                });
        };
    }, [loadTemplates]);

    const addTemplate = useCallback(
        async (template: Omit<SaveRuleTemplate, 'id' | 'builtIn'>): Promise<SaveRuleTemplate> => {
            const candidate: SaveRuleTemplate = normalizeTemplate({
                ...template,
                id: crypto.randomUUID(),
                builtIn: false,
            });
            const response = await invoke<unknown>('create_save_rule_template', { template: candidate });
            const persisted = readConfigRecord<SaveRuleTemplate>(response, ['template', 'saveRuleTemplate']);
            const saved = persisted ? normalizeTemplate(persisted) : candidate;
            commit([...templatesRef.current, saved]);
            setError(null);
            return saved;
        },
        [commit],
    );

    const updateTemplate = useCallback(
        async (id: string, updates: SaveRuleTemplateUpdate): Promise<SaveRuleTemplate> => {
            const response = await invoke<unknown>('update_save_rule_template', { id, updates });
            const persisted = readConfigRecord<SaveRuleTemplate>(response, ['template', 'saveRuleTemplate']);
            const saved = persisted
                ? normalizeTemplate(persisted)
                : normalizeTemplate({
                    ...(templatesRef.current.find((candidate) => candidate.id === id) ?? { id }),
                    ...updates,
                });
            commit(templatesRef.current.map((candidate) => (candidate.id === id ? saved : candidate)));
            setError(null);
            return saved;
        },
        [commit],
    );

    const deleteTemplate = useCallback(
        async (id: string): Promise<void> => {
            await invoke('delete_save_rule_template', { id });
            commit(templatesRef.current.filter((candidate) => candidate.id !== id));
            setError(null);
        },
        [commit],
    );

    const resetTemplates = useCallback(async (): Promise<void> => {
        const response = await invoke<unknown>('reset_save_rule_templates');
        const next = readConfigCollection<Partial<SaveRuleTemplate>>(response, [
            'templates',
            'saveRuleTemplates',
        ]).map(normalizeTemplate);
        if (next.length > 0) {
            commit(next);
        } else {
            await loadTemplates();
        }
        setError(null);
    }, [commit, loadTemplates]);

    const previewTemplate = useCallback(
        async (template: SaveRuleTemplate): Promise<SaveRulePreviewEntry[]> => {
            const response = await invoke<unknown>('preview_save_rule_template', { template });
            return readConfigCollection<SaveRulePreviewEntry>(response, ['entries', 'preview']);
        },
        [],
    );

    const getTemplateById = useCallback(
        (id: string | null | undefined): SaveRuleTemplate | null => {
            if (!id) {
                return null;
            }
            return templates.find((candidate) => candidate.id === id) ?? null;
        },
        [templates],
    );

    return {
        templates,
        loaded,
        error,
        addTemplate,
        updateTemplate,
        deleteTemplate,
        resetTemplates,
        previewTemplate,
        getTemplateById,
        reload: loadTemplates,
    };
}
