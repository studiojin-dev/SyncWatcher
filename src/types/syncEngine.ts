export type FileDiffKind = 'New' | 'Modified';
export type SyncOperationOrigin = 'manual' | 'watch' | 'scheduled';
export type SyncFileStatus = 'copied' | 'failed';
export type SyncProgressPhase =
  | 'scanningSource'
  | 'scanningTarget'
  | 'comparing'
  | 'validatingDryRun'
  | 'copying';

export interface FileDiff {
  path: string;
  kind: FileDiffKind;
  source_size: number | null;
  target_size: number | null;
  checksum_source: string | null;
  checksum_target: string | null;
  /** 저장 규칙으로 바뀐 타깃 상대 경로. 없으면 path와 같다. */
  target_path?: string | null;
  /** 추가 소스의 루트. 없으면 기본 소스다 (ADR-0039). */
  source_root?: string | null;
}

/** 결과 트리 경로. 추가 소스의 파일은 기본 소스와 같은 상대 경로여도 섞이지 않게 루트 아래에 둔다. */
export function resultTreePath(path: string, sourceRoot?: string | null): string {
  return sourceRoot ? `${sourceRoot.replace(/^\/+|\/+$/g, '')}/${path}` : path;
}

export type TargetPreflightKind =
  | 'ready'
  | 'willCreateDirectory'
  | 'createdDirectory';

export interface TargetPreflightInfo {
  kind: TargetPreflightKind;
  path: string;
}

export interface DryRunResult {
  diffs: FileDiff[];
  total_files: number;
  files_to_copy: number;
  files_modified: number;
  bytes_to_copy: number;
  targetPreflight: TargetPreflightInfo | null;
}

export interface SyncErrorResult {
  path: string;
  message: string;
  kind: 'CopyFailed' | 'VerificationFailed' | 'Other' | string;
}

export interface SyncProgressEvent {
  taskId?: string;
  origin?: SyncOperationOrigin;
  phase?: SyncProgressPhase;
  message?: string;
  current?: number;
  total?: number;
  processedBytes?: number;
  totalBytes?: number;
  currentFileBytesCopied?: number;
  currentFileTotalBytes?: number;
}

export interface SyncFileEntry {
  path: string;
  kind: FileDiffKind;
  status: SyncFileStatus;
  source_size: number | null;
  target_size: number | null;
  error?: string;
  /** 저장 규칙으로 바뀐 타깃 상대 경로. 없으면 path와 같다. */
  target_path?: string | null;
  /** 추가 소스의 루트. 없으면 기본 소스다 (ADR-0039). */
  source_root?: string | null;
}

export interface SyncFileBatchEvent {
  taskId?: string;
  origin?: SyncOperationOrigin;
  entries: SyncFileEntry[];
}

export interface SyncSessionResult {
  entries: SyncFileEntry[];
  files_copied: number;
  bytes_copied: number;
  errors: SyncErrorResult[];
  conflictCount: number;
  hasPendingConflicts: boolean;
  targetPreflight: TargetPreflightInfo | null;
}

export type SyncSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface SyncSessionState {
  taskId: string;
  taskName: string;
  status: SyncSessionStatus;
  result: SyncSessionResult;
  progress?: SyncProgressEvent;
  error?: string;
  updatedAtUnixMs: number;
}

export function isTerminalSyncSessionStatus(
  status: SyncSessionStatus | undefined,
): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export type DryRunSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export function isTerminalDryRunSessionStatus(
  status: DryRunSessionStatus | undefined,
): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export type DryRunProgressPhase = 'scanningSource' | 'scanningTarget' | 'comparing';

export interface DryRunResultSummary {
  total_files: number;
  files_to_copy: number;
  files_modified: number;
  bytes_to_copy: number;
}

export interface DryRunProgressEvent {
  taskId?: string;
  phase?: DryRunProgressPhase | string;
  message?: string;
  current?: number;
  total?: number;
  summary?: Partial<DryRunResultSummary>;
  processedBytes?: number;
  totalBytes?: number;
  currentFileBytesCopied?: number;
  currentFileTotalBytes?: number;
}

export interface DryRunDiffBatchEvent {
  taskId?: string;
  phase?: DryRunProgressPhase | string;
  message?: string;
  diffs: FileDiff[];
  summary?: Partial<DryRunResultSummary>;
  targetPreflight?: TargetPreflightInfo | null;
}

export interface DryRunSessionState {
  taskId: string;
  taskName: string;
  status: DryRunSessionStatus;
  result: DryRunResult;
  progress?: DryRunProgressEvent;
  error?: string;
  updatedAtUnixMs: number;
}

export type ConflictSessionOrigin = 'manual' | 'watch';
export type ConflictItemStatus =
  | 'pending'
  | 'forceCopied'
  | 'safeCopied'
  | 'skipped';
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
    errors: SyncErrorResult[];
  };
  conflictSessionId: string | null;
  conflictCount: number;
  hasPendingConflicts: boolean;
  targetPreflight: TargetPreflightInfo | null;
}

export interface SyncSessionFinishedEvent {
  taskId: string;
  origin: SyncOperationOrigin;
  status: SyncSessionStatus;
  files_copied: number;
  bytes_copied: number;
  errors: SyncErrorResult[];
  conflictCount: number;
  hasPendingConflicts: boolean;
  targetPreflight: TargetPreflightInfo | null;
  reason?: string;
}
