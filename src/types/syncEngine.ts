export type FileDiffKind = 'New' | 'Modified';

export interface FileDiff {
  path: string;
  kind: FileDiffKind;
  source_size: number | null;
  target_size: number | null;
  checksum_source: string | null;
  checksum_target: string | null;
}

export interface DryRunResult {
  diffs: FileDiff[];
  total_files: number;
  files_to_copy: number;
  files_modified: number;
  bytes_to_copy: number;
}

export type ConflictSessionOrigin = 'manual' | 'watch';
export type ConflictItemStatus = 'pending' | 'forceCopied' | 'safeCopied' | 'skipped';
export type ConflictResolutionAction = 'forceCopy' | 'renameThenCopy' | 'skip';

export interface ConflictFileInfo {
  size: number;
  modifiedUnixMs: number | null;
  createdUnixMs: number | null;
}

export interface TargetNewerConflictItem {
  id: string;
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  source: ConflictFileInfo;
  target: ConflictFileInfo;
  status: ConflictItemStatus;
  note: string | null;
  resolvedAtUnixMs: number | null;
}

export interface ConflictSessionSummary {
  id: string;
  taskId: string;
  taskName: string;
  sourceRoot: string;
  targetRoot: string;
  origin: ConflictSessionOrigin;
  createdAtUnixMs: number;
  totalCount: number;
  pendingCount: number;
  resolvedCount: number;
}

export interface ConflictSessionDetail extends ConflictSessionSummary {
  items: TargetNewerConflictItem[];
}

export interface ConflictReviewQueueChangedEvent {
  sessions: ConflictSessionSummary[];
}

export interface ConflictResolutionRequest {
  itemId: string;
  action: ConflictResolutionAction;
}

export interface ConflictResolutionFailure {
  itemId: string;
  message: string;
}

export interface ConflictResolutionResult {
  sessionId: string;
  requestedCount: number;
  processedCount: number;
  pendingCount: number;
  failures: ConflictResolutionFailure[];
}

export interface CloseConflictReviewSessionResult {
  closed: boolean;
  hadPending: boolean;
  skippedCount: number;
}

export interface ConflictPreviewPayload {
  kind: 'text' | 'image' | 'video' | 'document' | 'other' | string;
  sourceText: string | null;
  targetText: string | null;
  sourceTruncated: boolean;
  targetTruncated: boolean;
}

export interface SyncExecutionResult {
  syncResult: {
    files_copied: number;
    bytes_copied: number;
    errors: Array<{
      path: string;
      message: string;
      kind: 'CopyFailed' | 'VerificationFailed' | 'Other' | string;
    }>;
  };
  conflictSessionId: string | null;
  conflictCount: number;
  hasPendingConflicts: boolean;
}
