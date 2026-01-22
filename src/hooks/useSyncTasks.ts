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
}

export function useSyncTasks() {
    const { data: tasks, saveData: saveTasks, loaded } = useYamlStore<SyncTask[]>({
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
    };
}

export default useSyncTasks;
