import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncTasksContext } from '../../context/SyncTasksContext';
import { useExclusionSetsContext } from '../../context/ExclusionSetsContext';
import { useSyncTaskStatusStore } from '../../hooks/useSyncTaskStatus';
import { useToast } from '../ui/Toast';
import {
    RuntimeConfigPayload,
    RuntimeState,
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
}

export type InitialRuntimeSyncState = 'idle' | 'pending' | 'success' | 'error';

interface BackendRuntimeBridgeProps {
    onInitialRuntimeSyncChange?: (state: InitialRuntimeSyncState) => void;
}

function applyRuntimeSnapshotToStore(state: RuntimeState) {
    const store = useSyncTaskStatusStore.getState();
    store.setWatchingTasks(state.watchingTasks);

    for (const taskId of state.watchingTasks) {
        const currentStatus = store.getStatus(taskId)?.status;
        if (currentStatus !== 'syncing') {
            store.setStatus(taskId, 'watching');
        }
    }

    for (const taskId of state.syncingTasks) {
        store.setStatus(taskId, 'syncing');
    }
}

function BackendRuntimeBridge({ onInitialRuntimeSyncChange }: BackendRuntimeBridgeProps) {
    const { tasks, loaded: tasksLoaded } = useSyncTasksContext();
    const { sets, loaded: setsLoaded } = useExclusionSetsContext();
    const { showToast } = useToast();
    const ready = tasksLoaded && setsLoaded;
    const watchingTasksRef = useRef<Set<string>>(new Set());
    const initialSyncResolvedRef = useRef(false);

    const payload = useMemo<RuntimeConfigPayload>(() => ({
        tasks: tasks.map(toRuntimeTask),
        exclusionSets: sets.map(toRuntimeExclusionSet),
    }), [tasks, sets]);

    useEffect(() => {
        const unlistenProgress = listen<SyncProgressEvent>('sync-progress', (event) => {
            if (!event.payload.taskId) {
                return;
            }

            useSyncTaskStatusStore.getState().setLastLog(event.payload.taskId, {
                message: event.payload.message || 'Syncing...',
                timestamp: new Date().toLocaleTimeString(),
                level: 'info',
            });
        });

        const unlistenWatchState = listen<RuntimeWatchStateEvent>('runtime-watch-state', (event) => {
            const { taskId, watching, reason } = event.payload;
            const store = useSyncTaskStatusStore.getState();

            store.setWatching(taskId, watching);
            if (watching) {
                watchingTasksRef.current.add(taskId);
                if (store.getStatus(taskId)?.status !== 'syncing') {
                    store.setStatus(taskId, 'watching');
                }
            } else {
                watchingTasksRef.current.delete(taskId);
                if (store.getStatus(taskId)?.status !== 'syncing') {
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

        const unlistenSyncState = listen<RuntimeSyncStateEvent>('runtime-sync-state', (event) => {
            const { taskId, syncing, reason } = event.payload;
            const store = useSyncTaskStatusStore.getState();

            if (syncing) {
                store.setStatus(taskId, 'syncing');
                return;
            }

            if (reason) {
                store.setLastLog(taskId, {
                    message: reason,
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'error',
                });
            }

            const isWatching = watchingTasksRef.current.has(taskId);
            store.setStatus(taskId, isWatching ? 'watching' : 'idle');
        });

        return () => {
            unlistenProgress.then((fn) => fn());
            unlistenWatchState.then((fn) => fn());
            unlistenSyncState.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        if (!ready) {
            return;
        }

        let cancelled = false;
        const isInitialSyncAttempt = !initialSyncResolvedRef.current;

        const syncRuntimeConfig = async () => {
            if (isInitialSyncAttempt) {
                onInitialRuntimeSyncChange?.('pending');
            }

            try {
                const nextState = await invoke<RuntimeState>('runtime_set_config', { payload });
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
                showToast('Failed to apply runtime configuration', 'error');

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
