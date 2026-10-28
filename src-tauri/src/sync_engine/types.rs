use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
