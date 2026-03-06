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
            makeSet('nodejs', ['custom-node-cache']),
            makeSet('python', ['custom-python-cache']),
            makeSet('git', ['.git']),
            makeSet('rust', ['target']),
        ];

        const mergedSets = mergeMissingDefaultSets(existing);
        const nodeSet = mergedSets.find((set) => set.id === 'nodejs');

        expect(nodeSet?.patterns).toEqual(['custom-node-cache']);
        expect(mergedSets.some((set) => set.id === 'jvm-build')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'dotnet')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'ruby-rails')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'php-laravel')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'dart-flutter')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'swift-xcode')).toBe(true);
        expect(mergedSets.some((set) => set.id === 'infra-terraform')).toBe(true);
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
