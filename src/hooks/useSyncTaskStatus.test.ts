import { beforeEach, describe, expect, it } from 'vitest';
import { useSyncTaskStatusStore } from './useSyncTaskStatus';

describe('useSyncTaskStatusStore queued snapshot sync', () => {
  beforeEach(() => {
    useSyncTaskStatusStore.setState({
      statuses: new Map(),
      watchingTaskIds: new Set(),
      queuedTaskIds: new Set(),
      syncingTaskIds: new Set(),
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
});
