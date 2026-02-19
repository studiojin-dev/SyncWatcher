use crate::sync_engine::types::{
    ConflictFileSnapshot, DeleteOrphanFailure, DeleteOrphanResult, DryRunResult, FileDiff,
    FileDiffKind, FileMetadata, OrphanFile, SyncOptions, SyncResult,
    TargetNewerConflictCandidate,
};
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::fs;
use tokio::io::AsyncReadExt;
use walkdir::WalkDir;
use globset::{Glob, GlobSetBuilder};
use anyhow::Context; // Import Context trait

pub struct SyncEngine {
    source: PathBuf,
    target: PathBuf,
}

impl SyncEngine {
    pub fn new(source: PathBuf, target: PathBuf) -> Self {
        Self { source, target }
    }

    fn system_time_to_unix_ms(value: Option<SystemTime>) -> Option<i64> {
        value.and_then(|time| {
            time.duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_millis() as i64)
        })
    }

    fn snapshot_from_metadata(meta: &FileMetadata) -> ConflictFileSnapshot {
        ConflictFileSnapshot {
            size: meta.size,
            modified_unix_ms: Self::system_time_to_unix_ms(Some(meta.modified)),
            created_unix_ms: Self::system_time_to_unix_ms(meta.created),
        }
    }

    async fn calculate_checksum(&self, path: &Path) -> Result<String> {
        use twox_hash::XxHash64;

        let mut file = fs::File::open(path)
            .await
            .with_context(|| format!("Failed to open file for checksum: {:?}", path))?;
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

    async fn read_directory(&self, dir: &Path, exclude_patterns: &[String]) -> Result<Vec<FileMetadata>> {
        let dir_buf = dir.to_path_buf();
        let patterns = exclude_patterns.to_vec();

        tokio::task::spawn_blocking(move || {
            let mut files = Vec::new();

            // Pattern validation constants
            const MAX_PATTERN_LENGTH: usize = 255;
            const MAX_PATTERN_COUNT: usize = 100;

            // Validate pattern count
            if patterns.len() > MAX_PATTERN_COUNT {
                anyhow::bail!(
                    "Too many exclusion patterns: {} (max: {})",
                    patterns.len(),
                    MAX_PATTERN_COUNT
                );
            }

            // Build GlobSet with validation
            let mut builder = GlobSetBuilder::new();
            for pattern in &patterns {
                // Skip empty patterns
                let trimmed = pattern.trim();
                if trimmed.is_empty() {
                    continue;
                }

                // Validate pattern length
                if trimmed.len() > MAX_PATTERN_LENGTH {
                    anyhow::bail!(
                        "Exclusion pattern too long: '{}...' ({} chars, max: {})",
                        &trimmed[..50.min(trimmed.len())],
                        trimmed.len(),
                        MAX_PATTERN_LENGTH
                    );
                }

                // Helper to add glob with error handling
                let mut add_glob = |p: &str| -> anyhow::Result<()> {
                     match Glob::new(p) {
                        Ok(glob) => {
                            builder.add(glob);
                            Ok(())
                        },
                        Err(e) => anyhow::bail!("Invalid exclusion pattern '{}': {}", p, e),
                    }
                };

                // Add original pattern
                add_glob(trimmed)?;

                // If pattern doesn't start with explicitly anchored path or wildcard, allow matching in subdirectories
                // e.g. ".venv" -> "**/.venv"
                // e.g. "*.log" -> "**/*.log"
                // e.g. "dist" -> "**/dist"
                if !trimmed.starts_with('/') && !trimmed.starts_with("**/") {
                    add_glob(&format!("**/{}", trimmed))?;
                }
                
                // Also handle directory contents if the pattern matches a directory name?
                // filter_entry takes care of directories, but if a pattern is "node_modules", we skip the dir.
                // If we are already inside? No, filter_entry prevents entering.
                // So "**/pattern" is sufficient to catch the directory at any depth.
            }
            let globs = builder.build()?;

            let walker = WalkDir::new(&dir_buf).into_iter().filter_entry(|e| {
                // Skip if error accessing entry
                let path = e.path();
                
                // Calculate relative path from root
                // For root directory itself, relative path is empty or "."
                let relative_path = match path.strip_prefix(&dir_buf) {
                    Ok(p) => p,
                    Err(_) => return true, // Should not happen for children
                };

                // Check exclusion patterns
                // If it matches, return FALSE to skip entering directory or processing file
                !globs.is_match(relative_path)
            });

            for entry in walker.filter_map(|e| e.ok()) {
                let path = entry.path();
                
                // Root directory itself is yielded, skip it
                if path == dir_buf {
                    continue;
                }

                // Use std::fs instead of tokio::fs inside blocking task
                let metadata = match std::fs::symlink_metadata(path) {
                    Ok(m) => m,
                    Err(_) => continue, // Skip files we can't read metadata for
                };
                
                let relative_path = path.strip_prefix(&dir_buf)?.to_path_buf();

                files.push(FileMetadata {
                    path: relative_path,
                    size: metadata.len(),
                    modified: metadata.modified()
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH), // Fallback if modified time unavailable
                    created: metadata.created().ok(),
                    is_file: metadata.is_file(),
                });
            }

            Ok(files)
        })
        .await?
    }

    async fn compare_dirs_internal(
        &self,
        options: &SyncOptions,
    ) -> Result<(DryRunResult, Vec<TargetNewerConflictCandidate>)> {
        // 1. Canonicalize source to resolve symlinks and .. (TOCTOU protection)
        let source_canonical = tokio::fs::canonicalize(&self.source)
            .await
            .with_context(|| format!("Failed to canonicalize source: {:?}", self.source))?;

        // 2. Verify it's still a directory after canonicalization
        let source_meta = tokio::fs::metadata(&source_canonical)
            .await
            .with_context(|| format!("Failed to access source after canonicalization: {:?}", source_canonical))?;

        if !source_meta.is_dir() {
            anyhow::bail!("Source path is not a directory: {:?}", source_canonical);
        }

        // 3. Warn if symlink (safe to continue since we canonicalized)
        if source_meta.file_type().is_symlink() {
            eprintln!("Warning: Source path is a symlink: {:?} -> {:?}", self.source, source_canonical);
        }

        // 4. Handle target path similarly
        let target_canonical = if self.target.exists() {
            let target_meta = tokio::fs::metadata(&self.target)
                .await
                .with_context(|| format!("Failed to access target: {:?}", self.target))?;

            if !target_meta.is_dir() {
                anyhow::bail!("Target path exists but is not a directory: {:?}", self.target);
            }

            Some(tokio::fs::canonicalize(&self.target)
                .await
                .with_context(|| format!("Failed to canonicalize target: {:?}", self.target))?)
        } else {
            None
        };

        // 5. Use canonicalized paths for all operations
        let source_files = self
            .read_directory(&source_canonical, &options.exclude_patterns)
            .await
            .context("Failed to read source directory")?;

        let target_files = if let Some(ref target) = target_canonical {
            self.read_directory(target, &options.exclude_patterns)
                .await
                .context("Failed to read target directory")?
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
        let mut target_newer_conflicts = Vec::new();

        for (path, source_meta) in &source_map {
            if let Some(target_meta) = target_map.get(path) {
                if source_meta.is_file {
                    if target_meta.modified > source_meta.modified {
                        target_newer_conflicts.push(TargetNewerConflictCandidate {
                            path: path.clone(),
                            source_path: source_canonical.join(path),
                            target_path: target_canonical
                                .as_ref()
                                .map(|target| target.join(path))
                                .unwrap_or_else(|| self.target.join(path)),
                            source: Self::snapshot_from_metadata(source_meta),
                            target: Self::snapshot_from_metadata(target_meta),
                        });
                        continue;
                    }

                    // 1. First check metadata (fastest)
                    let mut needs_copy = source_meta.size != target_meta.size
                        || source_meta.modified > target_meta.modified;

                    // 2. If metadata matches but checksum mode is on, check content (slower but accurate)
                    if !needs_copy && options.checksum_mode {
                        let source_hash =
                            self.calculate_checksum(&source_canonical.join(path)).await?;
                        let target_hash = if let Some(target) = target_canonical.as_ref() {
                            self.calculate_checksum(&target.join(path)).await?
                        } else {
                            self.calculate_checksum(&self.target.join(path)).await?
                        };

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

        let files_to_copy = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::New || d.kind == FileDiffKind::Modified)
            .count();
        let files_modified = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::Modified)
            .count();

        let total_files = source_files.iter().filter(|f| f.is_file).count();

        Ok((
            DryRunResult {
                diffs,
                total_files,
                files_to_copy,
                files_modified,
                bytes_to_copy,
            },
            target_newer_conflicts,
        ))
    }

    pub async fn compare_dirs(&self, options: &SyncOptions) -> Result<DryRunResult> {
        let (dry_run, _) = self.compare_dirs_internal(options).await?;
        Ok(dry_run)
    }

    pub async fn target_newer_conflicts(
        &self,
        options: &SyncOptions,
    ) -> Result<Vec<TargetNewerConflictCandidate>> {
        let (_, conflicts) = self.compare_dirs_internal(options).await?;
        Ok(conflicts)
    }

    pub async fn dry_run(&self, options: &SyncOptions) -> Result<DryRunResult> {
        self.compare_dirs(options).await
    }

    pub async fn sync_files(
        &self,
        options: &SyncOptions,
        progress_callback: impl Fn(crate::sync_engine::types::SyncProgress),
    ) -> Result<SyncResult> {
        let (dry_run, _) = self.compare_dirs_internal(options).await?;

        let mut result = SyncResult {
            files_copied: 0,
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
                            // Reduce callback frequency for large files? 
                            // Current `copy_file_chunked` calls back every 64KB.
                            // For large files this is spammy. 
                            // But `start_sync` throttles the event emission. 
                            // The issue is `log_with_event` in `start_sync` which is called when file matches.
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
                    } else {
                        result.files_copied += 1;
                        result.bytes_copied += file_size;
                    }

                    current_progress.processed_files += 1;
                    progress_callback(current_progress.clone());
                }
            }
        }

        Ok(result)
    }

    pub async fn find_orphan_files(&self, exclude_patterns: &[String]) -> Result<Vec<OrphanFile>> {
        let source_canonical = tokio::fs::canonicalize(&self.source)
            .await
            .with_context(|| format!("Failed to canonicalize source: {:?}", self.source))?;

        let source_meta = tokio::fs::metadata(&source_canonical)
            .await
            .with_context(|| format!("Failed to access source: {:?}", source_canonical))?;
        if !source_meta.is_dir() {
            anyhow::bail!("Source path is not a directory: {:?}", source_canonical);
        }

        let target_canonical = match tokio::fs::metadata(&self.target).await {
            Ok(target_meta) => {
                if !target_meta.is_dir() {
                    anyhow::bail!("Target path exists but is not a directory: {:?}", self.target);
                }
                tokio::fs::canonicalize(&self.target)
                    .await
                    .with_context(|| format!("Failed to canonicalize target: {:?}", self.target))?
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err).with_context(|| format!("Failed to access target: {:?}", self.target)),
        };

        let source_files = self
            .read_directory(&source_canonical, exclude_patterns)
            .await
            .context("Failed to read source directory")?;
        let target_files = self
            .read_directory(&target_canonical, exclude_patterns)
            .await
            .context("Failed to read target directory")?;

        let source_paths: HashSet<&PathBuf> = source_files.iter().map(|f| &f.path).collect();
        let mut orphans: Vec<OrphanFile> = target_files
            .iter()
            .filter(|meta| !source_paths.contains(&meta.path))
            .map(|meta| OrphanFile {
                path: meta.path.clone(),
                size: if meta.is_file { meta.size } else { 0 },
                is_dir: !meta.is_file,
            })
            .collect();

        orphans.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(orphans)
    }

    /// Counts the number of descendant files and directories inside `path`.
    ///
    /// **Note**: The counts are a snapshot taken *before* the actual deletion. Between the
    /// time this function returns and `remove_dir_all` completes, external processes may
    /// add or remove entries, making the reported counts approximate. This is an inherent
    /// limitation — the alternative (counting after deletion) is impossible.
    async fn count_dir_contents(path: PathBuf) -> Result<(usize, usize)> {
        tokio::task::spawn_blocking(move || {
            let mut files_count = 0usize;
            let mut dirs_count = 0usize;

            for entry in WalkDir::new(&path).into_iter().filter_map(|entry| entry.ok()) {
                if entry.path() == path.as_path() {
                    continue;
                }

                if entry.file_type().is_dir() {
                    dirs_count += 1;
                } else {
                    files_count += 1;
                }
            }

            Ok((files_count, dirs_count))
        })
        .await?
    }

    pub async fn delete_orphan_paths(&self, relative_paths: &[PathBuf]) -> Result<DeleteOrphanResult> {
        let target_canonical = tokio::fs::canonicalize(&self.target)
            .await
            .with_context(|| format!("Failed to canonicalize target: {:?}", self.target))?;

        let mut canonical_targets: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut skipped_count = 0usize;

        for relative in relative_paths {
            if relative.is_absolute() {
                skipped_count += 1;
                continue;
            }
            if relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                skipped_count += 1;
                continue;
            }

            let full_path = target_canonical.join(relative);
            if !full_path.exists() {
                skipped_count += 1;
                continue;
            }

            let canonical = tokio::fs::canonicalize(&full_path)
                .await
                .with_context(|| format!("Failed to canonicalize orphan path: {:?}", full_path))?;

            if !canonical.starts_with(&target_canonical) {
                skipped_count += 1;
                continue;
            }

            canonical_targets.push((relative.clone(), canonical));
        }

        canonical_targets.sort_by(|a, b| a.0.components().count().cmp(&b.0.components().count()));

        let mut reduced_targets: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (relative, canonical) in canonical_targets {
            let is_covered = reduced_targets.iter().any(|(kept_relative, _)| {
                relative == *kept_relative
                    || relative
                        .strip_prefix(kept_relative)
                        .map(|rest| !rest.as_os_str().is_empty())
                        .unwrap_or(false)
            });
            if !is_covered {
                reduced_targets.push((relative, canonical));
            }
        }

        reduced_targets.sort_by(|a, b| b.0.components().count().cmp(&a.0.components().count()));

        let mut deleted_files_count = 0usize;
        let mut deleted_dirs_count = 0usize;
        let mut failures = Vec::new();

        for (relative, canonical) in reduced_targets {
            let metadata = match tokio::fs::symlink_metadata(&canonical).await {
                Ok(meta) => meta,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    skipped_count += 1;
                    continue;
                }
                Err(err) => {
                    failures.push(DeleteOrphanFailure {
                        path: relative,
                        error: err.to_string(),
                    });
                    continue;
                }
            };

            let mut dir_contents = None;
            let delete_result = if metadata.is_dir() {
                match Self::count_dir_contents(canonical.clone()).await {
                    Ok(counts) => {
                        dir_contents = Some(counts);
                    }
                    Err(err) => {
                        failures.push(DeleteOrphanFailure {
                            path: relative.clone(),
                            error: err.to_string(),
                        });
                        continue;
                    }
                }
                tokio::fs::remove_dir_all(&canonical).await
            } else {
                tokio::fs::remove_file(&canonical).await
            };

            match delete_result {
                Ok(()) => {
                    if metadata.is_dir() {
                        if let Some((descendant_files, descendant_dirs)) = dir_contents {
                            deleted_files_count += descendant_files;
                            deleted_dirs_count += descendant_dirs + 1;
                        } else {
                            deleted_dirs_count += 1;
                        }
                    } else {
                        deleted_files_count += 1;
                    }
                }
                Err(err) => failures.push(DeleteOrphanFailure {
                    path: relative,
                    error: err.to_string(),
                }),
            }
        }

        let deleted_count = deleted_files_count + deleted_dirs_count;
        Ok(DeleteOrphanResult {
            deleted_count,
            deleted_files_count,
            deleted_dirs_count,
            skipped_count,
            failures,
        })
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

    #[tokio::test]
    async fn test_target_newer_conflict_is_not_copied() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/photo.jpg");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"source-v1").await?;
        fs::write(&target_file, b"target-v2").await?;

        let source_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let target_time = source_time + std::time::Duration::from_secs(60);
        filetime::set_file_mtime(&source_file, filetime::FileTime::from_system_time(source_time))?;
        filetime::set_file_mtime(&target_file, filetime::FileTime::from_system_time(target_time))?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 0);

        let conflicts = engine.target_newer_conflicts(&options).await?;
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, relative);

        let sync_result = engine.sync_files(&options, |_| {}).await?;
        assert_eq!(sync_result.files_copied, 0);

        let target_content = fs::read(&target_file).await?;
        assert_eq!(target_content, b"target-v2");
        Ok(())
    }


    #[tokio::test]
    async fn test_exclusion() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let file1 = source_dir.path().join("file1.txt");
        let file2 = source_dir.path().join("file2.txt");
        let ignored_file = source_dir.path().join("ignore_me.txt");
        let ignored_dir = source_dir.path().join("node_modules");
        fs::create_dir(&ignored_dir).await?;
        let ignored_nested = ignored_dir.join("dep.js");

        fs::write(&file1, b"content").await?;
        fs::write(&file2, b"content").await?;
        fs::write(&ignored_file, b"content").await?;
        fs::write(&ignored_nested, b"content").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        
        let mut options = SyncOptions::default();
        options.exclude_patterns = vec![
            "ignore_me.txt".to_string(), 
            "node_modules/**".to_string()
        ];

        let dry_run = engine.dry_run(&options).await?;
        // Should only copy file1.txt and file2.txt
        assert_eq!(dry_run.files_to_copy, 2);

        let result = engine.sync_files(&options, |_| {}).await?;
        assert_eq!(result.files_copied, 2);

        assert!(target_dir.path().join("file1.txt").exists());
        assert!(target_dir.path().join("file2.txt").exists());
        assert!(!target_dir.path().join("ignore_me.txt").exists());
        assert!(!target_dir.path().join("node_modules").exists());

        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_empty_patterns() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        let file1 = source_dir.path().join("file1.txt");
        fs::write(&file1, b"content").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let mut options = SyncOptions::default();
        options.exclude_patterns = vec![];

        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);
        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_special_characters() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        
        let file_normal = source_dir.path().join("normal.txt");
        let file_special = source_dir.path().join("special[1].txt");
        let file_space = source_dir.path().join("file with spaces.txt");
        
        fs::write(&file_normal, b"content").await?;
        fs::write(&file_special, b"content").await?;
        fs::write(&file_space, b"content").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let mut options = SyncOptions::default();
        options.exclude_patterns = vec![
            "file with spaces.txt".to_string(),
            "special*".to_string() 
        ];

        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1); 
        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_nested_wildcards() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        
        let dir1 = source_dir.path().join("dir1");
        fs::create_dir(&dir1).await?;
        let file1 = dir1.join("ignore.log");
        let file2 = dir1.join("keep.txt");
        
        fs::write(&file1, b"log").await?;
        fs::write(&file2, b"txt").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let mut options = SyncOptions::default();
        options.exclude_patterns = vec!["**/*.log".to_string()];

        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);
        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_validation_limits() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        
        // 소스 디렉토리에 파일 생성 (read_directory가 호출되도록)
        let test_file = source_dir.path().join("test.txt");
        fs::write(&test_file, b"test content").await?;
        
        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        
        // Test count limit (101개 패턴 -> MAX_PATTERN_COUNT=100 초과)
        let mut options = SyncOptions::default();
        options.exclude_patterns = (0..101).map(|i| format!("pattern_{}", i)).collect();
        let result = engine.dry_run(&options).await;
        
        // 에러 체인 전체를 확인 (anyhow는 context로 래핑되므로 :# 포맷 사용)
        match &result {
            Ok(_) => panic!("Expected error for too many patterns, but got Ok"),
            Err(e) => {
                // anyhow 에러 체인 전체를 문자열로 (debug format 사용)
                let full_err = format!("{:#}", e);
                println!("Full error chain for count limit: {}", full_err);
                assert!(
                    full_err.contains("Too many") || full_err.contains("too many"),
                    "Error chain should contain 'Too many', got: {}", full_err
                );
            }
        }

        // Test length limit (300자 패턴 -> MAX_PATTERN_LENGTH=255 초과)
        let mut options2 = SyncOptions::default();
        let long_pattern = "a".repeat(300);
        options2.exclude_patterns = vec![long_pattern];
        let result2 = engine.dry_run(&options2).await;
        
        match &result2 {
            Ok(_) => panic!("Expected error for too long pattern, but got Ok"),
            Err(e) => {
                let full_err = format!("{:#}", e);
                println!("Full error chain for length limit: {}", full_err);
                assert!(
                    full_err.contains("too long") || full_err.contains("Too long"),
                    "Error chain should contain 'too long', got: {}", full_err
                );
            }
        }

        Ok(())
    }

    #[tokio::test]
    async fn test_find_orphan_files() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let shared = source_dir.path().join("shared.txt");
        let orphan_file = target_dir.path().join("orphan.txt");
        let orphan_dir = target_dir.path().join("stale");
        let orphan_nested = orphan_dir.join("old.txt");

        fs::write(&shared, b"same").await?;
        fs::create_dir_all(&orphan_dir).await?;
        fs::write(source_dir.path().join("existing.txt"), b"source").await?;
        fs::write(target_dir.path().join("shared.txt"), b"same").await?;
        fs::write(&orphan_file, b"target-only").await?;
        fs::write(&orphan_nested, b"nested").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let orphans = engine.find_orphan_files(&[]).await?;

        let orphan_paths: Vec<String> = orphans
            .iter()
            .map(|o| o.path.to_string_lossy().to_string())
            .collect();

        assert!(orphan_paths.contains(&"orphan.txt".to_string()));
        assert!(orphan_paths.contains(&"stale".to_string()));
        assert!(orphan_paths.contains(&"stale/old.txt".to_string()));
        assert!(!orphan_paths.contains(&"shared.txt".to_string()));

        Ok(())
    }

    #[tokio::test]
    async fn test_delete_orphan_paths() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let orphan_dir = target_dir.path().join("stale");
        let orphan_nested = orphan_dir.join("old.txt");
        let orphan_file = target_dir.path().join("orphan.txt");

        fs::create_dir_all(&orphan_dir).await?;
        fs::write(&orphan_nested, b"nested").await?;
        fs::write(&orphan_file, b"target-only").await?;
        fs::write(source_dir.path().join("keep.txt"), b"keep").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let paths = vec![
            PathBuf::from("stale/old.txt"),
            PathBuf::from("stale"),
            PathBuf::from("orphan.txt"),
            PathBuf::from("../escape"),
        ];
        let result = engine.delete_orphan_paths(&paths).await?;

        assert_eq!(result.deleted_files_count, 2);
        assert_eq!(result.deleted_dirs_count, 1);
        assert_eq!(result.deleted_count, 3);
        assert_eq!(result.failures.len(), 0);
        assert!(!target_dir.path().join("stale").exists());
        assert!(!target_dir.path().join("orphan.txt").exists());
        assert!(result.skipped_count >= 1);

        Ok(())
    }

    #[tokio::test]
    async fn test_delete_orphan_paths_nested_directory_counts() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let root_orphan_dir = target_dir.path().join("stale");
        let nested_dir = root_orphan_dir.join("nested").join("leaf");
        let nested_file = nested_dir.join("old.txt");
        let root_file = root_orphan_dir.join("root.txt");

        fs::create_dir_all(&nested_dir).await?;
        fs::write(&nested_file, b"nested").await?;
        fs::write(&root_file, b"root").await?;
        fs::write(source_dir.path().join("keep.txt"), b"keep").await?;

        let engine = SyncEngine::new(source_dir.path().to_path_buf(), target_dir.path().to_path_buf());
        let result = engine.delete_orphan_paths(&[PathBuf::from("stale")]).await?;

        assert_eq!(result.deleted_files_count, 2);
        assert_eq!(result.deleted_dirs_count, 3);
        assert_eq!(result.deleted_count, 5);
        assert_eq!(result.failures.len(), 0);
        assert!(!target_dir.path().join("stale").exists());

        Ok(())
    }
}
