import { create } from 'zustand';
import type {
    DryRunDiffBatchEvent,
    DryRunProgressEvent,
    DryRunResult,
    DryRunResultSummary,
    DryRunSessionState,
} from '../types/syncEngine';
import { isTerminalDryRunSessionStatus } from '../types/syncEngine';

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
        processedBytes?: number;
        totalBytes?: number;
        currentFileBytesCopied?: number;
        currentFileTotalBytes?: number;
    };
}

function createEmptyDryRunResult(): DryRunResult {
    return {
        diffs: [],
        total_files: 0,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: null,
    };
}

function createDryRunSession(taskId: string, taskName: string): DryRunSessionState {
    return {
        taskId,
        taskName,
        status: 'running',
        result: createEmptyDryRunResult(),
        updatedAtUnixMs: Date.now(),
    };
}

function mergeDryRunSummary(
    result: DryRunResult,
    summary?: Partial<DryRunResultSummary>,
): DryRunResult {
    if (!summary) {
        return result;
    }

    return {
        ...result,
        total_files: summary.total_files ?? result.total_files,
        files_to_copy: summary.files_to_copy ?? result.files_to_copy,
        files_modified: summary.files_modified ?? result.files_modified,
        bytes_to_copy: summary.bytes_to_copy ?? result.bytes_to_copy,
    };
}

function getOrCreateDryRunSession(
    sessions: Map<string, DryRunSessionState>,
    taskId: string,
): DryRunSessionState {
    return sessions.get(taskId) || createDryRunSession(taskId, taskId);
}

interface SyncTaskStatusStore {
    /** 각 Task의 상태 맵 */
    statuses: Map<string, TaskStatus>;
    /** 런타임에서 감시 중인 Task ID 집합 */
    watchingTaskIds: Set<string>;
    /** 런타임 동기화 대기열에 있는 Task ID 집합 */
    queuedTaskIds: Set<string>;
    /** 런타임에서 동기화 실행 중인 Task ID 집합 */
    syncingTaskIds: Set<string>;
    /** 런타임에서 dry-run 실행 중인 Task ID 집합 */
    dryRunningTaskIds: Set<string>;
    /** dry-run 라이브 세션 맵 */
    dryRunSessions: Map<string, DryRunSessionState>;

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
    /** syncing 상태 업데이트 */
    setSyncing: (taskId: string, syncing: boolean) => void;
    /** syncing 상태 일괄 업데이트 */
    setSyncingTasks: (taskIds: string[]) => void;
    /** dry-run 상태 업데이트 */
    setDryRunning: (taskId: string, dryRunning: boolean) => void;
    /** dry-run 상태 일괄 업데이트 */
    setDryRunningTasks: (taskIds: string[]) => void;
    /** dry-run 세션 초기화 */
    beginDryRunSession: (taskId: string, taskName: string) => void;
    /** dry-run 진행 상태 업데이트 */
    setDryRunProgress: (taskId: string, progress: DryRunProgressEvent) => void;
    /** dry-run diff 배치 반영 */
    appendDryRunDiffBatch: (taskId: string, batch: DryRunDiffBatchEvent) => void;
    /** dry-run 완료 상태 반영 */
    completeDryRunSession: (taskId: string, result: DryRunResult) => void;
    /** dry-run 실패 상태 반영 */
    failDryRunSession: (taskId: string, error: string) => void;
    /** dry-run 세션 조회 */
    getDryRunSession: (taskId: string) => DryRunSessionState | undefined;
    /** dry-run 세션 초기화 */
    clearDryRunSession: (taskId: string) => void;
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
    syncingTaskIds: new Set<string>(),
    dryRunningTaskIds: new Set<string>(),
    dryRunSessions: new Map<string, DryRunSessionState>(),

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

    getStatus: (taskId) => get().statuses.get(taskId),

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
        set((state) => {
            const nextQueued = new Set(taskIds);
            const nextStatuses = new Map(state.statuses);

            for (const taskId of nextQueued) {
                const current = nextStatuses.get(taskId) || { taskId, status: 'idle' as const };
                if (current.status !== 'syncing') {
                    nextStatuses.set(taskId, { ...current, status: 'queued' });
                }
            }

            for (const [taskId, current] of nextStatuses.entries()) {
                if (
                    current.status === 'queued' &&
                    !nextQueued.has(taskId) &&
                    !state.syncingTaskIds.has(taskId)
                ) {
                    nextStatuses.set(taskId, {
                        ...current,
                        status: state.watchingTaskIds.has(taskId) ? 'watching' : 'idle',
                    });
                }
            }

            return {
                queuedTaskIds: nextQueued,
                statuses: nextStatuses,
            };
        });
    },

    setSyncing: (taskId, syncing) => {
        set((state) => {
            const nextSyncing = new Set(state.syncingTaskIds);
            if (syncing) {
                nextSyncing.add(taskId);
            } else {
                nextSyncing.delete(taskId);
            }
            return { syncingTaskIds: nextSyncing };
        });
    },

    setSyncingTasks: (taskIds) => {
        set({ syncingTaskIds: new Set(taskIds) });
    },

    setDryRunning: (taskId, dryRunning) => {
        set((state) => {
            const nextDryRunning = new Set(state.dryRunningTaskIds);
            const nextStatuses = new Map(state.statuses);
            const current = nextStatuses.get(taskId) || { taskId, status: 'idle' as const };

            if (dryRunning) {
                nextDryRunning.add(taskId);
                if (current.status !== 'syncing' && current.status !== 'queued') {
                    nextStatuses.set(taskId, { ...current, status: 'dryRunning' });
                }
            } else {
                nextDryRunning.delete(taskId);
                if (
                    current.status === 'dryRunning' &&
                    !state.syncingTaskIds.has(taskId) &&
                    !state.queuedTaskIds.has(taskId)
                ) {
                    nextStatuses.set(taskId, {
                        ...current,
                        status: state.watchingTaskIds.has(taskId) ? 'watching' : 'idle',
                    });
                }
            }

            return {
                dryRunningTaskIds: nextDryRunning,
                statuses: nextStatuses,
            };
        });
    },

    setDryRunningTasks: (taskIds) => {
        set((state) => {
            const nextDryRunning = new Set(taskIds);
            const nextStatuses = new Map(state.statuses);

            for (const taskId of nextDryRunning) {
                const current = nextStatuses.get(taskId) || { taskId, status: 'idle' as const };
                if (current.status !== 'syncing' && current.status !== 'queued') {
                    nextStatuses.set(taskId, { ...current, status: 'dryRunning' });
                }
            }

            for (const [taskId, current] of nextStatuses.entries()) {
                if (
                    current.status === 'dryRunning' &&
                    !nextDryRunning.has(taskId) &&
                    !state.syncingTaskIds.has(taskId) &&
                    !state.queuedTaskIds.has(taskId)
                ) {
                    nextStatuses.set(taskId, {
                        ...current,
                        status: state.watchingTaskIds.has(taskId) ? 'watching' : 'idle',
                    });
                }
            }

            return {
                dryRunningTaskIds: nextDryRunning,
                statuses: nextStatuses,
            };
        });
    },

    beginDryRunSession: (taskId, taskName) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            nextSessions.set(taskId, createDryRunSession(taskId, taskName));
            return { dryRunSessions: nextSessions };
        });
    },

    setDryRunProgress: (taskId, progress) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            const current = getOrCreateDryRunSession(nextSessions, taskId);
            if (isTerminalDryRunSessionStatus(current.status)) {
                return { dryRunSessions: nextSessions };
            }
            nextSessions.set(taskId, {
                ...current,
                status: 'running',
                progress,
                updatedAtUnixMs: Date.now(),
            });
            return { dryRunSessions: nextSessions };
        });
    },

    appendDryRunDiffBatch: (taskId, batch) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            const current = getOrCreateDryRunSession(nextSessions, taskId);
            if (isTerminalDryRunSessionStatus(current.status)) {
                return { dryRunSessions: nextSessions };
            }
            const currentResult = mergeDryRunSummary(current.result, batch.summary);
            nextSessions.set(taskId, {
                ...current,
                status: 'running',
                result: {
                    ...currentResult,
                    diffs: [...currentResult.diffs, ...batch.diffs],
                    targetPreflight: batch.targetPreflight ?? currentResult.targetPreflight,
                },
                updatedAtUnixMs: Date.now(),
            });
            return { dryRunSessions: nextSessions };
        });
    },

    completeDryRunSession: (taskId, result) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            const current = nextSessions.get(taskId) || createDryRunSession(taskId, taskId);
            nextSessions.set(taskId, {
                ...current,
                status: 'completed',
                result,
                error: undefined,
                updatedAtUnixMs: Date.now(),
            });
            return { dryRunSessions: nextSessions };
        });
    },

    failDryRunSession: (taskId, error) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            const current = nextSessions.get(taskId) || createDryRunSession(taskId, taskId);
            nextSessions.set(taskId, {
                ...current,
                status: error.toLowerCase().includes('cancel') ? 'cancelled' : 'failed',
                error,
                updatedAtUnixMs: Date.now(),
            });
            return { dryRunSessions: nextSessions };
        });
    },

    getDryRunSession: (taskId) => get().dryRunSessions.get(taskId),

    clearDryRunSession: (taskId) => {
        set((state) => {
            const nextSessions = new Map(state.dryRunSessions);
            nextSessions.delete(taskId);
            return { dryRunSessions: nextSessions };
        });
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

export function useDryRunSession(taskId: string) {
    return useSyncTaskStatusStore((state) => state.dryRunSessions.get(taskId));
}
