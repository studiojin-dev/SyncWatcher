use crate::sync_engine::types::{
    DryRunResult, FileDiff, FileDiffKind, FileMetadata, SyncOptions, SyncResult,
};
use anyhow::Result;
use std::collections::HashMap;
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncReadExt;
use walkdir::WalkDir;

pub struct SyncEngine {
    source: PathBuf,
    target: PathBuf,
}

impl SyncEngine {
    pub fn new(source: PathBuf, target: PathBuf) -> Self {
        Self { source, target }
    }

    async fn calculate_checksum(&self, path: &Path) -> Result<String> {
        use twox_hash::XxHash64;

        let mut file = fs::File::open(path).await?;
        let mut hasher = XxHash64::with_seed(0);
        let mut buffer = [0u8; 8192];

        loop {
            let n = file.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            hasher.write(&buffer[..n]);
        }

        Ok(format!("{:x}", hasher.finish()))
    }

    async fn read_directory(&self, dir: &Path) -> Result<Vec<FileMetadata>> {
        let mut files = Vec::new();

        for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            let metadata = fs::metadata(path).await?;
            let relative_path = path.strip_prefix(dir)?.to_path_buf();

            files.push(FileMetadata {
                path: relative_path,
                size: metadata.len(),
                modified: metadata.modified()?,
                is_file: metadata.is_file(),
            });
        }

        Ok(files)
    }

    pub async fn compare_dirs(&self, options: &SyncOptions) -> Result<DryRunResult> {
        let source_files = self.read_directory(&self.source).await?;
        let target_files = if self.target.exists() {
            self.read_directory(&self.target).await?
        } else {
            Vec::new()
        };

        let mut source_map: HashMap<PathBuf, &FileMetadata> = HashMap::new();
        let mut target_map: HashMap<PathBuf, &FileMetadata> = HashMap::new();

        for file in &source_files {
            source_map.insert(file.path.clone(), file);
        }

        for file in &target_files {
            target_map.insert(file.path.clone(), file);
        }

        let mut diffs = Vec::new();
        let mut bytes_to_copy = 0u64;

        for (path, source_meta) in &source_map {
            if let Some(target_meta) = target_map.get(path) {
                if source_meta.is_file {
                    // 1. First check metadata (fastest)
                    let mut needs_copy = source_meta.size != target_meta.size
                        || source_meta.modified > target_meta.modified;

                    // 2. If metadata matches but checksum mode is on, check content (slower but accurate)
                    if !needs_copy && options.checksum_mode {
                        let source_hash = self.calculate_checksum(&self.source.join(path)).await?;
                        let target_hash = self.calculate_checksum(&self.target.join(path)).await?;

                        if source_hash != target_hash {
                            needs_copy = true;
                        }
                    }

                    if needs_copy {
                        bytes_to_copy += source_meta.size;
                        diffs.push(FileDiff {
                            path: path.clone(),
                            kind: FileDiffKind::Modified,
                            source_size: Some(source_meta.size),
                            target_size: Some(target_meta.size),
                            checksum_source: None,
                            checksum_target: None,
                        });
                    }
                }
            } else if source_meta.is_file {
                bytes_to_copy += source_meta.size;
                diffs.push(FileDiff {
                    path: path.clone(),
                    kind: FileDiffKind::New,
                    source_size: Some(source_meta.size),
                    target_size: None,
                    checksum_source: None,
                    checksum_target: None,
                });
            }
        }

        if options.delete_missing {
            for (path, target_meta) in &target_map {
                if !source_map.contains_key(path) && target_meta.is_file {
                    diffs.push(FileDiff {
                        path: path.clone(),
                        kind: FileDiffKind::Deleted,
                        source_size: None,
                        target_size: Some(target_meta.size),
                        checksum_source: None,
                        checksum_target: None,
                    });
                }
            }
        }

        let files_to_copy = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::New || d.kind == FileDiffKind::Modified)
            .count();
        let files_to_delete = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::Deleted)
            .count();
        let files_modified = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::Modified)
            .count();

        let total_files = source_files.iter().filter(|f| f.is_file).count();

        Ok(DryRunResult {
            diffs,
            total_files,
            files_to_copy,
            files_to_delete,
            files_modified,
            bytes_to_copy,
        })
    }

    pub async fn dry_run(&self, options: &SyncOptions) -> Result<DryRunResult> {
        self.compare_dirs(options).await
    }

    pub async fn sync_files(
        &self,
        options: &SyncOptions,
        progress_callback: impl Fn(crate::sync_engine::types::SyncProgress),
    ) -> Result<SyncResult> {
        let dry_run = self.compare_dirs(options).await?;

        let mut result = SyncResult {
            files_copied: 0,
            files_deleted: 0,
            bytes_copied: 0,
            errors: Vec::new(),
        };

        let mut total_bytes = 0u64;
        let mut total_files_to_copy = 0u64;

        for diff in &dry_run.diffs {
            match diff.kind {
                FileDiffKind::New | FileDiffKind::Modified => {
                    if let Some(size) = diff.source_size {
                        total_bytes += size;
                    }
                    total_files_to_copy += 1;
                }
                _ => {}
            }
        }

        let mut current_progress = crate::sync_engine::types::SyncProgress {
            phase: crate::sync_engine::types::SyncPhase::Copying,
            current_file: None,
            total_files: total_files_to_copy,
            processed_files: 0,
            total_bytes,
            processed_bytes: 0,
            bytes_copied_current_file: 0,
        };

        // Initial progress report
        progress_callback(current_progress.clone());

        for diff in &dry_run.diffs {
            let source_path = self.source.join(&diff.path);
            let target_path = self.target.join(&diff.path);

            match diff.kind {
                FileDiffKind::New | FileDiffKind::Modified => {
                    current_progress.current_file = Some(diff.path.to_string_lossy().to_string());
                    current_progress.bytes_copied_current_file = 0;
                    progress_callback(current_progress.clone());

                    let file_size = diff.source_size.unwrap_or(0);

                    if let Err(e) = self
                        .copy_file_chunked(&source_path, &target_path, options, |written_chunk| {
                            current_progress.processed_bytes += written_chunk;
                            current_progress.bytes_copied_current_file += written_chunk;
                            progress_callback(current_progress.clone());
                        })
                        .await
                    {
                        let kind = if e.to_string().contains("Verification failed") {
                            crate::sync_engine::types::SyncErrorKind::VerificationFailed
                        } else {
                            crate::sync_engine::types::SyncErrorKind::CopyFailed
                        };
                        result.errors.push(crate::sync_engine::types::SyncError {
                            path: diff.path.clone(),
                            message: e.to_string(),
                            kind,
                        });
                        // If failed, we might need to adjust processed bytes back if we want strictly accurate 'successful' bytes,
                        // but typically progress just moves forward.
                    } else {
                        result.files_copied += 1;
                        result.bytes_copied += file_size;
                    }

                    current_progress.processed_files += 1;
                    progress_callback(current_progress.clone());
                }
                FileDiffKind::Deleted => {
                    current_progress.phase = crate::sync_engine::types::SyncPhase::Deleting;
                    current_progress.current_file = Some(diff.path.to_string_lossy().to_string());
                    progress_callback(current_progress.clone());

                    if let Err(e) = fs::remove_file(&target_path).await {
                        result.errors.push(crate::sync_engine::types::SyncError {
                            path: diff.path.clone(),
                            message: e.to_string(),
                            kind: crate::sync_engine::types::SyncErrorKind::DeleteFailed,
                        });
                    } else {
                        result.files_deleted += 1;
                    }
                    current_progress.phase = crate::sync_engine::types::SyncPhase::Copying;
                    // Revert phase
                }
            }
        }

        Ok(result)
    }

    async fn copy_file_chunked(
        &self,
        source: &Path,
        target: &Path,
        options: &SyncOptions,
        mut on_progress: impl FnMut(u64),
    ) -> Result<()> {
        use tokio::io::AsyncWriteExt; // Import for write_all

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }

        let mut source_file = fs::File::open(source).await?;
        let mut target_file = fs::File::create(target).await?;
        let mut buffer = [0u8; 64 * 1024]; // 64KB chunks

        loop {
            let n = source_file.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            target_file.write_all(&buffer[..n]).await?;
            on_progress(n as u64);
        }

        if options.preserve_permissions {
            let meta = fs::metadata(source).await?;
            let perms = meta.permissions();
            fs::set_permissions(target, perms).await?;
        }

        if options.preserve_times {
            let meta = fs::metadata(source).await?;
            let modified = meta.modified()?;
            filetime::set_file_mtime(target, filetime::FileTime::from_system_time(modified))?;
        }

        if options.verify_after_copy {
            let source_hash = self.calculate_checksum(source).await?;
            let target_hash = self.calculate_checksum(target).await?;

            if source_hash != target_hash {
                let _ = fs::remove_file(target).await;
                anyhow::bail!("Verification failed: Checksum mismatch for {target:?}");
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_basic_sync() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let source = source_dir.path().join("test.txt");
        fs::write(&source, b"hello world").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();

        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);

        let result = engine.sync_files(&options, |_| {}).await?;
        assert_eq!(result.files_copied, 1);

        Ok(())
    }
}
