export const LOG_CATEGORIES = [
  'SyncStarted',
  'SyncCompleted',
  'SyncError',
  'WatchStarted',
  'WatchStopped',
  'VolumeMounted',
  'VolumeUnmounted',
  'FileCopied',
  'FileDeleted',
  'Other',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const ACTIVITY_VISIBLE_CATEGORIES = new Set<LogCategory>([
  'SyncStarted',
  'SyncCompleted',
  'SyncError',
  'WatchStarted',
  'WatchStopped',
  'VolumeMounted',
  'VolumeUnmounted',
]);

export const TASK_VISIBLE_CATEGORIES = new Set<LogCategory>([
  'SyncStarted',
  'SyncCompleted',
  'SyncError',
  'WatchStarted',
  'WatchStopped',
  'FileCopied',
  'FileDeleted',
]);

export function isActivityVisibleCategory(category?: string): boolean {
  if (!category) {
    return false;
  }
  return ACTIVITY_VISIBLE_CATEGORIES.has(category as LogCategory);
}

export function isTaskVisibleCategory(category?: string): boolean {
  if (!category) {
    return false;
  }
  return TASK_VISIBLE_CATEGORIES.has(category as LogCategory);
}
