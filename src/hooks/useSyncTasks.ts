import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shouldEnableAutoUnmount } from '../utils/autoUnmount';
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
}

interface PersistedSyncTask extends SyncTask {
    // Legacy fields that can still exist in old YAML files.
    enabled?: boolean;
    watching?: boolean;
    deleteMissing?: boolean;
}

const DEFAULT_TASKS: PersistedSyncTask[] = [];

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
    };

    normalizedTask.autoUnmount = shouldEnableAutoUnmount(normalizedTask);
    return normalizedTask;
}

export function useSyncTasks() {
    const [storedTasks, setStoredTasks] = useState<PersistedSyncTask[]>(DEFAULT_TASKS);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<YamlStoreError | null>(null);
    const tasksRef = useRef<PersistedSyncTask[]>(DEFAULT_TASKS);
    const tasks = useMemo(() => storedTasks.map(normalizeTask), [storedTasks]);

    useEffect(() => {
        tasksRef.current = storedTasks;
    }, [storedTasks]);

    const loadTasks = useCallback(async () => {
        try {
            const response = await invoke<unknown>('list_sync_tasks');
            const responseError = readConfigRecord<YamlStoreError>(response, ['error']);
            if (responseError && responseError.type === 'PARSE_ERROR') {
                setStoredTasks(DEFAULT_TASKS);
                setError(responseError as YamlStoreError);
                return;
            }

            const nextTasks = readConfigCollection<PersistedSyncTask>(response, ['tasks', 'syncTasks']);
            setStoredTasks(nextTasks);
            setError(null);
        } catch (err) {
            const parsedError = parseConfigError(err);
            const nextError = readConfigRecord<YamlStoreError>(parsedError, ['error']);
            setStoredTasks(DEFAULT_TASKS);
            setError(nextError && nextError.type === 'PARSE_ERROR' ? nextError as YamlStoreError : null);
            console.error('Failed to load sync tasks:', err);
        } finally {
            setLoaded(true);
        }
    }, []);

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
        };
        newTask.autoUnmount = shouldEnableAutoUnmount(newTask);

        const nextTasks = [...tasksRef.current, newTask];
        tasksRef.current = nextTasks;
        setStoredTasks(nextTasks);

        try {
            const response = await invoke<unknown>('create_sync_task', { task: newTask });
            const persistedTask = readConfigRecord<SyncTask>(response, ['task', 'syncTask']);
            if (persistedTask) {
                const normalizedTask = normalizeTask(persistedTask as PersistedSyncTask);
                const persistedTasks = nextTasks.map((candidate) =>
                    candidate.id === newTask.id ? normalizedTask : candidate
                );
                tasksRef.current = persistedTasks;
                setStoredTasks(persistedTasks);
            }
            setError(null);
        } catch (err) {
            tasksRef.current = tasksRef.current.filter((candidate) => candidate.id !== newTask.id);
            setStoredTasks(tasksRef.current);
            throw err;
        }

        return newTask;
    }, []);

    const updateTask = useCallback(async (id: string, updates: Partial<SyncTask>) => {
        const previousTasks = tasksRef.current;
        const newTasks = previousTasks.map((t) =>
            t.id === id
                ? {
                    ...t,
                    ...updates,
                    autoUnmount: shouldEnableAutoUnmount({
                        ...t,
                        ...updates,
                    }),
                }
                : t
        );
        tasksRef.current = newTasks;
        setStoredTasks(newTasks);

        try {
            const response = await invoke<unknown>('update_sync_task', { id, updates });
            const persistedTask = readConfigRecord<SyncTask>(response, ['task', 'syncTask']);
            if (persistedTask) {
                const normalizedTask = normalizeTask(persistedTask as PersistedSyncTask);
                const persistedTasks = newTasks.map((candidate) =>
                    candidate.id === id ? normalizedTask : candidate
                );
                tasksRef.current = persistedTasks;
                setStoredTasks(persistedTasks);
            }
            setError(null);
        } catch (err) {
            tasksRef.current = previousTasks;
            setStoredTasks(previousTasks);
            throw err;
        }
    }, []);

    const deleteTask = useCallback(async (id: string) => {
        const previousTasks = tasksRef.current;
        const nextTasks = previousTasks.filter((task) => task.id !== id);
        tasksRef.current = nextTasks;
        setStoredTasks(nextTasks);

        try {
            await invoke('delete_sync_task', { id });
            setError(null);
        } catch (err) {
            tasksRef.current = previousTasks;
            setStoredTasks(previousTasks);
            throw err;
        }
    }, []);

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
