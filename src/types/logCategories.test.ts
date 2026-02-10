import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_VISIBLE_CATEGORIES,
  TASK_VISIBLE_CATEGORIES,
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
    ]);
    const expectedTask = new Set([
      'SyncStarted',
      'SyncCompleted',
      'SyncError',
      'WatchStarted',
      'WatchStopped',
      'FileCopied',
      'FileDeleted',
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
});
