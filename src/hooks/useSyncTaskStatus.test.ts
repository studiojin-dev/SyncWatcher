import { beforeEach, describe, expect, it } from 'vitest';
import { useSyncTaskStatusStore } from './useSyncTaskStatus';

describe('useSyncTaskStatusStore queued snapshot sync', () => {
  beforeEach(() => {
    useSyncTaskStatusStore.setState({
      statuses: new Map(),
      watchingTaskIds: new Set(),
      queuedTaskIds: new Set(),
      syncingTaskIds: new Set(),
      dryRunningTaskIds: new Set(),
      dryRunSessions: new Map(),
    });
  });

  it('updates queued status when replacing queued task ids', () => {
    const store = useSyncTaskStatusStore.getState();

    store.setQueued('task-1', true);
    store.setWatching('task-2', true);
    store.setStatus('task-2', 'watching');

    store.setQueuedTasks(['task-2']);

    const nextState = useSyncTaskStatusStore.getState();

    expect(nextState.queuedTaskIds.has('task-1')).toBe(false);
    expect(nextState.queuedTaskIds.has('task-2')).toBe(true);
    expect(nextState.statuses.get('task-1')?.status).toBe('idle');
    expect(nextState.statuses.get('task-2')?.status).toBe('queued');
  });

  it('does not demote queued status when syncing snapshot still includes task', () => {
    const store = useSyncTaskStatusStore.getState();

    store.setQueued('task-1', true);
    store.setSyncingTasks(['task-1']);
    store.setQueuedTasks([]);

    const nextState = useSyncTaskStatusStore.getState();
    expect(nextState.syncingTaskIds.has('task-1')).toBe(true);
    expect(nextState.statuses.get('task-1')?.status).toBe('queued');
  });

  it('tracks syncing membership with setSyncing and setSyncingTasks', () => {
    const store = useSyncTaskStatusStore.getState();

    store.setSyncing('task-1', true);
    store.setSyncing('task-2', true);
    store.setSyncing('task-1', false);
    store.setSyncingTasks(['task-3']);

    const nextState = useSyncTaskStatusStore.getState();
    expect(nextState.syncingTaskIds.has('task-1')).toBe(false);
    expect(nextState.syncingTaskIds.has('task-2')).toBe(false);
    expect(nextState.syncingTaskIds.has('task-3')).toBe(true);
  });

  it('does not mutate a terminal dry-run session with later progress or diff batches', () => {
    const store = useSyncTaskStatusStore.getState();

    store.beginDryRunSession('task-1', 'Task 1');
    store.completeDryRunSession('task-1', {
      diffs: [
        {
          path: 'a.txt',
          kind: 'New',
          source_size: 1,
          target_size: null,
          checksum_source: null,
          checksum_target: null,
        },
      ],
      total_files: 1,
      files_to_copy: 1,
      files_modified: 0,
      bytes_to_copy: 1,
      targetPreflight: null,
    });

    store.setDryRunProgress('task-1', {
      taskId: 'task-1',
      phase: 'comparing',
      message: 'late progress',
      current: 1,
      total: 1,
    });
    store.appendDryRunDiffBatch('task-1', {
      taskId: 'task-1',
      diffs: [
        {
          path: 'b.txt',
          kind: 'Modified',
          source_size: 2,
          target_size: 1,
          checksum_source: null,
          checksum_target: null,
        },
      ],
      summary: {
        files_to_copy: 2,
      },
    });

    const nextState = useSyncTaskStatusStore.getState();
    const session = nextState.getDryRunSession('task-1');
    expect(session?.status).toBe('completed');
    expect(session?.progress).toBeUndefined();
    expect(session?.result.diffs).toHaveLength(1);
    expect(session?.result.files_to_copy).toBe(1);
  });

  it('replaces an existing dry-run session when a new run begins', () => {
    const store = useSyncTaskStatusStore.getState();

    store.beginDryRunSession('task-1', 'Task 1');
    store.appendDryRunDiffBatch('task-1', {
      taskId: 'task-1',
      diffs: [
        {
          path: 'a.txt',
          kind: 'New',
          source_size: 1,
          target_size: null,
          checksum_source: null,
          checksum_target: null,
        },
      ],
      summary: {
        files_to_copy: 1,
      },
    });

    store.beginDryRunSession('task-1', 'Task 1');

    const session = useSyncTaskStatusStore.getState().getDryRunSession('task-1');
    expect(session?.status).toBe('running');
    expect(session?.result.diffs).toHaveLength(0);
  });

  it('clears a dry-run session explicitly', () => {
    const store = useSyncTaskStatusStore.getState();

    store.beginDryRunSession('task-1', 'Task 1');
    store.clearDryRunSession('task-1');

    expect(useSyncTaskStatusStore.getState().getDryRunSession('task-1')).toBeUndefined();
  });
});
