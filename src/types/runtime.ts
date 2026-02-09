import { SyncTask } from '../hooks/useSyncTasks';
import { ExclusionSet } from '../hooks/useExclusionSets';

export interface RuntimeSyncTask {
    id: string;
    name: string;
    source: string;
    target: string;
    deleteMissing: boolean;
    checksumMode: boolean;
    watchMode: boolean;
    autoUnmount: boolean;
    verifyAfterCopy: boolean;
    exclusionSets: string[];
}

export interface RuntimeExclusionSet {
    id: string;
    name: string;
    patterns: string[];
}

export interface RuntimeConfigPayload {
    tasks: RuntimeSyncTask[];
    exclusionSets: RuntimeExclusionSet[];
}

export interface RuntimeState {
    watchingTasks: string[];
    syncingTasks: string[];
}

export interface RuntimeWatchStateEvent {
    taskId: string;
    watching: boolean;
    reason?: string;
}

export interface RuntimeSyncStateEvent {
    taskId: string;
    syncing: boolean;
    reason?: string;
}

export function toRuntimeTask(task: SyncTask): RuntimeSyncTask {
    return {
        id: task.id,
        name: task.name,
        source: task.source,
        target: task.target,
        deleteMissing: task.deleteMissing,
        checksumMode: task.checksumMode,
        watchMode: task.watchMode ?? false,
        autoUnmount: task.autoUnmount ?? false,
        verifyAfterCopy: task.verifyAfterCopy ?? true,
        exclusionSets: task.exclusionSets ?? [],
    };
}

export function toRuntimeExclusionSet(set: ExclusionSet): RuntimeExclusionSet {
    return {
        id: set.id,
        name: set.name,
        patterns: set.patterns,
    };
}
