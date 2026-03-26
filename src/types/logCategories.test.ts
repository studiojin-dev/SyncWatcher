import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_VISIBLE_CATEGORIES,
  TASK_VISIBLE_CATEGORIES,
  isActivityVisibleEntry,
  isActivityVisibleCategory,
  isTaskVisibleCategory,
  LOG_CATEGORIES,
} from './logCategories';

describe('logCategories whitelist drift guard', () => {
  it('uses exact activity/task visibility sets', () => {
    expect([...ACTIVITY_VISIBLE_CATEGORIES].sort()).toEqual([
      'SyncCompleted',
      'SyncError',
      'SyncStarted',
      'ValidationError',
      'VolumeMounted',
      'VolumeUnmounted',
      'WatchStarted',
      'WatchStopped',
    ]);

    expect([...TASK_VISIBLE_CATEGORIES].sort()).toEqual([
      'FileCopied',
      'FileDeleted',
      'SyncCompleted',
      'SyncError',
      'SyncStarted',
      'ValidationError',
      'WatchStarted',
      'WatchStopped',
    ]);
  });

  it('applies visibility rules consistently across all known categories', () => {
    const expectedActivity = new Set([
      'SyncStarted',
      'SyncCompleted',
      'SyncError',
      'WatchStarted',
      'WatchStopped',
      'VolumeMounted',
      'VolumeUnmounted',
      'ValidationError',
    ]);
    const expectedTask = new Set([
      'SyncStarted',
      'SyncCompleted',
      'SyncError',
      'WatchStarted',
      'WatchStopped',
      'FileCopied',
      'FileDeleted',
      'ValidationError',
    ]);

    for (const category of LOG_CATEGORIES) {
      expect(isActivityVisibleCategory(category)).toBe(expectedActivity.has(category));
      expect(isTaskVisibleCategory(category)).toBe(expectedTask.has(category));
    }

    expect(isActivityVisibleCategory('Other')).toBe(false);
    expect(isTaskVisibleCategory('Other')).toBe(false);
    expect(isActivityVisibleCategory(undefined)).toBe(false);
    expect(isTaskVisibleCategory(undefined)).toBe(false);
  });

  it('filters task-scoped validation entries from the activity contract', () => {
    expect(
      isActivityVisibleEntry({
        category: 'ValidationError',
        task_id: 'task-1',
      }),
    ).toBe(false);

    expect(
      isActivityVisibleEntry({
        category: 'ValidationError',
      }),
    ).toBe(true);

    expect(
      isActivityVisibleEntry({
        category: 'SyncStarted',
        task_id: 'task-1',
      }),
    ).toBe(true);
  });
});
