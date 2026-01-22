use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileDiffKind {
    New,
    Modified,
    Deleted,
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
    pub delete_missing: bool,
    pub checksum_mode: bool,
    pub preserve_permissions: bool,
    pub preserve_times: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            delete_missing: false,
            checksum_mode: true,
            preserve_permissions: true,
            preserve_times: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub files_copied: u64,
    pub files_deleted: u64,
    pub bytes_copied: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DryRunResult {
    pub diffs: Vec<FileDiff>,
    pub total_files: usize,
    pub files_to_copy: usize,
    pub files_to_delete: usize,
    pub files_modified: usize,
    pub bytes_to_copy: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: PathBuf,
    pub size: u64,
    pub modified: std::time::SystemTime,
    pub is_file: bool,
}
