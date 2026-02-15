import { create } from 'zustand';

export interface TaskStatus {
    taskId: string;
    status: 'idle' | 'queued' | 'syncing' | 'dryRunning' | 'watching';
    lastLog?: {
        message: string;
        timestamp: string;
        level: 'info' | 'success' | 'warning' | 'error';
    };
    progress?: {
        current: number;
        total: number;
        currentFile?: string;
    };
}

interface SyncTaskStatusStore {
    /** 각 Task의 상태 맵 */
    statuses: Map<string, TaskStatus>;
    /** 런타임에서 감시 중인 Task ID 집합 */
    watchingTaskIds: Set<string>;
    /** 런타임 동기화 대기열에 있는 Task ID 집합 */
    queuedTaskIds: Set<string>;

    /** 상태 업데이트 */
    setStatus: (taskId: string, status: TaskStatus['status']) => void;

    /** 마지막 로그 업데이트 */
    setLastLog: (taskId: string, log: TaskStatus['lastLog']) => void;

    /** 진행률 업데이트 */
    setProgress: (taskId: string, progress: TaskStatus['progress']) => void;

    /** 상태 조회 */
    getStatus: (taskId: string) => TaskStatus | undefined;

    /** 감시 상태 업데이트 */
    setWatching: (taskId: string, watching: boolean) => void;

    /** 감시 상태 일괄 업데이트 */
    setWatchingTasks: (taskIds: string[]) => void;

    /** 큐 상태 업데이트 */
    setQueued: (taskId: string, queued: boolean) => void;

    /** 큐 상태 일괄 업데이트 */
    setQueuedTasks: (taskIds: string[]) => void;

    /** 상태 초기화 */
    clearStatus: (taskId: string) => void;
}

/**
 * Sync Task 상태 관리 스토어
 * 뷰 전환 시에도 상태 유지
 */
export const useSyncTaskStatusStore = create<SyncTaskStatusStore>((set, get) => ({
    statuses: new Map<string, TaskStatus>(),
    watchingTaskIds: new Set<string>(),
    queuedTaskIds: new Set<string>(),

    setStatus: (taskId, status) => {
        set((state) => {
            const newStatuses = new Map(state.statuses);
            const current = newStatuses.get(taskId) || { taskId, status: 'idle' };
            newStatuses.set(taskId, { ...current, status });
            return { statuses: newStatuses };
        });
    },

    setLastLog: (taskId, log) => {
        set((state) => {
            const newStatuses = new Map(state.statuses);
            const current = newStatuses.get(taskId) || { taskId, status: 'idle' };
            newStatuses.set(taskId, { ...current, lastLog: log });
            return { statuses: newStatuses };
        });
    },

    setProgress: (taskId, progress) => {
        set((state) => {
            const newStatuses = new Map(state.statuses);
            const current = newStatuses.get(taskId) || { taskId, status: 'idle' };
            newStatuses.set(taskId, { ...current, progress });
            return { statuses: newStatuses };
        });
    },

    getStatus: (taskId) => {
        return get().statuses.get(taskId);
    },

    setWatching: (taskId, watching) => {
        set((state) => {
            const nextWatching = new Set(state.watchingTaskIds);
            if (watching) {
                nextWatching.add(taskId);
            } else {
                nextWatching.delete(taskId);
            }
            return { watchingTaskIds: nextWatching };
        });
    },

    setWatchingTasks: (taskIds) => {
        set({ watchingTaskIds: new Set(taskIds) });
    },

    setQueued: (taskId, queued) => {
        set((state) => {
            const nextQueued = new Set(state.queuedTaskIds);
            if (queued) {
                nextQueued.add(taskId);
                const newStatuses = new Map(state.statuses);
                const current = newStatuses.get(taskId) || { taskId, status: 'idle' as const };
                if (current.status !== 'syncing') {
                    newStatuses.set(taskId, { ...current, status: 'queued' });
                }
                return { queuedTaskIds: nextQueued, statuses: newStatuses };
            }

            nextQueued.delete(taskId);
            return { queuedTaskIds: nextQueued };
        });
    },

    setQueuedTasks: (taskIds) => {
        set({ queuedTaskIds: new Set(taskIds) });
    },

    clearStatus: (taskId) => {
        set((state) => {
            const newStatuses = new Map(state.statuses);
            newStatuses.delete(taskId);
            return { statuses: newStatuses };
        });
    },
}));

/**
 * 단일 Task의 상태를 조회하는 Hook
 */
export function useSyncTaskStatus(taskId: string) {
    const status = useSyncTaskStatusStore((state) => state.statuses.get(taskId));
    const setStatus = useSyncTaskStatusStore((state) => state.setStatus);
    const setLastLog = useSyncTaskStatusStore((state) => state.setLastLog);
    const setProgress = useSyncTaskStatusStore((state) => state.setProgress);
    const clearStatus = useSyncTaskStatusStore((state) => state.clearStatus);

    return {
        status: status?.status || 'idle',
        lastLog: status?.lastLog,
        progress: status?.progress,
        setStatus: (newStatus: TaskStatus['status']) => setStatus(taskId, newStatus),
        setLastLog: (log: TaskStatus['lastLog']) => setLastLog(taskId, log),
        setProgress: (progress: TaskStatus['progress']) => setProgress(taskId, progress),
        clearStatus: () => clearStatus(taskId),
    };
}
