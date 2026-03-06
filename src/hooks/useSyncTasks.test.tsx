import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncTasks } from './useSyncTasks';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();

describe('useSyncTasks', () => {
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
            if (command === 'list_sync_tasks') {
                return {
                    syncTasks: [
                        {
                            id: 'task-1',
                            name: 'Photos',
                            source: '/Volumes/CARD',
                            target: '/Volumes/Backup',
                            checksumMode: false,
                        },
                    ],
                };
            }

            return undefined;
        });
    });

    it('loads sync tasks from the backend store', async () => {
        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(mockInvoke).toHaveBeenCalledWith('list_sync_tasks');
        expect(result.current.tasks).toEqual([
            expect.objectContaining({
                id: 'task-1',
                name: 'Photos',
                source: '/Volumes/CARD',
                target: '/Volumes/Backup',
                checksumMode: false,
                verifyAfterCopy: true,
                watchMode: false,
            }),
        ]);
    });

    it('reloads tasks when config-store-changed is emitted', async () => {
        mockInvoke
            .mockResolvedValueOnce({
                syncTasks: [
                    {
                        id: 'task-1',
                        name: 'Photos',
                        source: '/Volumes/CARD',
                        target: '/Volumes/Backup',
                        checksumMode: false,
                    },
                ],
            })
            .mockResolvedValueOnce({
                syncTasks: [
                    {
                        id: 'task-2',
                        name: 'Videos',
                        source: '/Volumes/CARD',
                        target: '/Volumes/Archive',
                        checksumMode: true,
                    },
                ],
            });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });
        expect(result.current.tasks[0]?.id).toBe('task-1');

        const handler = eventHandlers.get('config-store-changed');
        if (!handler) {
            throw new Error('config-store-changed handler not found');
        }

        act(() => {
            handler({ payload: { scope: 'tasks' } });
        });

        await waitFor(() => {
            expect(result.current.tasks[0]?.id).toBe('task-2');
        });
    });

    it('uses backend commands for optimistic create, update, and delete', async () => {
        mockInvoke.mockImplementation(async (command: string) => {
            if (command === 'list_sync_tasks') {
                return { syncTasks: [] };
            }
            return undefined;
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        let createdTaskId = '';

        await act(async () => {
            const task = await result.current.addTask({
                name: 'Photos',
                source: '/Volumes/CARD',
                target: '/Volumes/Backup',
                checksumMode: false,
            });
            createdTaskId = task.id;
        });

        expect(result.current.tasks).toHaveLength(1);
        expect(mockInvoke).toHaveBeenCalledWith(
            'create_sync_task',
            expect.objectContaining({
                task: expect.objectContaining({
                    id: createdTaskId,
                    name: 'Photos',
                }),
            })
        );

        await act(async () => {
            await result.current.updateTask(createdTaskId, {
                watchMode: true,
            });
        });

        expect(mockInvoke).toHaveBeenCalledWith('update_sync_task', {
            id: createdTaskId,
            updates: {
                watchMode: true,
            },
        });
        expect(result.current.tasks[0]?.watchMode).toBe(true);

        await act(async () => {
            await result.current.deleteTask(createdTaskId);
        });

        expect(mockInvoke).toHaveBeenCalledWith('delete_sync_task', {
            id: createdTaskId,
        });
        expect(result.current.tasks).toHaveLength(0);
    });
});
