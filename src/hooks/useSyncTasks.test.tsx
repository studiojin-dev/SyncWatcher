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

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

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

        expect(mockInvoke).toHaveBeenCalledWith(
            'update_sync_task',
            expect.objectContaining({
                id: createdTaskId,
                updates: {
                    watchMode: true,
                },
            })
        );
        expect(result.current.tasks[0]?.watchMode).toBe(true);

        await act(async () => {
            await result.current.deleteTask(createdTaskId);
        });

        expect(mockInvoke).toHaveBeenCalledWith('delete_sync_task', {
            id: createdTaskId,
        });
        expect(result.current.tasks).toHaveLength(0);
    });

    it('forwards network mount credentials without keeping them in local task state', async () => {
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

        await act(async () => {
            await result.current.addTask({
                name: 'NAS Backup',
                source: '/Volumes/NAS/source',
                sourceNetworkMount: {
                    scheme: 'smb',
                    remountUrl: 'smb://nas.local/source',
                    username: 'backup-user',
                    mountRootPath: '/Volumes/source',
                    relativePathFromMountRoot: '.',
                    enabled: true,
                },
                sourceCredential: {
                    password: 'secret',
                },
                target: '/tmp/backup',
                checksumMode: false,
            });
        });

        expect(mockInvoke).toHaveBeenCalledWith(
            'create_sync_task',
            expect.objectContaining({
                sourceCredential: {
                    password: 'secret',
                },
            })
        );
        expect(result.current.tasks[0]).not.toHaveProperty('sourceCredential');
    });

    it('keeps the newest overlapping update result when responses resolve out of order', async () => {
        const firstUpdate = createDeferred<unknown>();
        const secondUpdate = createDeferred<unknown>();

        mockInvoke.mockImplementation((command: string, args?: { id?: string; updates?: { name?: string } }) => {
            if (command === 'list_sync_tasks') {
                return Promise.resolve({
                    syncTasks: [
                        {
                            id: 'task-1',
                            name: 'Photos',
                            source: '/Volumes/CARD',
                            target: '/Volumes/Backup',
                            checksumMode: false,
                        },
                    ],
                });
            }

            if (command === 'update_sync_task' && args?.updates?.name === 'First rename') {
                return firstUpdate.promise;
            }

            if (command === 'update_sync_task' && args?.updates?.name === 'Second rename') {
                return secondUpdate.promise;
            }

            return Promise.resolve(undefined);
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        let firstPromise!: Promise<void>;
        let secondPromise!: Promise<void>;
        await act(async () => {
            firstPromise = result.current.updateTask('task-1', { name: 'First rename' });
            secondPromise = result.current.updateTask('task-1', { name: 'Second rename' });
        });

        expect(result.current.tasks[0]?.name).toBe('Second rename');

        await act(async () => {
            secondUpdate.resolve({
                task: {
                    id: 'task-1',
                    name: 'Second rename',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup',
                    checksumMode: false,
                },
            });
            await secondPromise;
        });

        await act(async () => {
            firstUpdate.resolve({
                task: {
                    id: 'task-1',
                    name: 'First rename',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup',
                    checksumMode: false,
                },
            });
            await firstPromise;
        });

        expect(result.current.tasks[0]?.name).toBe('Second rename');
    });

    it('does not roll back a newer update when an older update fails later', async () => {
        const firstUpdate = createDeferred<unknown>();
        const secondUpdate = createDeferred<unknown>();

        mockInvoke.mockImplementation((command: string, args?: { updates?: { target?: string } }) => {
            if (command === 'list_sync_tasks') {
                return Promise.resolve({
                    syncTasks: [
                        {
                            id: 'task-1',
                            name: 'Photos',
                            source: '/Volumes/CARD',
                            target: '/Volumes/Backup',
                            checksumMode: false,
                        },
                    ],
                });
            }

            if (command === 'update_sync_task' && args?.updates?.target === '/Volumes/Backup-A') {
                return firstUpdate.promise;
            }

            if (command === 'update_sync_task' && args?.updates?.target === '/Volumes/Backup-B') {
                return secondUpdate.promise;
            }

            return Promise.resolve(undefined);
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        let firstPromise!: Promise<void>;
        let secondPromise!: Promise<void>;
        await act(async () => {
            firstPromise = result.current.updateTask('task-1', { target: '/Volumes/Backup-A' });
            secondPromise = result.current.updateTask('task-1', { target: '/Volumes/Backup-B' });
        });

        expect(result.current.tasks[0]?.target).toBe('/Volumes/Backup-B');

        await act(async () => {
            secondUpdate.resolve({
                task: {
                    id: 'task-1',
                    name: 'Photos',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup-B',
                    checksumMode: false,
                },
            });
            await secondPromise;
        });

        await act(async () => {
            firstUpdate.reject(new Error('older update failed'));
            await expect(firstPromise).rejects.toThrow('older update failed');
        });

        expect(result.current.tasks[0]?.target).toBe('/Volumes/Backup-B');
    });

    it('ignores stale reload responses that resolve after a newer reload', async () => {
        const firstReload = createDeferred<unknown>();
        const secondReload = createDeferred<unknown>();

        mockInvoke.mockImplementation((command: string) => {
            if (command === 'list_sync_tasks') {
                if (mockInvoke.mock.calls.filter(([calledCommand]) => calledCommand === 'list_sync_tasks').length === 1) {
                    return Promise.resolve({
                        syncTasks: [
                            {
                                id: 'task-1',
                                name: 'Photos',
                                source: '/Volumes/CARD',
                                target: '/Volumes/Backup',
                                checksumMode: false,
                            },
                        ],
                    });
                }

                if (mockInvoke.mock.calls.filter(([calledCommand]) => calledCommand === 'list_sync_tasks').length === 2) {
                    return firstReload.promise;
                }

                return secondReload.promise;
            }

            return Promise.resolve(undefined);
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
            handler({ payload: { scope: 'syncTasks' } });
            handler({ payload: { scope: 'syncTasks' } });
        });

        await act(async () => {
            secondReload.resolve({
                syncTasks: [
                    {
                        id: 'task-3',
                        name: 'Newest',
                        source: '/Volumes/CARD',
                        target: '/Volumes/Archive-New',
                        checksumMode: true,
                    },
                ],
            });
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(result.current.tasks[0]?.id).toBe('task-3');
        });

        await act(async () => {
            firstReload.resolve({
                syncTasks: [
                    {
                        id: 'task-2',
                        name: 'Stale',
                        source: '/Volumes/CARD',
                        target: '/Volumes/Archive-Old',
                        checksumMode: true,
                    },
                ],
            });
            await Promise.resolve();
        });

        expect(result.current.tasks[0]?.id).toBe('task-3');
    });

    it('replays a deferred config-store reload after a local mutation settles', async () => {
        const updateRequest = createDeferred<unknown>();
        const deferredReload = createDeferred<unknown>();
        let listCallCount = 0;

        mockInvoke.mockImplementation((command: string, args?: { id?: string; updates?: { name?: string } }) => {
            if (command === 'list_sync_tasks') {
                listCallCount += 1;

                if (listCallCount === 1) {
                    return Promise.resolve({
                        syncTasks: [
                            {
                                id: 'task-1',
                                name: 'Photos',
                                source: '/Volumes/CARD',
                                target: '/Volumes/Backup',
                                checksumMode: false,
                            },
                        ],
                    });
                }

                if (listCallCount === 2) {
                    return deferredReload.promise;
                }

                return Promise.resolve({
                    syncTasks: [
                        {
                            id: 'task-external',
                            name: 'External Task',
                            source: '/Volumes/External',
                            target: '/Volumes/Archive',
                            checksumMode: true,
                        },
                    ],
                });
            }

            if (command === 'update_sync_task' && args?.id === 'task-1') {
                return updateRequest.promise;
            }

            return Promise.resolve(undefined);
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        const handler = eventHandlers.get('config-store-changed');
        if (!handler) {
            throw new Error('config-store-changed handler not found');
        }

        let updatePromise!: Promise<void>;
        await act(async () => {
            updatePromise = result.current.updateTask('task-1', { name: 'Local rename' });
        });

        expect(result.current.tasks[0]?.name).toBe('Local rename');

        act(() => {
            handler({ payload: { scope: 'syncTasks' } });
        });

        await waitFor(() => {
            expect(listCallCount).toBe(2);
        });

        await act(async () => {
            deferredReload.resolve({
                syncTasks: [
                    {
                        id: 'task-external',
                        name: 'External Task',
                        source: '/Volumes/External',
                        target: '/Volumes/Archive',
                        checksumMode: true,
                    },
                ],
            });
            await Promise.resolve();
        });

        expect(result.current.tasks[0]?.name).toBe('Local rename');

        await act(async () => {
            updateRequest.resolve({
                task: {
                    id: 'task-1',
                    name: 'Local rename',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup',
                    checksumMode: false,
                },
            });
            await updatePromise;
        });

        await waitFor(() => {
            expect(listCallCount).toBe(3);
            expect(result.current.tasks[0]?.id).toBe('task-external');
        });
    });

    it('replays a deferred parse error after a local mutation settles', async () => {
        const updateRequest = createDeferred<unknown>();
        const deferredReload = createDeferred<unknown>();
        let listCallCount = 0;

        mockInvoke.mockImplementation((command: string, args?: { id?: string }) => {
            if (command === 'list_sync_tasks') {
                listCallCount += 1;

                if (listCallCount === 1) {
                    return Promise.resolve({
                        syncTasks: [
                            {
                                id: 'task-1',
                                name: 'Photos',
                                source: '/Volumes/CARD',
                                target: '/Volumes/Backup',
                                checksumMode: false,
                            },
                        ],
                    });
                }

                if (listCallCount === 2) {
                    return deferredReload.promise;
                }

                return Promise.resolve({
                    error: {
                        type: 'PARSE_ERROR',
                        message: 'Broken YAML',
                        filePath: '/tmp/sync-tasks.yaml',
                        rawContent: 'syncTasks: [',
                    },
                });
            }

            if (command === 'update_sync_task' && args?.id === 'task-1') {
                return updateRequest.promise;
            }

            return Promise.resolve(undefined);
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        const handler = eventHandlers.get('config-store-changed');
        if (!handler) {
            throw new Error('config-store-changed handler not found');
        }

        let updatePromise!: Promise<void>;
        await act(async () => {
            updatePromise = result.current.updateTask('task-1', { name: 'Local rename' });
        });

        act(() => {
            handler({ payload: { scope: 'syncTasks' } });
        });

        await waitFor(() => {
            expect(listCallCount).toBe(2);
        });

        await act(async () => {
            deferredReload.resolve({
                error: {
                    type: 'PARSE_ERROR',
                    message: 'Broken YAML',
                    filePath: '/tmp/sync-tasks.yaml',
                    rawContent: 'syncTasks: [',
                },
            });
            await Promise.resolve();
        });

        expect(result.current.error).toBeNull();
        expect(result.current.tasks[0]?.name).toBe('Local rename');

        await act(async () => {
            updateRequest.resolve({
                task: {
                    id: 'task-1',
                    name: 'Local rename',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup',
                    checksumMode: false,
                },
            });
            await updatePromise;
        });

        await waitFor(() => {
            expect(listCallCount).toBe(3);
            expect(result.current.tasks).toHaveLength(0);
            expect(result.current.error).toEqual(
                expect.objectContaining({
                    type: 'PARSE_ERROR',
                    message: 'Broken YAML',
                    filePath: '/tmp/sync-tasks.yaml',
                }),
            );
        });
    });

    it('treats undefined recurringSchedules as an omitted update field', async () => {
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
                            recurringSchedules: [
                                {
                                    id: 'schedule-1',
                                    cronExpression: '0 9 * * *',
                                    timezone: 'Asia/Seoul',
                                    enabled: true,
                                    checksumMode: false,
                                    retentionCount: 20,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                task: {
                    id: 'task-1',
                    name: 'Photos renamed',
                    source: '/Volumes/CARD',
                    target: '/Volumes/Backup',
                    checksumMode: false,
                    recurringSchedules: [
                        {
                            id: 'schedule-1',
                            cronExpression: '0 9 * * *',
                            timezone: 'Asia/Seoul',
                            enabled: true,
                            checksumMode: false,
                            retentionCount: 20,
                        },
                    ],
                },
            };
        });

        const { result } = renderHook(() => useSyncTasks());

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        await act(async () => {
            await result.current.updateTask('task-1', {
                name: 'Photos renamed',
                recurringSchedules: undefined,
            });
        });

        expect(mockInvoke).toHaveBeenCalledWith(
            'update_sync_task',
            expect.objectContaining({
                id: 'task-1',
                updates: {
                    name: 'Photos renamed',
                },
            })
        );
        expect(result.current.tasks[0]?.recurringSchedules).toEqual([
            expect.objectContaining({
                id: 'schedule-1',
                cronExpression: '0 9 * * *',
            }),
        ]);
    });
});
