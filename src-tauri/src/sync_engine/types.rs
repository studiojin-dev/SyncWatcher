use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::copy_history::CopyHistoryLedger;

pub use crate::save_rules::SaveRuleTemplateRecord;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileDiffKind {
    New,
    Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncFileStatus {
    Copied,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    /// 소스 루트 기준 상대 경로
    pub path: PathBuf,
    pub kind: FileDiffKind,
    pub source_size: Option<u64>,
    pub target_size: Option<u64>,
    pub checksum_source: Option<String>,
    pub checksum_target: Option<String>,
    /// 저장 규칙으로 바뀐 타깃 상대 경로. `None`이면 `path`와 같다.
    #[serde(default)]
    pub target_path: Option<PathBuf>,
    /// 추가 소스의 정규화된 루트. `None`이면 기본(첫 번째) 소스다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root: Option<PathBuf>,
}

impl FileDiff {
    /// 타깃 루트 기준 상대 경로.
    pub fn target_relative_path(&self) -> &Path {
        self.target_path.as_deref().unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFileEntry {
    pub path: PathBuf,
    pub kind: FileDiffKind,
    pub status: SyncFileStatus,
    pub source_size: Option<u64>,
    pub target_size: Option<u64>,
    pub error: Option<String>,
    /// 저장 규칙으로 바뀐 타깃 상대 경로. `None`이면 `path`와 같다.
    #[serde(default)]
    pub target_path: Option<PathBuf>,
    /// 추가 소스의 정규화된 루트. `None`이면 기본(첫 번째) 소스다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOptions {
    pub checksum_mode: bool,
    pub preserve_permissions: bool,
    pub preserve_times: bool,
    pub verify_after_copy: bool,
    pub exclude_patterns: Vec<String>,
    /// 규칙 기반 저장 템플릿. `None`이면 원본 상대 경로를 그대로 미러링한다.
    #[serde(default)]
    pub save_rule: Option<SaveRuleTemplateRecord>,
    /// 이미 복사한 카메라 미디어를 건너뛸 때 쓰는 작업별 복사 기록 (ADR-0040).
    /// `None`이면 옵션이 꺼진 것이다. 실제 동기화에서만 기록이 늘어난다.
    #[serde(skip)]
    pub copy_history: Option<Arc<CopyHistoryLedger>>,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            checksum_mode: true,
            preserve_permissions: true,
            preserve_times: true,
            verify_after_copy: false,
            exclude_patterns: Vec::new(),
            save_rule: None,
            copy_history: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SyncErrorKind {
    CopyFailed,
    VerificationFailed,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncError {
    pub path: PathBuf,
    pub message: String,
    pub kind: SyncErrorKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub files_copied: u64,
    pub bytes_copied: u64,
    pub errors: Vec<SyncError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictFileSnapshot {
    pub size: u64,
    pub modified_unix_ms: Option<i64>,
    pub created_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetNewerConflictCandidate {
    /// 소스 루트 기준 상대 경로
    pub path: PathBuf,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    /// 타깃 루트 기준 상대 경로 (저장 규칙 적용 후)
    #[serde(default)]
    pub target_relative_path: Option<PathBuf>,
    pub source: ConflictFileSnapshot,
    pub target: ConflictFileSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DryRunResult {
    pub diffs: Vec<FileDiff>,
    pub total_files: usize,
    pub files_to_copy: usize,
    pub files_modified: usize,
    pub bytes_to_copy: u64,
    #[serde(rename = "targetPreflight")]
    pub target_preflight: Option<TargetPreflightInfo>,
    /// 복사 기록에 있어 건너뛴 파일 수 (ADR-0040).
    #[serde(default)]
    pub skipped_previously_copied: usize,
    /// 건너뛴 파일의 소스 상대 경로 (최대 `MAX_PREVIOUSLY_COPIED_PATHS`개).
    #[serde(default)]
    pub previously_copied_paths: Vec<PathBuf>,
    /// 타깃과 이미 같아 동기화 후 기록에 더할 파일들. 프런트엔드로 보내지 않는다.
    #[serde(skip)]
    pub copy_history_in_sync: Vec<CopyHistoryCandidate>,
    /// 기록 때문에 건너뛴 모든 소스 파일의 비교 시점 상태. 복사 직전에 그대로인지
    /// 다시 확인한다 (ADR-0040). 프런트엔드로 보내지 않는다.
    #[serde(skip)]
    pub previously_copied_sources: Vec<SkippedSourceSnapshot>,
}

/// 복사 기록으로 건너뛴 소스 파일의 비교 시점 상태.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSourceSnapshot {
    pub source_path: PathBuf,
    /// 이 파일이 복사될 타깃 경로. 비교 때 비어 있었다.
    pub target_path: PathBuf,
    pub size: u64,
    pub modified: std::time::SystemTime,
    /// 건너뛰기에 쓴 촬영 시각 표지.
    pub captured: String,
}

/// 결과에 담을 건너뛴 파일 경로 최대 수.
pub const MAX_PREVIOUSLY_COPIED_PATHS: usize = 1000;

/// 복사 기록에 더할 후보 파일. 기록하기 직전에 소스가 그대로이고 타깃에 같은 크기의
/// 파일이 있는지 다시 확인한다.
#[derive(Debug, Clone)]
pub struct CopyHistoryCandidate {
    pub source_path: PathBuf,
    /// 타깃의 실제 파일. 촬영 시각은 이 파일에서 읽는다.
    pub target_path: PathBuf,
    /// 비교 시점의 타깃 수정 시각. 그 뒤 타깃이 바뀌었으면 기록하지 않는다.
    /// 방금 복사한 파일은 `None`.
    pub target_modified: Option<std::time::SystemTime>,
    pub relative_path: PathBuf,
    pub size: u64,
    /// 비교·복사 시점의 소스 수정 시각
    pub modified: std::time::SystemTime,
    /// 비교 때 양쪽 해시가 같다고 확인했는지 (체크섬 모드 등). 참이면 기록 전에 내용을 다시 읽지 않는다.
    pub content_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DryRunSummary {
    pub total_files: usize,
    pub files_to_copy: usize,
    pub files_modified: usize,
    pub bytes_to_copy: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DryRunPhase {
    ScanningSource,
    ScanningTarget,
    Comparing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DryRunProgress {
    pub phase: DryRunPhase,
    pub message: String,
    pub current: u64,
    pub total: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub summary: DryRunSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetPreflightKind {
    Ready,
    WillCreateDirectory,
    CreatedDirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetPreflightInfo {
    pub kind: TargetPreflightKind,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncProgressPhase {
    ScanningSource,
    ScanningTarget,
    Comparing,
    ValidatingDryRun,
    Copying,
    /// 복사 뒤 타깃과 이미 같았던 파일을 복사 기록에 더하는 중 (ADR-0040). 파일 복사 로그로 남기지 않는다.
    RecordingCopyHistory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub phase: SyncProgressPhase,
    pub current_file: Option<String>,
    pub total_files: u64,
    pub processed_files: u64,
    pub total_bytes: u64,
    pub processed_bytes: u64,
    pub bytes_copied_current_file: u64,
    pub current_file_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: PathBuf,
    pub size: u64,
    pub modified: std::time::SystemTime,
    pub created: Option<std::time::SystemTime>,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanFile {
    pub path: PathBuf,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteOrphanFailure {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteOrphanResult {
    pub deleted_count: usize,
    pub deleted_files_count: usize,
    pub deleted_dirs_count: usize,
    pub skipped_count: usize,
    pub failures: Vec<DeleteOrphanFailure>,
}
