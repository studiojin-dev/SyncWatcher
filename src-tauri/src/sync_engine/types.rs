use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileDiffKind {
    New,
    Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: PathBuf,
    pub kind: FileDiffKind,
    pub source_size: Option<u64>,
    pub target_size: Option<u64>,
    pub checksum_source: Option<String>,
    pub checksum_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOptions {
    pub checksum_mode: bool,
    pub preserve_permissions: bool,
    pub preserve_times: bool,
    pub verify_after_copy: bool,
    pub exclude_patterns: Vec<String>,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            checksum_mode: true,
            preserve_permissions: true,
            preserve_times: true,
            verify_after_copy: false,
            exclude_patterns: Vec::new(),
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
pub struct DryRunResult {
    pub diffs: Vec<FileDiff>,
    pub total_files: usize,
    pub files_to_copy: usize,
    pub files_modified: usize,
    pub bytes_to_copy: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SyncPhase {
    Scanning,
    Copying,
    Verifying,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub current_file: Option<String>,
    pub total_files: u64,
    pub processed_files: u64,
    pub total_bytes: u64,
    pub processed_bytes: u64,
    pub bytes_copied_current_file: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: PathBuf,
    pub size: u64,
    pub modified: std::time::SystemTime,
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
    pub skipped_count: usize,
    pub failures: Vec<DeleteOrphanFailure>,
}
