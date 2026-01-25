import { useCallback } from 'react';
import { useYamlStore } from './useYamlStore';

export interface SyncTask {
    id: string;
    name: string;
    source: string;
    target: string;
    enabled: boolean;
    deleteMissing: boolean;
    checksumMode: boolean;
    watching?: boolean;
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

export function useSyncTasks() {
    const { data: tasks, saveData: saveTasks, loaded, error, reload } = useYamlStore<SyncTask[]>({
        fileName: 'tasks.yaml',
        defaultData: [],
    });

    const addTask = useCallback((task: Omit<SyncTask, 'id'>) => {
        const newTask: SyncTask = {
            ...task,
            id: crypto.randomUUID(),
        };
        saveTasks([...tasks, newTask]);
        return newTask;
    }, [tasks, saveTasks]);

    const updateTask = useCallback((id: string, updates: Partial<SyncTask>) => {
        const newTasks = tasks.map((t) =>
            t.id === id ? { ...t, ...updates } : t
        );
        saveTasks(newTasks);
    }, [tasks, saveTasks]);

    const deleteTask = useCallback((id: string) => {
        saveTasks(tasks.filter((t) => t.id !== id));
    }, [tasks, saveTasks]);

    const toggleTask = useCallback((id: string) => {
        const task = tasks.find((t) => t.id === id);
        if (task) {
            updateTask(id, { enabled: !task.enabled });
        }
    }, [tasks, updateTask]);

    return {
        tasks,
        loaded,
        addTask,
        updateTask,
        deleteTask,
        toggleTask,
        error,
        reload,
    };
}

export default useSyncTasks;
