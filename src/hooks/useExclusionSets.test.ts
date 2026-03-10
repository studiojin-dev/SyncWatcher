import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ExclusionSet, mergeMissingDefaultSets, useExclusionSets } from './useExclusionSets';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();

function makeSet(id: string, patterns: string[]): ExclusionSet {
    return {
        id,
        name: id,
        patterns,
    };
}

describe('useExclusionSets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        mockListen.mockImplementation(async (eventName: string, handler: (event: { payload?: unknown }) => void) => {
            eventHandlers.set(eventName, handler);
            return () => {
                eventHandlers.delete(eventName);
            };
        });
        mockInvoke.mockImplementation(async (command: string) => {
            if (command === 'list_exclusion_sets') {
                return {
                    exclusionSets: [
                        makeSet('custom', ['*.tmp']),
                    ],
                };
            }

            return undefined;
        });
    });

    it('appends only missing default sets and preserves existing customized sets', () => {
        const existing = [
            makeSet('system-defaults', ['.DS_Store']),
            makeSet('git', ['.git']),
            makeSet('program', ['custom-program-cache']),
            makeSet('custom', ['*.tmp']),
        ];

        const mergedSets = mergeMissingDefaultSets(existing);
        const programSet = mergedSets.find((set) => set.id === 'program');

        expect(programSet?.patterns).toEqual(['custom-program-cache']);
        expect(mergedSets.some((set) => set.id === 'custom')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'nodejs')).toBe(false);
        expect(mergedSets.some((set) => set.id === 'python')).toBe(false);
        expect(mergedSets.some((set) => set.id === 'rust')).toBe(false);
    });

    it('falls back to the consolidated default sets when the backend returns no sets', async () => {
        mockInvoke.mockImplementation(async (command: string) => {
            if (command === 'list_exclusion_sets') {
                return { exclusionSets: [] };
            }

            return undefined;
        });

        const { result } = renderHook(() => useExclusionSets());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(result.current.sets.map((set) => set.id)).toEqual(['system-defaults', 'git', 'program']);
        const gitSet = result.current.sets.find((set) => set.id === 'git');
        const programSet = result.current.sets.find((set) => set.id === 'program');
        expect(gitSet?.patterns).toEqual(['.git']);
        expect(programSet?.patterns).toContain('.pnpm-store');
        expect(programSet?.patterns).not.toContain('.pnpm_store');
    });

    it('loads exclusion sets from the backend store', async () => {
        const { result } = renderHook(() => useExclusionSets());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(mockInvoke).toHaveBeenCalledWith('list_exclusion_sets');
        expect(result.current.sets).toEqual([makeSet('custom', ['*.tmp'])]);
    });

    it('reloads exclusion sets when config-store-changed is emitted', async () => {
        mockInvoke
            .mockResolvedValueOnce({ exclusionSets: [makeSet('first', ['*.tmp'])] })
            .mockResolvedValueOnce({ exclusionSets: [makeSet('second', ['dist'])] });

        const { result } = renderHook(() => useExclusionSets());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });
        expect(result.current.sets).toEqual([makeSet('first', ['*.tmp'])]);

        const handler = eventHandlers.get('config-store-changed');
        if (!handler) {
            throw new Error('config-store-changed handler not found');
        }

        act(() => {
            handler({ payload: { scope: 'exclusion_sets' } });
        });

        await waitFor(() => {
            expect(result.current.sets).toEqual([makeSet('second', ['dist'])]);
        });
    });

    it('uses backend commands for optimistic create and reset', async () => {
        mockInvoke.mockImplementation(async (command: string) => {
            if (command === 'list_exclusion_sets') {
                return { exclusionSets: [] };
            }
            if (command === 'create_exclusion_set') {
                return undefined;
            }
            if (command === 'reset_exclusion_sets') {
                return {
                    exclusionSets: [makeSet('reset', ['node_modules'])],
                };
            }

            return undefined;
        });

        const { result } = renderHook(() => useExclusionSets());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        act(() => {
            result.current.addSet('Temp', ['*.tmp']);
        });

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith(
                'create_exclusion_set',
                expect.objectContaining({
                    set: expect.objectContaining({
                        name: 'Temp',
                        patterns: ['*.tmp'],
                    }),
                })
            );
        });
        expect(result.current.sets.some((set) => set.name === 'Temp')).toBe(true);

        act(() => {
            result.current.resetSets();
        });

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('reset_exclusion_sets');
        });
        await waitFor(() => {
            expect(result.current.sets).toEqual([makeSet('reset', ['node_modules'])]);
        });
    });
});
