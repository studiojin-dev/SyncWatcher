import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useYamlStore } from './useYamlStore';

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
    /** UUID 볼륨 내 하위 경로 (예: /DCIM/100MSDCF) */
    sourceSubPath?: string;
}

interface PersistedSyncTask extends SyncTask {
    // Legacy fields that can still exist in old YAML files.
    enabled?: boolean;
    watching?: boolean;
    deleteMissing?: boolean;
}

function normalizeTask(task: PersistedSyncTask): SyncTask {
    return {
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
        sourceSubPath: task.sourceSubPath,
    };
}

export function useSyncTasks() {
    const { data: storedTasks, saveData: saveTasks, loaded, error, reload } = useYamlStore<PersistedSyncTask[]>({
        fileName: 'tasks.yaml',
        defaultData: [],
    });

    const migrationCheckedRef = useRef(false);
    const tasks = useMemo(() => storedTasks.map(normalizeTask), [storedTasks]);

    useEffect(() => {
        if (!loaded || migrationCheckedRef.current) {
            return;
        }

        migrationCheckedRef.current = true;
        const hasLegacyFields = storedTasks.some((task) =>
            'enabled' in task || 'watching' in task || 'deleteMissing' in task
        );
        if (!hasLegacyFields) {
            return;
        }

        void saveTasks(tasks);
    }, [loaded, storedTasks, tasks, saveTasks]);

    const addTask = useCallback(async (task: Omit<SyncTask, 'id'>) => {
        const newTask: SyncTask = {
            ...task,
            id: crypto.randomUUID(),
        };

        await saveTasks([...tasks, newTask]);
        return newTask;
    }, [tasks, saveTasks]);

    const updateTask = useCallback(async (id: string, updates: Partial<SyncTask>) => {
        const newTasks = tasks.map((t) =>
            t.id === id ? { ...t, ...updates } : t
        );
        await saveTasks(newTasks);
    }, [tasks, saveTasks]);

    const deleteTask = useCallback(async (id: string) => {
        await saveTasks(tasks.filter((t) => t.id !== id));
    }, [tasks, saveTasks]);

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
