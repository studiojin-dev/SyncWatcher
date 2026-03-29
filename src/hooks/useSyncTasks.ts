import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shouldEnableAutoUnmount } from '../utils/autoUnmount';
import {
    normalizeRecurringSchedules,
    type RecurringSchedule,
} from '../utils/recurringSchedules';
import type { YamlStoreError } from './useYamlStore';
import { listenConfigStoreChanged, parseConfigError, readConfigCollection, readConfigRecord } from '../utils/configStore';

export interface SyncTask {
    id: string;
    name: string;
    source: string;
    target: string;
    checksumMode: boolean;
    verifyAfterCopy?: boolean;
    exclusionSets?: string[];
    /** 감시 모드 - 소스 디렉토리 변경 시 자동 복사 */
    watchMode?: boolean;
    /** 복사 후 자동 unmount (removable 디스크) */
    autoUnmount?: boolean;
    /** 소스 타입: 'path' (기본) 또는 'uuid' */
    sourceType?: 'path' | 'uuid';
    /** UUID 기반 소스일 때 사용할 Disk UUID */
    sourceUuid?: string;
    /** UUID 기반 소스일 때 UUID 타입 */
    sourceUuidType?: 'disk' | 'volume';
    /** UUID 볼륨 내 하위 경로 (예: /DCIM/100MSDCF) */
    sourceSubPath?: string;
    /** UUID 소스 재식별을 위한 보조 스냅샷 */
    sourceIdentity?: {
        deviceSerial?: string;
        mediaUuid?: string;
        deviceGuid?: string;
        transportSerial?: string;
        busProtocol?: string;
        filesystemName?: string;
        totalBytes?: number;
        volumeName?: string;
        lastSeenDiskUuid?: string;
        lastSeenVolumeUuid?: string;
    };
    recurringSchedules?: RecurringSchedule[];
}

interface PersistedSyncTask extends SyncTask {
    // Legacy fields that can still exist in old YAML files.
    enabled?: boolean;
    watching?: boolean;
    deleteMissing?: boolean;
}

const DEFAULT_TASKS: PersistedSyncTask[] = [];

function isYamlStoreParseError(value: Partial<YamlStoreError> | null | undefined): value is YamlStoreError {
    return value?.type === 'PARSE_ERROR'
        && typeof value.message === 'string'
        && typeof value.filePath === 'string'
        && typeof value.rawContent === 'string';
}

function normalizeTask(task: PersistedSyncTask): SyncTask {
    const normalizedTask: SyncTask = {
        id: task.id,
        name: task.name,
        source: task.source,
        target: task.target,
        checksumMode: task.checksumMode ?? false,
        verifyAfterCopy: task.verifyAfterCopy ?? true,
        exclusionSets: task.exclusionSets ?? [],
        watchMode: task.watchMode ?? false,
        autoUnmount: task.autoUnmount ?? false,
        sourceType: task.sourceType,
        sourceUuid: task.sourceUuid,
        sourceUuidType: task.sourceUuidType,
        sourceSubPath: task.sourceSubPath,
        sourceIdentity: task.sourceIdentity,
        recurringSchedules: normalizeRecurringSchedules(task.recurringSchedules),
    };

    normalizedTask.autoUnmount = shouldEnableAutoUnmount(normalizedTask);
    return normalizedTask;
}

export function useSyncTasks() {
    const [storedTasks, setStoredTasks] = useState<PersistedSyncTask[]>(DEFAULT_TASKS);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<YamlStoreError | null>(null);
    const tasksRef = useRef<PersistedSyncTask[]>(DEFAULT_TASKS);
    const loadSeqRef = useRef(0);
    const mutationSeqRef = useRef(0);
    const pendingMutationCountRef = useRef(0);
    const taskMutationSeqRef = useRef<Map<string, number>>(new Map());
    const deferredLoadRequestedRef = useRef(false);
    const loadTasksRef = useRef<() => Promise<void>>(async () => {});
    const tasks = useMemo(() => storedTasks.map(normalizeTask), [storedTasks]);

    useEffect(() => {
        tasksRef.current = storedTasks;
    }, [storedTasks]);

    const commitTasks = useCallback((nextTasks: PersistedSyncTask[]) => {
        tasksRef.current = nextTasks;
        setStoredTasks(nextTasks);
    }, []);

    const beginTaskMutation = useCallback((taskId: string) => {
        const mutationSeq = mutationSeqRef.current + 1;
        mutationSeqRef.current = mutationSeq;
        pendingMutationCountRef.current += 1;
        taskMutationSeqRef.current.set(taskId, mutationSeq);
        return mutationSeq;
    }, []);

    const endTaskMutation = useCallback((taskId: string, mutationSeq: number) => {
        pendingMutationCountRef.current = Math.max(0, pendingMutationCountRef.current - 1);
        if (taskMutationSeqRef.current.get(taskId) === mutationSeq) {
            taskMutationSeqRef.current.delete(taskId);
        }
    }, []);

    const flushDeferredLoadIfIdle = useCallback(() => {
        if (pendingMutationCountRef.current !== 0 || !deferredLoadRequestedRef.current) {
            return;
        }

        deferredLoadRequestedRef.current = false;
        void loadTasksRef.current();
    }, []);

    const requestDeferredLoadReplay = useCallback(() => {
        deferredLoadRequestedRef.current = true;
        flushDeferredLoadIfIdle();
    }, [flushDeferredLoadIfIdle]);

    const loadTasks = useCallback(async () => {
        const loadSeq = loadSeqRef.current + 1;
        loadSeqRef.current = loadSeq;
        const mutationSeqAtStart = mutationSeqRef.current;
        const startedWithPendingMutations = pendingMutationCountRef.current > 0;

        try {
            const response = await invoke<unknown>('list_sync_tasks');
            if (loadSeq !== loadSeqRef.current) {
                return;
            }

            const responseError = readConfigRecord<YamlStoreError>(response, ['error']);
            if (isYamlStoreParseError(responseError)) {
                if (
                    startedWithPendingMutations
                    || pendingMutationCountRef.current > 0
                    || mutationSeqAtStart !== mutationSeqRef.current
                ) {
                    requestDeferredLoadReplay();
                    return;
                }
                commitTasks(DEFAULT_TASKS);
                setError(responseError);
                return;
            }

            const nextTasks = readConfigCollection<PersistedSyncTask>(response, ['tasks', 'syncTasks']);
            if (
                startedWithPendingMutations
                || pendingMutationCountRef.current > 0
                || mutationSeqAtStart !== mutationSeqRef.current
            ) {
                requestDeferredLoadReplay();
                return;
            }
            commitTasks(nextTasks);
            setError(null);
        } catch (err) {
            if (loadSeq !== loadSeqRef.current) {
                return;
            }

            const parsedError = parseConfigError(err);
            const nextError = readConfigRecord<YamlStoreError>(parsedError, ['error']);
            if (
                !startedWithPendingMutations
                && pendingMutationCountRef.current === 0
                && mutationSeqAtStart === mutationSeqRef.current
            ) {
                commitTasks(DEFAULT_TASKS);
                setError(isYamlStoreParseError(nextError) ? nextError : null);
            } else {
                requestDeferredLoadReplay();
            }
            console.error('Failed to load sync tasks:', err);
        } finally {
            if (loadSeq === loadSeqRef.current) {
                setLoaded(true);
            }
        }
    }, [commitTasks, requestDeferredLoadReplay]);

    useEffect(() => {
        loadTasksRef.current = loadTasks;
    }, [loadTasks]);

    useEffect(() => {
        void loadTasks();

        let disposed = false;
        const unlistenPromise = listenConfigStoreChanged(['syncTasks'], () => {
            if (!disposed) {
                void loadTasks();
            }
        });

        return () => {
            disposed = true;
            void unlistenPromise
                .then((unlisten) => unlisten())
                .catch((error) => {
                    console.warn('Failed to unlisten config-store-changed for sync tasks', error);
                });
        };
    }, [loadTasks]);

    const addTask = useCallback(async (task: Omit<SyncTask, 'id'>) => {
        const newTask: SyncTask = {
            ...task,
            id: crypto.randomUUID(),
            recurringSchedules: normalizeRecurringSchedules(task.recurringSchedules),
        };
        newTask.autoUnmount = shouldEnableAutoUnmount(newTask);
        const mutationSeq = beginTaskMutation(newTask.id);

        const nextTasks = [...tasksRef.current, newTask];
        commitTasks(nextTasks);

        try {
            const response = await invoke<unknown>('create_sync_task', { task: newTask });
            const persistedTask = readConfigRecord<SyncTask>(response, ['task', 'syncTask']);
            if (persistedTask && taskMutationSeqRef.current.get(newTask.id) === mutationSeq) {
                const normalizedTask = normalizeTask(persistedTask as PersistedSyncTask);
                const persistedTasks = tasksRef.current.map((candidate) =>
                    candidate.id === newTask.id ? normalizedTask : candidate
                );
                commitTasks(persistedTasks);
            }
            setError(null);
        } catch (err) {
            if (taskMutationSeqRef.current.get(newTask.id) === mutationSeq) {
                commitTasks(tasksRef.current.filter((candidate) => candidate.id !== newTask.id));
            }
            throw err;
        } finally {
            endTaskMutation(newTask.id, mutationSeq);
            flushDeferredLoadIfIdle();
        }

        return newTask;
    }, [beginTaskMutation, commitTasks, endTaskMutation, flushDeferredLoadIfIdle]);

    const updateTask = useCallback(async (id: string, updates: Partial<SyncTask>) => {
        const mutationSeq = beginTaskMutation(id);
        const previousTasks = tasksRef.current;
        const normalizedUpdates = Object.prototype.hasOwnProperty.call(updates, 'recurringSchedules')
            ? {
                ...updates,
                recurringSchedules: normalizeRecurringSchedules(updates.recurringSchedules),
            }
            : updates;
        const newTasks = previousTasks.map((t) =>
            t.id === id
                ? {
                    ...t,
                    ...normalizedUpdates,
                    autoUnmount: shouldEnableAutoUnmount({
                        ...t,
                        ...normalizedUpdates,
                    }),
                }
                : t
        );
        commitTasks(newTasks);

        try {
            const response = await invoke<unknown>('update_sync_task', {
                id,
                updates: normalizedUpdates,
            });
            const persistedTask = readConfigRecord<SyncTask>(response, ['task', 'syncTask']);
            if (persistedTask && taskMutationSeqRef.current.get(id) === mutationSeq) {
                const normalizedTask = normalizeTask(persistedTask as PersistedSyncTask);
                const persistedTasks = tasksRef.current.map((candidate) =>
                    candidate.id === id ? normalizedTask : candidate
                );
                commitTasks(persistedTasks);
            }
            setError(null);
        } catch (err) {
            if (taskMutationSeqRef.current.get(id) === mutationSeq) {
                commitTasks(previousTasks);
            }
            throw err;
        } finally {
            endTaskMutation(id, mutationSeq);
            flushDeferredLoadIfIdle();
        }
    }, [beginTaskMutation, commitTasks, endTaskMutation, flushDeferredLoadIfIdle]);

    const deleteTask = useCallback(async (id: string) => {
        const mutationSeq = beginTaskMutation(id);
        const previousTasks = tasksRef.current;
        const nextTasks = previousTasks.filter((task) => task.id !== id);
        commitTasks(nextTasks);

        try {
            await invoke('delete_sync_task', { id });
            setError(null);
        } catch (err) {
            if (taskMutationSeqRef.current.get(id) === mutationSeq) {
                commitTasks(previousTasks);
            }
            throw err;
        } finally {
            endTaskMutation(id, mutationSeq);
            flushDeferredLoadIfIdle();
        }
    }, [beginTaskMutation, commitTasks, endTaskMutation, flushDeferredLoadIfIdle]);

    const reload = useCallback(async () => {
        setError(null);
        await loadTasks();
    }, [loadTasks]);

    return {
        tasks,
        loaded,
        addTask,
        updateTask,
        deleteTask,
        error,
        reload,
    };
}

export default useSyncTasks;
