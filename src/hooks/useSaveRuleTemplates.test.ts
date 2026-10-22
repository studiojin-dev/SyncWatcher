import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSaveRuleTemplates, type SaveRuleTemplate } from './useSaveRuleTemplates';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();

function makeTemplate(id: string, overrides: Partial<SaveRuleTemplate> = {}): SaveRuleTemplate {
    return {
        id,
        name: id,
        description: '',
        builtIn: false,
        dateSource: 'capture',
        videoTimestamp: 'local',
        categoryNames: {
            proxy: 'Proxy',
            video: 'Video',
            raw: 'RAW',
            image: 'Photo',
            metadata: 'Metadata',
            other: 'Other',
        },
        rules: [{ categories: [], extensions: [], folder: '{yyyy}', fileName: '{name}.{ext}' }],
        ...overrides,
    };
}

describe('useSaveRuleTemplates', () => {
    let stored: SaveRuleTemplate[];

    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        stored = [makeTemplate('camera-by-type', { builtIn: true, name: 'Camera: by file type' })];
        mockListen.mockImplementation(async (eventName: string, handler: (event: { payload?: unknown }) => void) => {
            eventHandlers.set(eventName, handler);
            return () => {
                eventHandlers.delete(eventName);
            };
        });
        mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'list_save_rule_templates') {
                return { templates: stored };
            }
            if (command === 'create_save_rule_template') {
                const template = args?.template as SaveRuleTemplate;
                stored = [...stored, { ...template, builtIn: false }];
                return { template: { ...template, builtIn: false } };
            }
            if (command === 'update_save_rule_template') {
                const id = args?.id as string;
                const updates = args?.updates as Partial<SaveRuleTemplate>;
                stored = stored.map((candidate) => (candidate.id === id ? { ...candidate, ...updates } : candidate));
                return { template: stored.find((candidate) => candidate.id === id) };
            }
            if (command === 'delete_save_rule_template') {
                stored = stored.filter((candidate) => candidate.id !== (args?.id as string));
                return { deleted: true };
            }
            if (command === 'preview_save_rule_template') {
                return [{ sourcePath: 'a.jpg', targetPath: '2026/a.jpg', category: 'image' }];
            }
            throw new Error(`unexpected command ${command}`);
        });
    });

    it('loads templates from the backend and fills defaults', async () => {
        const { result } = renderHook(() => useSaveRuleTemplates());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.templates).toHaveLength(1);
        expect(result.current.templates[0].builtIn).toBe(true);
        expect(result.current.getTemplateById('camera-by-type')?.name).toBe('Camera: by file type');
        expect(result.current.getTemplateById('missing')).toBeNull();
        expect(result.current.getTemplateById(null)).toBeNull();
    });

    it('creates, updates and deletes templates through backend commands', async () => {
        const { result } = renderHook(() => useSaveRuleTemplates());
        await waitFor(() => expect(result.current.loaded).toBe(true));

        let createdTemplate: SaveRuleTemplate | undefined;
        await act(async () => {
            createdTemplate = await result.current.addTemplate({
                name: 'Mine',
                description: 'desc',
                dateSource: 'modified',
                videoTimestamp: 'utc',
                categoryNames: makeTemplate('x').categoryNames,
                rules: [{ categories: ['raw'], extensions: ['arw'], folder: 'RAW', fileName: '{name}.{ext}' }],
            });
        });
        expect(createdTemplate?.builtIn).toBe(false);
        if (!createdTemplate) {
            throw new Error('template should be created');
        }
        const created = createdTemplate;
        expect(result.current.templates).toHaveLength(2);
        expect(mockInvoke).toHaveBeenCalledWith(
            'create_save_rule_template',
            expect.objectContaining({ template: expect.objectContaining({ name: 'Mine', dateSource: 'modified' }) }),
        );

        await act(async () => {
            await result.current.updateTemplate(created.id, { name: 'Renamed' });
        });
        expect(result.current.getTemplateById(created.id)?.name).toBe('Renamed');
        expect(mockInvoke).toHaveBeenCalledWith('update_save_rule_template', {
            id: created.id,
            updates: { name: 'Renamed' },
        });

        await act(async () => {
            await result.current.deleteTemplate(created.id);
        });
        expect(result.current.templates).toHaveLength(1);
        expect(mockInvoke).toHaveBeenCalledWith('delete_save_rule_template', { id: created.id });
    });

    it('reloads when the config store reports a save rule template change', async () => {
        const { result } = renderHook(() => useSaveRuleTemplates());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        stored = [...stored, makeTemplate('external')];

        const handler = eventHandlers.get('config-store-changed');
        expect(handler).toBeTypeOf('function');
        await act(async () => {
            handler?.({ payload: { scopes: ['saveRuleTemplates'] } });
        });
        await waitFor(() => expect(result.current.templates).toHaveLength(2));
    });

    it('returns backend preview entries', async () => {
        const { result } = renderHook(() => useSaveRuleTemplates());
        await waitFor(() => expect(result.current.loaded).toBe(true));
        const entries = await result.current.previewTemplate(makeTemplate('preview'));
        expect(entries).toEqual([{ sourcePath: 'a.jpg', targetPath: '2026/a.jpg', category: 'image' }]);
    });
});
