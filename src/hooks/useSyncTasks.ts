import { useState, useEffect, useCallback } from 'react';

export interface SyncTask {
    id: string;
    name: string;
    source: string;
    target: string;
    enabled: boolean;
    deleteMissing: boolean;
    checksumMode: boolean;
}

const STORAGE_KEY = 'syncwatcher_tasks';

/**
 * Hook for managing sync tasks with localStorage persistence
 */
export function useSyncTasks() {
    const [tasks, setTasks] = useState<SyncTask[]>([]);
    const [loaded, setLoaded] = useState(false);

    // Load tasks from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                setTasks(JSON.parse(stored));
            }
        } catch (err) {
            console.error('Failed to load tasks:', err);
        }
        setLoaded(true);
    }, []);

    // Save to localStorage whenever tasks change
    const saveTasks = useCallback((newTasks: SyncTask[]) => {
        setTasks(newTasks);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newTasks));
        } catch (err) {
            console.error('Failed to save tasks:', err);
        }
    }, []);

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
        updateTask(id, { enabled: !tasks.find((t) => t.id === id)?.enabled });
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
