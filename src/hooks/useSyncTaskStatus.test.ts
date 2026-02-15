import { beforeEach, describe, expect, it } from 'vitest';
import { useSyncTaskStatusStore } from './useSyncTaskStatus';

describe('useSyncTaskStatusStore queued snapshot sync', () => {
  beforeEach(() => {
    useSyncTaskStatusStore.setState({
      statuses: new Map(),
      watchingTaskIds: new Set(),
      queuedTaskIds: new Set(),
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
});
