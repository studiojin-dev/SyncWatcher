import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncTasksContext } from '../../context/SyncTasksContext';
import { useExclusionSetsContext } from '../../context/ExclusionSetsContext';
import { useSettings } from '../../hooks/useSettings';
import { useSyncTaskStatusStore } from '../../hooks/useSyncTaskStatus';
import { useToast } from '../ui/Toast';
import {
    RuntimeConfigPayload,
    RuntimeState,
    RuntimeSyncQueueStateEvent,
    RuntimeSyncStateEvent,
    RuntimeWatchStateEvent,
    toRuntimeExclusionSet,
    toRuntimeTask,
} from '../../types/runtime';

interface SyncProgressEvent {
    taskId?: string;
    message?: string;
    current?: number;
    total?: number;
    processedBytes?: number;
    totalBytes?: number;
    currentFileBytesCopied?: number;
    currentFileTotalBytes?: number;
}

export type InitialRuntimeSyncState = 'idle' | 'pending' | 'success' | 'error';

interface BackendRuntimeBridgeProps {
    onInitialRuntimeSyncChange?: (state: InitialRuntimeSyncState) => void;
}

const QUEUED_STATUS_DEMOTION_DELAY_MS = 80;
const INITIAL_RUNTIME_SYNC_TIMEOUT_MS = 10_000;
const RUNTIME_SYNC_ERROR_TOAST_DEDUP_WINDOW_MS = 3_000;

function applyRuntimeSnapshotToStore(state: RuntimeState) {
    const store = useSyncTaskStatusStore.getState();
    store.setWatchingTasks(state.watchingTasks);
    store.setSyncingTasks(state.syncingTasks);
    store.setQueuedTasks(state.queuedTasks);

    for (const taskId of state.watchingTasks) {
        const currentStatus = store.getStatus(taskId)?.status;
        if (currentStatus !== 'syncing' && currentStatus !== 'queued') {
            store.setStatus(taskId, 'watching');
        }
    }

    for (const taskId of state.queuedTasks) {
        const currentStatus = store.getStatus(taskId)?.status;
        if (currentStatus !== 'syncing') {
            store.setStatus(taskId, 'queued');
        }
    }

    for (const taskId of state.syncingTasks) {
        store.setStatus(taskId, 'syncing');
    }
}

function hasTauriInvokeBridge(): boolean {
    const maybeWindow = globalThis as typeof globalThis & {
        __TAURI_INTERNALS__?: {
            invoke?: unknown;
        };
    };
    return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === 'function';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(timeoutMessage));
        }, timeoutMs);

        promise
            .then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

function shouldShowRuntimeSyncErrorToast(
    previous: { message: string; at: number } | null,
    nextMessage: string,
    now: number
): boolean {
    if (!previous) {
        return true;
    }
    if (previous.message !== nextMessage) {
        return true;
    }
    return now - previous.at > RUNTIME_SYNC_ERROR_TOAST_DEDUP_WINDOW_MS;
}

function BackendRuntimeBridge({ onInitialRuntimeSyncChange }: BackendRuntimeBridgeProps) {
    const { tasks, loaded: tasksLoaded } = useSyncTasksContext();
    const { sets, loaded: setsLoaded } = useExclusionSetsContext();
    const { settings, loaded: settingsLoaded } = useSettings();
    const { showToast } = useToast();
    const ready = tasksLoaded && setsLoaded && settingsLoaded;
    const watchingTasksRef = useRef<Set<string>>(new Set());
    const initialSyncResolvedRef = useRef(false);
    const queuedStatusDemotionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const lastRuntimeSyncErrorToastRef = useRef<{ message: string; at: number } | null>(null);

    const payload = useMemo<RuntimeConfigPayload>(() => ({
        tasks: tasks.map(toRuntimeTask),
        exclusionSets: sets.map(toRuntimeExclusionSet),
        settings: {
            dataUnitSystem: settings.dataUnitSystem,
        },
    }), [tasks, sets, settings.dataUnitSystem]);

    useEffect(() => {
        const unlistenProgress = listen<SyncProgressEvent>('sync-progress', (event) => {
            if (!event.payload.taskId) {
                return;
            }

            const store = useSyncTaskStatusStore.getState();
            const taskId = event.payload.taskId;
            const message = event.payload.message || 'Syncing...';
            store.setProgress(taskId, {
                current: event.payload.current || 0,
                total: event.payload.total || 0,
                currentFile: event.payload.message,
                processedBytes: event.payload.processedBytes || 0,
                totalBytes: event.payload.totalBytes || 0,
                currentFileBytesCopied: event.payload.currentFileBytesCopied || 0,
                currentFileTotalBytes: event.payload.currentFileTotalBytes || 0,
            });

            const previousMessage = store.getStatus(taskId)?.lastLog?.message;
            if (previousMessage !== message) {
                store.setLastLog(taskId, {
                    message,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'info',
                });
            }
        });

        const unlistenWatchState = listen<RuntimeWatchStateEvent>('runtime-watch-state', (event) => {
            const { taskId, watching, reason } = event.payload;
            const store = useSyncTaskStatusStore.getState();

            store.setWatching(taskId, watching);
            if (watching) {
                watchingTasksRef.current.add(taskId);
                const currentStatus = store.getStatus(taskId)?.status;
                if (currentStatus !== 'syncing' && currentStatus !== 'queued') {
                    store.setStatus(taskId, 'watching');
                }
            } else {
                watchingTasksRef.current.delete(taskId);
                const currentStatus = store.getStatus(taskId)?.status;
                if (currentStatus !== 'syncing' && currentStatus !== 'queued') {
                    store.setStatus(taskId, 'idle');
                }
            }

            if (reason) {
                store.setLastLog(taskId, {
                    message: reason,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'warning',
                });
            }
        });

        const unlistenQueueState = listen<RuntimeSyncQueueStateEvent>('runtime-sync-queue-state', (event) => {
            const { taskId, queued, reason } = event.payload;
            const store = useSyncTaskStatusStore.getState();

            store.setQueued(taskId, queued);

            const previousTimer = queuedStatusDemotionTimersRef.current.get(taskId);
            if (previousTimer) {
                clearTimeout(previousTimer);
                queuedStatusDemotionTimersRef.current.delete(taskId);
            }

            if (!queued && store.getStatus(taskId)?.status === 'queued') {
                const demotionTimer = setTimeout(() => {
                    queuedStatusDemotionTimersRef.current.delete(taskId);

                    const nextStore = useSyncTaskStatusStore.getState();
                    if (nextStore.queuedTaskIds.has(taskId) || nextStore.syncingTaskIds.has(taskId)) {
                        return;
                    }

                    if (nextStore.getStatus(taskId)?.status === 'queued') {
                        const isWatching = watchingTasksRef.current.has(taskId);
                        nextStore.setStatus(taskId, isWatching ? 'watching' : 'idle');
                    }
                }, QUEUED_STATUS_DEMOTION_DELAY_MS);
                queuedStatusDemotionTimersRef.current.set(taskId, demotionTimer);
            }

            if (reason) {
                store.setLastLog(taskId, {
                    message: reason,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'info',
                });
            }
        });

        const unlistenSyncState = listen<RuntimeSyncStateEvent>('runtime-sync-state', (event) => {
            const { taskId, syncing, reason } = event.payload;
            const store = useSyncTaskStatusStore.getState();

            const pendingDemotion = queuedStatusDemotionTimersRef.current.get(taskId);
            if (pendingDemotion) {
                clearTimeout(pendingDemotion);
                queuedStatusDemotionTimersRef.current.delete(taskId);
            }
            store.setSyncing(taskId, syncing);

            if (syncing) {
                store.setQueued(taskId, false);
                store.setStatus(taskId, 'syncing');
                return;
            }

            store.setProgress(taskId, {
                current: 0,
                total: 0,
                currentFile: undefined,
                processedBytes: 0,
                totalBytes: 0,
                currentFileBytesCopied: 0,
                currentFileTotalBytes: 0,
            });

            if (reason) {
                store.setLastLog(taskId, {
                    message: reason,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'error',
                });
            }

            const isQueued = store.queuedTaskIds.has(taskId);
            if (isQueued) {
                store.setStatus(taskId, 'queued');
                return;
            }

            const isWatching = watchingTasksRef.current.has(taskId);
            store.setStatus(taskId, isWatching ? 'watching' : 'idle');
        });

        return () => {
            queuedStatusDemotionTimersRef.current.forEach((timer) => clearTimeout(timer));
            queuedStatusDemotionTimersRef.current.clear();
            unlistenProgress.then((fn) => fn());
            unlistenWatchState.then((fn) => fn());
            unlistenQueueState.then((fn) => fn());
            unlistenSyncState.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        if (!ready) {
            return;
        }

        let cancelled = false;
        const isInitialSyncAttempt = !initialSyncResolvedRef.current;

        if (!hasTauriInvokeBridge()) {
            if (isInitialSyncAttempt) {
                initialSyncResolvedRef.current = true;
                onInitialRuntimeSyncChange?.('error');
            }
            return;
        }

        const syncRuntimeConfig = async () => {
            if (isInitialSyncAttempt) {
                onInitialRuntimeSyncChange?.('pending');
            }

            try {
                const invokePromise = invoke<RuntimeState>('runtime_set_config', { payload });
                const nextState = isInitialSyncAttempt
                    ? await withTimeout(
                        invokePromise,
                        INITIAL_RUNTIME_SYNC_TIMEOUT_MS,
                        `runtime_set_config timed out after ${INITIAL_RUNTIME_SYNC_TIMEOUT_MS}ms`
                    )
                    : await invokePromise;
                if (cancelled) {
                    return;
                }

                watchingTasksRef.current = new Set(nextState.watchingTasks);
                applyRuntimeSnapshotToStore(nextState);

                if (isInitialSyncAttempt) {
                    initialSyncResolvedRef.current = true;
                    onInitialRuntimeSyncChange?.('success');
                }
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.error('Runtime sync command failed', {
                    command: 'runtime_set_config',
                    taskCount: payload.tasks.length,
                    exclusionSetCount: payload.exclusionSets.length,
                    error: errorMessage,
                });
                useSyncTaskStatusStore.getState().setLastLog('__runtime__', {
                    message: `[runtime_set_config] ${errorMessage}`,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'error',
                });
                const now = Date.now();
                if (shouldShowRuntimeSyncErrorToast(lastRuntimeSyncErrorToastRef.current, errorMessage, now)) {
                    showToast('Failed to apply runtime configuration', 'error');
                    lastRuntimeSyncErrorToastRef.current = {
                        message: errorMessage,
                        at: now,
                    };
                }

                if (isInitialSyncAttempt) {
                    initialSyncResolvedRef.current = true;
                    onInitialRuntimeSyncChange?.('error');
                }
            }
        };

        void syncRuntimeConfig();

        return () => {
            cancelled = true;
        };
    }, [ready, payload, onInitialRuntimeSyncChange, showToast]);

    return null;
}

export default BackendRuntimeBridge;
