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
  'ValidationError',
  'Other',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export interface ActivityLogEntryLike {
  category?: string;
  task_id?: string;
  taskId?: string;
}

export const ACTIVITY_VISIBLE_CATEGORIES = new Set<LogCategory>([
  'SyncStarted',
  'SyncCompleted',
  'SyncError',
  'WatchStarted',
  'WatchStopped',
  'VolumeMounted',
  'VolumeUnmounted',
  'ValidationError',
]);

export const TASK_VISIBLE_CATEGORIES = new Set<LogCategory>([
  'SyncStarted',
  'SyncCompleted',
  'SyncError',
  'WatchStarted',
  'WatchStopped',
  'FileCopied',
  'FileDeleted',
  'ValidationError',
]);

export function isActivityVisibleCategory(category?: string): boolean {
  if (!category) {
    return false;
  }
  return ACTIVITY_VISIBLE_CATEGORIES.has(category as LogCategory);
}

export function isActivityVisibleEntry(entry?: ActivityLogEntryLike): boolean {
  if (!entry || !isActivityVisibleCategory(entry.category)) {
    return false;
  }

  const taskId = entry.task_id ?? entry.taskId;
  return !(entry.category === 'ValidationError' && Boolean(taskId));
}

export function isTaskVisibleCategory(category?: string): boolean {
  if (!category) {
    return false;
  }
  return TASK_VISIBLE_CATEGORIES.has(category as LogCategory);
}
