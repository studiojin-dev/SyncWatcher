import { createContext, useContext, ReactNode } from 'react';
import { useSyncTasks } from '../hooks/useSyncTasks';

type SyncTasksContextValue = ReturnType<typeof useSyncTasks>;

const SyncTasksContext = createContext<SyncTasksContextValue | null>(null);

export function SyncTasksProvider({ children }: { children: ReactNode }) {
    const value = useSyncTasks();
    return (
        <SyncTasksContext.Provider value={value}>
            {children}
        </SyncTasksContext.Provider>
    );
}

export function useSyncTasksContext() {
    const context = useContext(SyncTasksContext);
    if (!context) {
        throw new Error('useSyncTasksContext must be used within a SyncTasksProvider');
    }
    return context;
}
