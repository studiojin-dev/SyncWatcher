use crate::copy_history::{self, CopyHistoryLedger};
use crate::save_rules::{CollisionResolver, SaveRuleMapper, SaveRuleTemplateRecord};
use crate::sync_engine::types::{
    ConflictFileSnapshot, CopyHistoryCandidate, DeleteOrphanFailure, DeleteOrphanResult,
    DryRunPhase, DryRunProgress, DryRunResult, DryRunSummary, FileDiff, FileDiffKind, FileMetadata, OrphanFile, SyncFileEntry,
    SyncFileStatus, SyncOptions, SyncProgress, SyncProgressPhase, SyncResult,
    SkippedSourceSnapshot, TargetNewerConflictCandidate, MAX_PREVIOUSLY_COPIED_PATHS,
};
use anyhow::Context;
use anyhow::Result;
use globset::{Glob, GlobSetBuilder};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::hash::Hasher;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::SystemTime;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir; // Import Context trait

/// 건너뛴 파일이 비교 뒤 바뀌어 실행을 멈출 때의 오류 (ADR-0040).
pub const SKIPPED_FILE_CHANGED_ERROR: &str =
    "A file skipped as already copied changed after the compare";
/// 건너뛰기 판단에 쓴 타깃 폴더가 바뀌어 실행을 멈출 때의 오류 (ADR-0040).
pub const SKIP_TARGET_CHANGED_ERROR: &str =
    "Target folder changed after files were skipped as already copied";

pub struct SyncEngine {
    source: PathBuf,
    target: PathBuf,
    /// 기본 소스의 작업 내 순서. 첫 번째 소스가 빠져 다른 소스가 기본이 되면 0이 아니다 (ADR-0039).
    source_position: usize,
    /// 기본 소스 뒤에 이어지는 추가 소스들 (ADR-0039).
    extra_sources: Vec<ExtraSourcePath>,
}

/// 이번 실행에 쓸 추가 소스 하나.
#[derive(Debug, Clone)]
pub struct ExtraSourcePath {
    /// 작업에 정의된 소스 순서 (기본 소스 = 0). 빠진 소스가 있어도 충돌 접미사 글자가 바뀌지 않게 한다.
    pub position: usize,
    pub path: PathBuf,
}

/// 정규화된 소스 루트 하나와 그 스캔 결과.
struct ScannedSource {
    position: usize,
    root: PathBuf,
    files: Vec<FileMetadata>,
}

/// 타깃에 쓸 소스 파일 하나: `sources[source_index].files[file_index]` → `target_relative`.
struct PlannedFile {
    source_index: usize,
    file_index: usize,
    target_relative: PathBuf,
}

/// 소스 순서 글자. 기본 소스가 `a`, 두 번째가 `b` …
fn source_letter(index: usize) -> String {
    if index < 26 {
        char::from(b'a' + index as u8).to_string()
    } else {
        format!("s{}", index + 1)
    }
}

/// `dir/name.ext` → `dir/name{suffix}.ext`
fn with_file_name_suffix(path: &Path, suffix: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let name = format!("{stem}{suffix}{extension}");
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

/// 다른 소스가 이미 차지한 타깃 경로를 피해 소스 글자 접미사(`_b`)를, 그것도 차 있으면 `_b_2` …를 붙인다.
fn resolve_cross_source_collision(
    base: &Path,
    source_position: usize,
    taken: &HashSet<PathBuf>,
) -> PathBuf {
    let letter = source_letter(source_position);
    let lettered = with_file_name_suffix(base, &format!("_{letter}"));
    if !taken.contains(&lettered) {
        return lettered;
    }
    for index in 2u32.. {
        let candidate = with_file_name_suffix(base, &format!("_{letter}_{index}"));
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("cross-source collision resolver exhausted u32 range")
}

const HARD_IGNORED_ROOT_METADATA_DIRS: [&str; 4] = [
    ".fseventsd",
    ".Spotlight-V100",
    ".Trashes",
    ".TemporaryItems",
];

fn is_hard_ignored_root_metadata_dir(relative_path: &Path, is_dir: bool) -> bool {
    if !is_dir {
        return false;
    }

    let mut components = relative_path.components();
    let Some(first) = components.next() else {
        return false;
    };

    // Root-level only: nested matches (e.g. photos/.Trashes) are intentionally allowed.
    if components.next().is_some() {
        return false;
    }

    match first {
        Component::Normal(name) => HARD_IGNORED_ROOT_METADATA_DIRS
            .iter()
            .any(|candidate| name == OsStr::new(candidate)),
        _ => false,
    }
}

async fn reject_symlink_destination_under_root(root: &Path, target: &Path) -> Result<()> {
    let relative = target.strip_prefix(root).with_context(|| {
        format!(
            "Target path '{}' is not under sync target root '{}'",
            target.display(),
            root.display()
        )
    })?;
    let root_canonical = fs::canonicalize(root)
        .await
        .with_context(|| format!("Failed to canonicalize target root '{}'", root.display()))?;
    let mut current = root_canonical;

    for component in relative.components() {
        match component {
            Component::Normal(part) => current.push(part),
            Component::CurDir => continue,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("Unsafe target path component in '{}'", target.display());
            }
        }

        match fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                anyhow::bail!(
                    "Refusing to write through symlink target path '{}'",
                    current.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Failed to inspect '{}'", current.display()));
            }
        }
    }

    Ok(())
}

impl SyncEngine {
    pub fn new(source: PathBuf, target: PathBuf) -> Self {
        Self {
            source,
            target,
            source_position: 0,
            extra_sources: Vec::new(),
        }
    }

    /// 기본 소스의 작업 내 순서를 지정한다. 충돌 접미사 글자가 이 순서를 따른다.
    pub fn with_source_position(mut self, position: usize) -> Self {
        self.source_position = position;
        self
    }

    /// 추가 소스를 지정한다. 호출자는 이번 실행에 쓸 수 있는 소스만 넘긴다.
    pub fn with_extra_sources(mut self, extra_sources: Vec<ExtraSourcePath>) -> Self {
        self.extra_sources = extra_sources;
        self
    }

    /// (소스 순서, 경로) 목록. 기본 소스가 먼저다.
    fn all_source_paths(&self) -> impl Iterator<Item = (usize, &PathBuf)> {
        std::iter::once((self.source_position, &self.source)).chain(
            self.extra_sources
                .iter()
                .map(|extra| (extra.position, &extra.path)),
        )
    }

    async fn canonical_source_dir(path: &Path) -> Result<PathBuf> {
        let canonical = tokio::fs::canonicalize(path)
            .await
            .with_context(|| format!("Failed to canonicalize source: {:?}", path))?;
        let meta = tokio::fs::metadata(&canonical).await.with_context(|| {
            format!(
                "Failed to access source after canonicalization: {:?}",
                canonical
            )
        })?;
        if !meta.is_dir() {
            anyhow::bail!("Source path is not a directory: {:?}", canonical);
        }
        Ok(canonical)
    }

    async fn scan_sources<P>(
        &self,
        exclude_patterns: &[String],
        cancel_token: Option<CancellationToken>,
        progress_callback: Arc<StdMutex<P>>,
    ) -> Result<Vec<ScannedSource>>
    where
        P: FnMut(DryRunProgress) + Send + 'static,
    {
        let mut scanned = Vec::new();
        for (position, source) in self.all_source_paths() {
            let root = Self::canonical_source_dir(source).await?;
            let files = self
                .read_directory(
                    &root,
                    DryRunPhase::ScanningSource,
                    exclude_patterns,
                    cancel_token.clone(),
                    progress_callback.clone(),
                )
                .await
                .context("Failed to read source directory")?;
            scanned.push(ScannedSource {
                position,
                root,
                files,
            });
        }
        Ok(scanned)
    }

    async fn cached_checksum(
        &self,
        cache: &mut HashMap<(usize, usize), String>,
        sources: &[ScannedSource],
        source_index: usize,
        file_index: usize,
    ) -> Result<String> {
        if let Some(hash) = cache.get(&(source_index, file_index)) {
            return Ok(hash.clone());
        }
        let source = &sources[source_index];
        let hash = self
            .calculate_checksum(&source.root.join(&source.files[file_index].path))
            .await?;
        cache.insert((source_index, file_index), hash.clone());
        Ok(hash)
    }

    /// 모든 소스 파일의 타깃 상대 경로를 정한다 (ADR-0039).
    /// 소스 순서대로, 소스 안에서는 경로 순서대로 처리해 결과가 결정적이다.
    /// 앞선 소스와 같은 타깃 경로가 나오면 내용(xxHash)이 같을 때는 건너뛰고,
    /// 다르면 소스 글자 접미사를 붙인다.
    async fn plan_target_paths(
        &self,
        sources: &[ScannedSource],
        save_rule: Option<&SaveRuleTemplateRecord>,
        cancel_token: Option<CancellationToken>,
        on_progress: &(dyn Fn(DryRunProgress) + Sync),
    ) -> Result<Vec<PlannedFile>> {
        let multi_source = sources.len() > 1;
        let total_files = sources
            .iter()
            .flat_map(|source| source.files.iter())
            .filter(|file| file.is_file)
            .count() as u64;
        let mut planned_files = 0u64;
        let mut last_emit_at = std::time::Instant::now() - std::time::Duration::from_millis(100);
        let mut planned = Vec::new();
        let mut taken: HashSet<PathBuf> = HashSet::new();
        let mut claimants: HashMap<PathBuf, Vec<(usize, usize)>> = HashMap::new();
        let mut hash_cache: HashMap<(usize, usize), String> = HashMap::new();

        for (source_index, scanned) in sources.iter().enumerate() {
            let mapping = match save_rule {
                Some(rule) => Some(
                    Self::build_target_mapping(
                        &scanned.root,
                        &scanned.files,
                        rule,
                        cancel_token.clone(),
                    )
                    .await?,
                ),
                None => None,
            };
            let mut order: Vec<usize> = (0..scanned.files.len())
                .filter(|&index| scanned.files[index].is_file)
                .collect();
            order.sort_by(|a, b| scanned.files[*a].path.cmp(&scanned.files[*b].path));

            for file_index in order {
                if cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
                    anyhow::bail!("Operation cancelled while planning target paths");
                }
                let file = &scanned.files[file_index];
                planned_files += 1;
                let base = mapping
                    .as_ref()
                    .and_then(|mapping| mapping.get(&file.path).cloned())
                    .unwrap_or_else(|| file.path.clone());

                if !multi_source {
                    planned.push(PlannedFile {
                        source_index,
                        file_index,
                        target_relative: base,
                    });
                    continue;
                }

                if !taken.contains(&base) {
                    taken.insert(base.clone());
                    claimants
                        .entry(base.clone())
                        .or_default()
                        .push((source_index, file_index));
                    planned.push(PlannedFile {
                        source_index,
                        file_index,
                        target_relative: base,
                    });
                    continue;
                }

                let earlier: Vec<(usize, usize)> = claimants
                    .get(&base)
                    .map(|list| {
                        list.iter()
                            .copied()
                            .filter(|(other_source, _)| *other_source != source_index)
                            .collect()
                    })
                    .unwrap_or_default();
                // 소스 간 중복 확인은 해시를 읽으므로 진행 상황을 알린다.
                let now = std::time::Instant::now();
                if now.duration_since(last_emit_at) >= std::time::Duration::from_millis(100) {
                    last_emit_at = now;
                    on_progress(SyncEngine::build_dry_run_progress(
                        DryRunPhase::Comparing,
                        format!(
                            "Checking duplicates across sources: {}",
                            file.path.to_string_lossy()
                        ),
                        planned_files,
                        total_files,
                        0,
                        0,
                        DryRunSummary {
                            total_files: total_files as usize,
                            ..DryRunSummary::default()
                        },
                    ));
                }
                let mut duplicate = false;
                for (other_source, other_file) in earlier {
                    if sources[other_source].files[other_file].size != file.size {
                        continue;
                    }
                    let other_hash = self
                        .cached_checksum(&mut hash_cache, sources, other_source, other_file)
                        .await?;
                    let own_hash = self
                        .cached_checksum(&mut hash_cache, sources, source_index, file_index)
                        .await?;
                    if other_hash == own_hash {
                        duplicate = true;
                        break;
                    }
                }
                if duplicate {
                    continue;
                }

                claimants
                    .entry(base.clone())
                    .or_default()
                    .push((source_index, file_index));
                let resolved = resolve_cross_source_collision(&base, scanned.position, &taken);
                taken.insert(resolved.clone());
                planned.push(PlannedFile {
                    source_index,
                    file_index,
                    target_relative: resolved,
                });
            }
        }

        Ok(planned)
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

    fn compare_modified_time_at_second_precision(left: SystemTime, right: SystemTime) -> Ordering {
        let left_secs = left
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs());
        let right_secs = right
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs());

        match (left_secs, right_secs) {
            (Some(left_secs), Some(right_secs)) => left_secs.cmp(&right_secs),
            _ => left.cmp(&right),
        }
    }

    fn build_dry_run_progress(
        phase: DryRunPhase,
        message: String,
        current: u64,
        total: u64,
        processed_bytes: u64,
        total_bytes: u64,
        summary: DryRunSummary,
    ) -> DryRunProgress {
        DryRunProgress {
            phase,
            message,
            current,
            total,
            processed_bytes,
            total_bytes,
            summary,
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

    async fn read_directory<P>(
        &self,
        dir: &Path,
        phase: DryRunPhase,
        exclude_patterns: &[String],
        cancel_token: Option<CancellationToken>,
        progress_callback: Arc<StdMutex<P>>,
    ) -> Result<Vec<FileMetadata>>
    where
        P: FnMut(DryRunProgress) + Send + 'static,
    {
        let dir_buf = dir.to_path_buf();
        let patterns = exclude_patterns.to_vec();

        tokio::task::spawn_blocking(move || {
            let mut files = Vec::new();
            let mut scanned_entries = 0u64;
            let mut scanned_files = 0usize;
            let mut scanned_bytes = 0u64;
            let mut last_emit_at =
                std::time::Instant::now() - std::time::Duration::from_millis(100);
            let emit_interval = std::time::Duration::from_millis(100);

            // Pattern validation constants
            const MAX_PATTERN_LENGTH: usize = 255;
            const MAX_PATTERN_COUNT: usize = 300;

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
                        }
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

                if is_hard_ignored_root_metadata_dir(relative_path, e.file_type().is_dir()) {
                    return false;
                }

                // Check exclusion patterns
                // If it matches, return FALSE to skip entering directory or processing file
                !globs.is_match(relative_path)
            });

            for entry_result in walker {
                let entry = match entry_result {
                    Ok(entry) => entry,
                    Err(err) => {
                        let failed_path = err
                            .path()
                            .map(|path| path.to_path_buf())
                            .unwrap_or_else(|| dir_buf.clone());
                        return Err(anyhow::Error::new(err)).with_context(|| {
                            format!("Failed to traverse directory entry: {:?}", failed_path)
                        });
                    }
                };
                if let Some(token) = cancel_token.as_ref() {
                    if token.is_cancelled() {
                        anyhow::bail!("Dry run cancelled by user");
                    }
                }

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
                scanned_entries += 1;
                let current_path = Some(relative_path.to_string_lossy().to_string());

                if metadata.is_file() {
                    scanned_files += 1;
                    scanned_bytes += metadata.len();
                }

                files.push(FileMetadata {
                    path: relative_path,
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH), // Fallback if modified time unavailable
                    created: metadata.created().ok(),
                    is_file: metadata.is_file(),
                });

                let now = std::time::Instant::now();
                let should_emit = now.duration_since(last_emit_at) >= emit_interval;

                if should_emit {
                    last_emit_at = now;
                    let progress = SyncEngine::build_dry_run_progress(
                        phase,
                        current_path.unwrap_or_else(|| dir_buf.to_string_lossy().to_string()),
                        scanned_entries,
                        0,
                        scanned_bytes,
                        0,
                        DryRunSummary {
                            total_files: scanned_files,
                            files_to_copy: 0,
                            files_modified: 0,
                            bytes_to_copy: 0,
                        },
                    );

                    if let Ok(mut callback) = progress_callback.lock() {
                        callback(progress);
                    }
                }
            }

            let final_progress = SyncEngine::build_dry_run_progress(
                phase,
                dir_buf.to_string_lossy().to_string(),
                scanned_entries,
                0,
                scanned_bytes,
                0,
                DryRunSummary {
                    total_files: scanned_files,
                    files_to_copy: 0,
                    files_modified: 0,
                    bytes_to_copy: 0,
                },
            );
            if let Ok(mut callback) = progress_callback.lock() {
                callback(final_progress);
            }

            Ok(files)
        })
        .await?
    }

    /// 타깃과 이미 같은 파일을 기록에 더할지. 이름·크기가 이미 기록돼 있으면 파일을 다시 읽지 않는다.
    fn should_record_in_sync(history: &CopyHistoryLedger, relative: &Path, size: u64) -> bool {
        if !copy_history::is_eligible(relative) {
            return false;
        }
        copy_history::file_name_of(relative)
            .is_some_and(|name| !history.contains_name_size(&name, size))
    }

    /// 타깃에 없는 파일이 복사 기록에 있는지 (ADR-0040).
    /// 이름·크기가 맞을 때만 촬영 시각을 읽는다.
    async fn is_previously_copied(
        history: Option<&CopyHistoryLedger>,
        source_path: &Path,
        target_path: &Path,
        meta: &FileMetadata,
    ) -> Result<Option<String>> {
        let Some(history) = history else {
            return Ok(None);
        };
        if !copy_history::is_eligible(&meta.path) {
            return Ok(None);
        }
        let Some(name) = copy_history::file_name_of(&meta.path) else {
            return Ok(None);
        };
        if !history.contains_name_size(&name, meta.size) {
            return Ok(None);
        }
        // 기록을 읽은 뒤 같은 경로의 타깃 폴더(디스크)가 바뀌었으면 기록을 근거로 건너뛰지 않는다.
        if !history.target_unchanged() {
            return Ok(None);
        }
        let source_path = source_path.to_path_buf();
        let target_path = target_path.to_path_buf();
        let modified = meta.modified;
        let size = meta.size;
        // 파일을 읽을 수 없거나, 스캔 뒤 바뀌었거나, 읽기 작업이 실패하면 복사하지 않은 것으로 본다
        // (의심스러우면 복사한다).
        let Ok(Some(captured)) = tokio::task::spawn_blocking(move || {
            // 스캔 목록에 없어도 타깃 파일 시스템에서 그 경로가 실제로 비어 있어야 한다
            // (대소문자를 구분하지 않는 볼륨에서 이름의 대소문자만 바뀐 파일 등). 있으면 일반 비교로 보낸다.
            let target_empty = matches!(
                std::fs::symlink_metadata(&target_path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            );
            if !target_empty {
                return None;
            }
            let unchanged = std::fs::metadata(&source_path).is_ok_and(|current| {
                current.len() == size && current.modified().is_ok_and(|time| time == modified)
            });
            if !unchanged {
                return None;
            }
            copy_history::capture_stamp(&source_path, modified)
        })
        .await
        else {
            return Ok(None);
        };
        let key = copy_history::CopyHistoryKey {
            name,
            size: meta.size,
            captured,
        };
        Ok(history.contains(&key).then_some(key.captured))
    }

    /// 후보가 아직 기록해도 되는 상태인지: 소스는 비교·복사 때와 같고, 타깃에 같은 크기의 파일이 있다.
    fn candidate_still_matches(candidate: &CopyHistoryCandidate) -> bool {
        let source_unchanged = std::fs::metadata(&candidate.source_path).is_ok_and(|meta| {
            meta.is_file()
                && meta.len() == candidate.size
                && meta.modified().is_ok_and(|modified| modified == candidate.modified)
        });
        source_unchanged
            && std::fs::metadata(&candidate.target_path).is_ok_and(|meta| {
                meta.is_file()
                    && meta.len() == candidate.size
                    && candidate.target_modified.is_none_or(|expected| {
                        meta.modified().is_ok_and(|modified| modified == expected)
                    })
            })
    }

    /// 건너뛴 파일이 비교 때와 같은지: 타깃 경로는 여전히 비어 있고, 소스는 크기·수정 시각과
    /// 촬영 시각 표지까지 같다. 다르면 건너뛸 근거가 없으므로 실행을 멈춘다.
    pub(crate) async fn ensure_skipped_sources_unchanged(dry_run: &DryRunResult) -> Result<()> {
        for skipped in &dry_run.previously_copied_sources {
            let target_empty = matches!(
                fs::symlink_metadata(&skipped.target_path).await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            );
            let snapshot = skipped.clone();
            let unchanged = target_empty
                && tokio::task::spawn_blocking(move || {
                    let same_meta = std::fs::metadata(&snapshot.source_path).is_ok_and(|meta| {
                        meta.is_file()
                            && meta.len() == snapshot.size
                            && meta.modified().is_ok_and(|modified| modified == snapshot.modified)
                    });
                    same_meta
                        && copy_history::capture_stamp(&snapshot.source_path, snapshot.modified)
                            .is_some_and(|captured| captured == snapshot.captured)
                })
                .await
                .unwrap_or(false);
            if !unchanged {
                anyhow::bail!(
                    "{SKIPPED_FILE_CHANGED_ERROR}: {}; run the sync again",
                    skipped.source_path.display()
                );
            }
        }
        Ok(())
    }

    fn ensure_skip_target_unchanged(dry_run: &DryRunResult, options: &SyncOptions) -> Result<()> {
        let changed = dry_run.skipped_previously_copied > 0
            && options
                .copy_history
                .as_deref()
                .is_some_and(|history| !history.target_unchanged());
        if changed {
            anyhow::bail!("{SKIP_TARGET_CHANGED_ERROR}; run the sync again");
        }
        Ok(())
    }

    /// 타깃과 이미 같았던 파일이 정말 소스와 같은 파일인지. 촬영 시각이 있으면 양쪽 값을,
    /// 없으면(수정 시각 키) 내용 전체를 비교한다. 비교 때 이미 해시가 같았으면 다시 읽지 않는다.
    /// 블로킹 컨텍스트에서 부른다.
    fn in_sync_candidate_is_same_file(
        candidate: &CopyHistoryCandidate,
        target_stamp: &str,
        history: &CopyHistoryLedger,
    ) -> bool {
        let source_stamp =
            copy_history::capture_stamp(&candidate.source_path, candidate.modified);
        if source_stamp.as_deref() != Some(target_stamp) {
            return false;
        }
        if target_stamp.starts_with("exif:") || candidate.content_verified {
            return true;
        }
        Self::files_have_same_bytes(&candidate.source_path, &candidate.target_path, history)
    }

    /// 두 파일의 내용이 같은지. 기록이 닫히면(실행 종료·취소) 읽기를 멈추고 다르다고 본다.
    fn files_have_same_bytes(left: &Path, right: &Path, history: &CopyHistoryLedger) -> bool {
        use std::io::Read;
        let (Ok(mut left), Ok(mut right)) =
            (std::fs::File::open(left), std::fs::File::open(right))
        else {
            return false;
        };
        let mut left_buf = vec![0u8; 1024 * 1024];
        let mut right_buf = vec![0u8; 1024 * 1024];
        loop {
            if history.is_closed() {
                return false;
            }
            let Ok(read) = left.read(&mut left_buf) else {
                return false;
            };
            if read == 0 {
                // 오른쪽도 끝나야 같다.
                return matches!(right.read(&mut right_buf[..1]), Ok(0));
            }
            if right.read_exact(&mut right_buf[..read]).is_err()
                || left_buf[..read] != right_buf[..read]
            {
                return false;
            }
        }
    }

    /// 복사했거나 이미 같았던 파일을 기록에 더한다. 그사이 소스나 타깃이 바뀐 파일은 기록하지 않는다.
    /// 기록 작업이 실패해도 동기화는 실패시키지 않는다 (기록되지 않은 파일은 다음에 다시 복사된다).
    async fn record_copy_history(
        history: &std::sync::Arc<CopyHistoryLedger>,
        candidates: Vec<CopyHistoryCandidate>,
    ) {
        if candidates.is_empty() {
            return;
        }
        let history = history.clone();
        let _ = tokio::task::spawn_blocking(move || {
            for candidate in candidates {
                // 실행이 끝났거나 취소돼 기록을 닫았으면 남은 파일은 읽지 않는다.
                if history.is_closed() {
                    break;
                }
                if !Self::candidate_still_matches(&candidate) {
                    continue;
                }
                let Some(key) = copy_history::key_for_file(
                    &candidate.target_path,
                    &candidate.relative_path,
                    candidate.size,
                    candidate.modified,
                ) else {
                    continue;
                };
                // 이미 같았던 파일은 크기·수정 시각으로만 같다고 판정됐을 수 있다. 소스와 같은
                // 파일인지 확인한 뒤에만 기록한다.
                if candidate.target_modified.is_some() {
                    if !Self::in_sync_candidate_is_same_file(&candidate, &key.captured, &history) {
                        continue;
                    }
                } else {
                    // 방금 복사한 파일: 복사 뒤 다른 도구가 타깃을 바꿔 놓았을 수 있으므로, 타깃의
                    // 촬영 시각이 소스와 같을 때만 기록한다 (수정 시각 키는 양쪽이 같은 값을 쓴다).
                    let source_stamp =
                        copy_history::capture_stamp(&candidate.source_path, candidate.modified);
                    if source_stamp.as_deref() != Some(key.captured.as_str()) {
                        continue;
                    }
                }
                history.insert(key);
            }
        })
        .await;
    }

    async fn compare_dirs_internal<P, D>(
        &self,
        options: &SyncOptions,
        cancel_token: Option<CancellationToken>,
        on_progress: P,
        mut on_diff: D,
    ) -> Result<(DryRunResult, Vec<TargetNewerConflictCandidate>)>
    where
        P: FnMut(DryRunProgress) + Send + 'static,
        D: FnMut(FileDiff, DryRunProgress),
    {
        let progress_callback = Arc::new(StdMutex::new(on_progress));

        let emit_progress = |progress: DryRunProgress| {
            if let Ok(mut callback) = progress_callback.lock() {
                callback(progress);
            }
        };

        // 4. Handle target path similarly
        let target_canonical = if self.target.exists() {
            let target_meta = tokio::fs::metadata(&self.target)
                .await
                .with_context(|| format!("Failed to access target: {:?}", self.target))?;

            if !target_meta.is_dir() {
                anyhow::bail!(
                    "Target path exists but is not a directory: {:?}",
                    self.target
                );
            }

            Some(
                tokio::fs::canonicalize(&self.target)
                    .await
                    .with_context(|| format!("Failed to canonicalize target: {:?}", self.target))?,
            )
        } else {
            None
        };

        // 5. Use canonicalized paths for all operations
        let sources = self
            .scan_sources(
                &options.exclude_patterns,
                cancel_token.clone(),
                progress_callback.clone(),
            )
            .await?;

        let target_files = if let Some(ref target) = target_canonical {
            self.read_directory(
                target,
                DryRunPhase::ScanningTarget,
                &options.exclude_patterns,
                cancel_token.clone(),
                progress_callback.clone(),
            )
            .await
            .context("Failed to read target directory")?
        } else {
            Vec::new()
        };

        let total_files = sources
            .iter()
            .flat_map(|source| source.files.iter())
            .filter(|f| f.is_file)
            .count();
        let total_bytes = sources
            .iter()
            .flat_map(|source| source.files.iter())
            .filter(|f| f.is_file)
            .map(|file| file.size)
            .sum();

        if options.save_rule.is_some() {
            emit_progress(SyncEngine::build_dry_run_progress(
                DryRunPhase::Comparing,
                "Applying save rules...".to_string(),
                0,
                total_files as u64,
                0,
                total_bytes,
                DryRunSummary {
                    total_files,
                    ..DryRunSummary::default()
                },
            ));
        }
        let planned = self
            .plan_target_paths(
                &sources,
                options.save_rule.as_ref(),
                cancel_token.clone(),
                &emit_progress,
            )
            .await?;

        let mut compare_summary = DryRunSummary {
            total_files,
            files_to_copy: 0,
            files_modified: 0,
            bytes_to_copy: 0,
        };
        let mut compare_processed_files = 0u64;
        let mut compare_processed_bytes = 0u64;
        let mut last_compare_emit_at =
            std::time::Instant::now() - std::time::Duration::from_millis(100);
        let compare_emit_interval = std::time::Duration::from_millis(100);

        let mut target_map: HashMap<PathBuf, &FileMetadata> = HashMap::new();

        for file in &target_files {
            target_map.insert(file.path.clone(), file);
        }

        let mut diffs = Vec::new();
        let mut bytes_to_copy = 0u64;
        let mut target_newer_conflicts = Vec::new();
        let mut skipped_previously_copied = 0usize;
        let mut previously_copied_paths = Vec::new();
        let mut previously_copied_sources = Vec::new();
        let mut copy_history_in_sync = Vec::new();

        emit_progress(SyncEngine::build_dry_run_progress(
            DryRunPhase::Comparing,
            "Comparing...".to_string(),
            0,
            total_files as u64,
            0,
            total_bytes,
            compare_summary.clone(),
        ));

        for planned_file in planned {
            if cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
                anyhow::bail!("Dry run cancelled by user");
            }
            let scanned = &sources[planned_file.source_index];
            let source_meta = &scanned.files[planned_file.file_index];
            let path = source_meta.path.clone();
            let source_canonical = &scanned.root;
            let source_root = (planned_file.source_index > 0).then(|| scanned.root.clone());
            let target_relative = planned_file.target_relative;
            let mapped_target_path = if target_relative != path {
                Some(target_relative.clone())
            } else {
                None
            };

            if let Some(target_meta) = target_map.get(&target_relative) {
                if source_meta.is_file {
                    compare_processed_files += 1;
                    compare_processed_bytes += source_meta.size;
                    let source_path = source_canonical.join(&path);
                    let target_path = target_canonical
                        .as_ref()
                        .map(|target| target.join(&target_relative))
                        .unwrap_or_else(|| self.target.join(&target_relative));
                    let mut already_checked_equal_hash = false;

                    if Self::compare_modified_time_at_second_precision(
                        target_meta.modified,
                        source_meta.modified,
                    ) == Ordering::Greater
                    {
                        // If target is newer but binary-identical, treat as no-op instead of conflict.
                        if source_meta.size != target_meta.size {
                            target_newer_conflicts.push(TargetNewerConflictCandidate {
                                path: path.clone(),
                                source_path: source_path.clone(),
                                target_path: target_path.clone(),
                                target_relative_path: mapped_target_path.clone(),
                                source: Self::snapshot_from_metadata(source_meta),
                                target: Self::snapshot_from_metadata(target_meta),
                            });
                            let now = std::time::Instant::now();
                            if now.duration_since(last_compare_emit_at) >= compare_emit_interval
                                || compare_processed_files == total_files as u64
                            {
                                last_compare_emit_at = now;
                                emit_progress(SyncEngine::build_dry_run_progress(
                                    DryRunPhase::Comparing,
                                    path.to_string_lossy().to_string(),
                                    compare_processed_files,
                                    total_files as u64,
                                    compare_processed_bytes,
                                    total_bytes,
                                    compare_summary.clone(),
                                ));
                            }
                            continue;
                        }

                        let source_hash = self.calculate_checksum(&source_path).await?;
                        let target_hash = self.calculate_checksum(&target_path).await?;
                        if source_hash != target_hash {
                            target_newer_conflicts.push(TargetNewerConflictCandidate {
                                path: path.clone(),
                                source_path: source_path.clone(),
                                target_path: target_path.clone(),
                                target_relative_path: mapped_target_path.clone(),
                                source: Self::snapshot_from_metadata(source_meta),
                                target: Self::snapshot_from_metadata(target_meta),
                            });
                            let now = std::time::Instant::now();
                            if now.duration_since(last_compare_emit_at) >= compare_emit_interval
                                || compare_processed_files == total_files as u64
                            {
                                last_compare_emit_at = now;
                                emit_progress(SyncEngine::build_dry_run_progress(
                                    DryRunPhase::Comparing,
                                    path.to_string_lossy().to_string(),
                                    compare_processed_files,
                                    total_files as u64,
                                    compare_processed_bytes,
                                    total_bytes,
                                    compare_summary.clone(),
                                ));
                            }
                            continue;
                        }

                        already_checked_equal_hash = true;
                    }

                    // 1. Fast path for different sizes
                    let mut needs_copy = source_meta.size != target_meta.size;

                    // 2. Same-size mtime drift can still be a no-op, so verify content.
                    if !needs_copy
                        && Self::compare_modified_time_at_second_precision(
                            source_meta.modified,
                            target_meta.modified,
                        ) == Ordering::Greater
                    {
                        let source_hash = self.calculate_checksum(&source_path).await?;
                        let target_hash = self.calculate_checksum(&target_path).await?;
                        already_checked_equal_hash = true;
                        needs_copy = source_hash != target_hash;
                    }

                    // 3. If metadata matches but checksum mode is on, check content (slower but accurate)
                    if !needs_copy && options.checksum_mode && !already_checked_equal_hash {
                        let source_hash = self.calculate_checksum(&source_path).await?;
                        let target_hash = self.calculate_checksum(&target_path).await?;

                        if source_hash != target_hash {
                            needs_copy = true;
                        }
                    }

                    if !needs_copy {
                        if let Some(history) = options.copy_history.as_deref() {
                            if Self::should_record_in_sync(history, &path, source_meta.size) {
                                copy_history_in_sync.push(CopyHistoryCandidate {
                                    source_path: source_path.clone(),
                                    target_path: target_path.clone(),
                                    target_modified: Some(target_meta.modified),
                                    relative_path: path.clone(),
                                    size: source_meta.size,
                                    modified: source_meta.modified,
                                    // 여기까지 왔으면 해시를 비교했을 때 같았다.
                                    content_verified: already_checked_equal_hash
                                        || options.checksum_mode,
                                });
                            }
                        }
                    }

                    if needs_copy {
                        bytes_to_copy += source_meta.size;
                        compare_summary.files_to_copy += 1;
                        compare_summary.files_modified += 1;
                        compare_summary.bytes_to_copy = bytes_to_copy;
                        let diff = FileDiff {
                            path: path.clone(),
                            kind: FileDiffKind::Modified,
                            source_size: Some(source_meta.size),
                            target_size: Some(target_meta.size),
                            checksum_source: None,
                            checksum_target: None,
                            target_path: mapped_target_path.clone(),
                            source_root: source_root.clone(),
                        };
                        on_diff(
                            diff.clone(),
                            SyncEngine::build_dry_run_progress(
                                DryRunPhase::Comparing,
                                path.to_string_lossy().to_string(),
                                compare_processed_files,
                                total_files as u64,
                                compare_processed_bytes,
                                total_bytes,
                                compare_summary.clone(),
                            ),
                        );
                        diffs.push(diff);
                    }
                }
            } else if let Some((captured, skipped_target_path)) = if source_meta.is_file {
                let planned_target_path = target_canonical
                    .as_ref()
                    .map(|target| target.join(&target_relative))
                    .unwrap_or_else(|| self.target.join(&target_relative));
                Self::is_previously_copied(
                    options.copy_history.as_deref(),
                    &source_canonical.join(&path),
                    &planned_target_path,
                    source_meta,
                )
                .await?
                .map(|captured| (captured, planned_target_path))
            } else {
                None
            } {
                compare_processed_files += 1;
                compare_processed_bytes += source_meta.size;
                skipped_previously_copied += 1;
                if previously_copied_paths.len() < MAX_PREVIOUSLY_COPIED_PATHS {
                    // 추가 소스의 파일은 일반 결과처럼 그 소스 루트를 붙여, 어느 카드의 파일인지 보이게 한다.
                    previously_copied_paths.push(match &source_root {
                        Some(root) => root.join(&path),
                        None => path.clone(),
                    });
                }
                previously_copied_sources.push(SkippedSourceSnapshot {
                    source_path: source_canonical.join(&path),
                    target_path: skipped_target_path,
                    size: source_meta.size,
                    modified: source_meta.modified,
                    captured,
                });
                // 건너뛰는 파일도 촬영 시각을 읽으므로, 연달아 건너뛸 때 진행이 멈춘 것처럼 보이지 않게 한다.
                let now = std::time::Instant::now();
                if now.duration_since(last_compare_emit_at) >= compare_emit_interval
                    || compare_processed_files == total_files as u64
                {
                    last_compare_emit_at = now;
                    emit_progress(SyncEngine::build_dry_run_progress(
                        DryRunPhase::Comparing,
                        path.to_string_lossy().to_string(),
                        compare_processed_files,
                        total_files as u64,
                        compare_processed_bytes,
                        total_bytes,
                        compare_summary.clone(),
                    ));
                }
            } else if source_meta.is_file {
                compare_processed_files += 1;
                compare_processed_bytes += source_meta.size;
                bytes_to_copy += source_meta.size;
                compare_summary.files_to_copy += 1;
                compare_summary.bytes_to_copy = bytes_to_copy;
                let diff = FileDiff {
                    path: path.clone(),
                    kind: FileDiffKind::New,
                    source_size: Some(source_meta.size),
                    target_size: None,
                    checksum_source: None,
                    checksum_target: None,
                    target_path: mapped_target_path.clone(),
                    source_root: source_root.clone(),
                };
                on_diff(
                    diff.clone(),
                    SyncEngine::build_dry_run_progress(
                        DryRunPhase::Comparing,
                        path.to_string_lossy().to_string(),
                        compare_processed_files,
                        total_files as u64,
                        compare_processed_bytes,
                        total_bytes,
                        compare_summary.clone(),
                    ),
                );
                diffs.push(diff);
            }

            let now = std::time::Instant::now();
            if now.duration_since(last_compare_emit_at) >= compare_emit_interval
                || compare_processed_files == total_files as u64
            {
                last_compare_emit_at = now;
                emit_progress(SyncEngine::build_dry_run_progress(
                    DryRunPhase::Comparing,
                    path.to_string_lossy().to_string(),
                    compare_processed_files,
                    total_files as u64,
                    compare_processed_bytes,
                    total_bytes,
                    compare_summary.clone(),
                ));
            }
        }

        compare_summary.total_files = total_files;
        compare_summary.bytes_to_copy = bytes_to_copy;
        compare_summary.files_to_copy = diffs.len();
        compare_summary.files_modified = diffs
            .iter()
            .filter(|d| d.kind == FileDiffKind::Modified)
            .count();
        emit_progress(SyncEngine::build_dry_run_progress(
            DryRunPhase::Comparing,
            "Comparison complete".to_string(),
            compare_processed_files,
            total_files as u64,
            compare_processed_bytes,
            total_bytes,
            compare_summary.clone(),
        ));

        // 마지막 파일의 기록 조회 중 들어온 취소도 반영해, 취소된 비교를 계획으로 남기지 않는다.
        if cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
            anyhow::bail!("Dry run cancelled by user");
        }

        Ok((
            DryRunResult {
                diffs,
                total_files,
                files_to_copy: compare_summary.files_to_copy,
                files_modified: compare_summary.files_modified,
                bytes_to_copy,
                target_preflight: None,
                skipped_previously_copied,
                previously_copied_paths,
                copy_history_in_sync,
                previously_copied_sources,
            },
            target_newer_conflicts,
        ))
    }

    fn dry_run_progress_to_sync_progress(progress: DryRunProgress) -> SyncProgress {
        let phase = match progress.phase {
            DryRunPhase::ScanningSource => SyncProgressPhase::ScanningSource,
            DryRunPhase::ScanningTarget => SyncProgressPhase::ScanningTarget,
            DryRunPhase::Comparing => SyncProgressPhase::Comparing,
        };

        SyncProgress {
            phase,
            current_file: Some(progress.message),
            total_files: progress.total,
            processed_files: progress.current,
            total_bytes: progress.total_bytes,
            processed_bytes: progress.processed_bytes,
            bytes_copied_current_file: 0,
            current_file_total_bytes: 0,
        }
    }

    pub async fn compare_dirs(&self, options: &SyncOptions) -> Result<DryRunResult> {
        let (dry_run, _) = self
            .compare_dirs_internal(options, None, |_| {}, |_, _| {})
            .await?;
        Ok(dry_run)
    }

    pub async fn target_newer_conflicts(
        &self,
        options: &SyncOptions,
    ) -> Result<Vec<TargetNewerConflictCandidate>> {
        let (_, conflicts) = self
            .compare_dirs_internal(options, None, |_| {}, |_, _| {})
            .await?;
        Ok(conflicts)
    }

    pub async fn dry_run(&self, options: &SyncOptions) -> Result<DryRunResult> {
        self.compare_dirs(options).await
    }

    pub async fn dry_run_with_cancel(
        &self,
        options: &SyncOptions,
        cancel_token: CancellationToken,
    ) -> Result<DryRunResult> {
        let (dry_run, _) = self
            .compare_dirs_internal(options, Some(cancel_token), |_| {}, |_, _| {})
            .await?;
        Ok(dry_run)
    }

    pub async fn dry_run_with_progress<P, D>(
        &self,
        options: &SyncOptions,
        cancel_token: CancellationToken,
        on_progress: P,
        on_diff: D,
    ) -> Result<DryRunResult>
    where
        P: FnMut(DryRunProgress) + Send + 'static,
        D: FnMut(FileDiff, DryRunProgress),
    {
        let (dry_run, _) = self
            .compare_dirs_internal(options, Some(cancel_token), on_progress, on_diff)
            .await?;
        Ok(dry_run)
    }

    pub async fn dry_run_with_progress_and_conflicts<P, D>(
        &self,
        options: &SyncOptions,
        cancel_token: CancellationToken,
        on_progress: P,
        on_diff: D,
    ) -> Result<(DryRunResult, Vec<TargetNewerConflictCandidate>)>
    where
        P: FnMut(DryRunProgress) + Send + 'static,
        D: FnMut(FileDiff, DryRunProgress),
    {
        self.compare_dirs_internal(options, Some(cancel_token), on_progress, on_diff)
            .await
    }

    pub async fn prepare_sync_plan_with_progress<P, D>(
        &self,
        options: &SyncOptions,
        mut on_progress: P,
        on_diff: D,
    ) -> Result<(DryRunResult, Vec<TargetNewerConflictCandidate>)>
    where
        P: FnMut(SyncProgress) + Send + 'static,
        D: FnMut(FileDiff, DryRunProgress),
    {
        self.compare_dirs_internal(
            options,
            None,
            move |progress| on_progress(Self::dry_run_progress_to_sync_progress(progress)),
            on_diff,
        )
        .await
    }

    pub async fn prepare_sync_plan_with_progress_and_cancel<P, D>(
        &self,
        options: &SyncOptions,
        cancel_token: CancellationToken,
        mut on_progress: P,
        on_diff: D,
    ) -> Result<(DryRunResult, Vec<TargetNewerConflictCandidate>)>
    where
        P: FnMut(SyncProgress) + Send + 'static,
        D: FnMut(FileDiff, DryRunProgress),
    {
        self.compare_dirs_internal(
            options,
            Some(cancel_token),
            move |progress| on_progress(Self::dry_run_progress_to_sync_progress(progress)),
            on_diff,
        )
        .await
    }

    pub async fn sync_files_from_dry_run(
        &self,
        dry_run: &DryRunResult,
        options: &SyncOptions,
        progress_callback: impl Fn(SyncProgress),
        file_callback: impl Fn(SyncFileEntry),
    ) -> Result<SyncResult> {
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

        let mut current_progress = SyncProgress {
            phase: SyncProgressPhase::Copying,
            current_file: None,
            total_files: total_files_to_copy,
            processed_files: 0,
            total_bytes,
            processed_bytes: 0,
            bytes_copied_current_file: 0,
            current_file_total_bytes: 0,
        };

        progress_callback(current_progress.clone());

        // 건너뛴 소스 파일이 비교 뒤 바뀌었으면(같은 이름의 다른 사진 등) 건너뛸 근거가 없다.
        Self::ensure_skipped_sources_unchanged(dry_run).await?;
        // 기록으로 건너뛴 파일이 있는 계획은, 그 판단에 쓴 타깃 폴더에 복사할 때만 실행한다.
        // 비교 뒤 같은 경로에 다른 폴더(디스크)가 연결됐으면 건너뛴 파일이 새 타깃에 없다.
        // 위 검사(헤더 읽기)가 걸린 동안의 교체도 잡도록, 첫 쓰기 직전인 여기서 확인한다.
        Self::ensure_skip_target_unchanged(dry_run, options)?;
        // 실행 시작 때 타깃 폴더가 없었으면(방금 만들어졌으면) 첫 파일을 쓰기 전에 폴더를 확정한다.
        if let Some(history) = options.copy_history.as_deref() {
            history.pin_target_identity();
        }

        // 캐시된 계획의 추가 소스 루트는 이 엔진에 지정된 추가 소스여야 한다.
        let mut allowed_extra_roots = HashSet::new();
        for extra in &self.extra_sources {
            if let Ok(root) = tokio::fs::canonicalize(&extra.path).await {
                allowed_extra_roots.insert(root);
            }
        }

        for diff in &dry_run.diffs {
            let source_path = match diff.source_root.as_ref() {
                None => self.source.join(&diff.path),
                Some(root) if allowed_extra_roots.contains(root) => root.join(&diff.path),
                Some(root) => {
                    let message = format!(
                        "Source root '{}' is not a source of this task",
                        root.display()
                    );
                    result.errors.push(crate::sync_engine::types::SyncError {
                        path: diff.path.clone(),
                        message: message.clone(),
                        kind: crate::sync_engine::types::SyncErrorKind::Other,
                    });
                    file_callback(SyncFileEntry {
                        path: diff.path.clone(),
                        kind: diff.kind.clone(),
                        status: SyncFileStatus::Failed,
                        source_size: diff.source_size,
                        target_size: diff.target_size,
                        error: Some(message),
                        target_path: diff.target_path.clone(),
                        source_root: Some(root.clone()),
                    });
                    current_progress.processed_files += 1;
                    progress_callback(current_progress.clone());
                    continue;
                }
            };
            let target_path = self.target.join(diff.target_relative_path());

            match diff.kind {
                FileDiffKind::New | FileDiffKind::Modified => {
                    current_progress.current_file = Some(diff.path.to_string_lossy().to_string());
                    current_progress.bytes_copied_current_file = 0;
                    let file_size = diff.source_size.unwrap_or(0);
                    current_progress.current_file_total_bytes = file_size;
                    progress_callback(current_progress.clone());
                    let mut last_emitted_current_file_bytes = 0u64;
                    // 복사 중에 소스가 바뀌면 기록하지 않도록 복사 전 상태를 남긴다.
                    let source_before_copy = match options.copy_history.as_ref() {
                        Some(_) if copy_history::is_eligible(&diff.path) => {
                            fs::metadata(&source_path).await.ok().and_then(|meta| {
                                Some((meta.len(), meta.modified().ok()?))
                            })
                        }
                        _ => None,
                    };

                    if let Err(e) = self
                        .copy_file_chunked(&source_path, &target_path, options, |written_chunk| {
                            current_progress.processed_bytes += written_chunk;
                            current_progress.bytes_copied_current_file += written_chunk;
                            const PROGRESS_EMIT_CHUNK_BYTES: u64 = 1024 * 1024;
                            let should_emit = current_progress
                                .bytes_copied_current_file
                                .saturating_sub(last_emitted_current_file_bytes)
                                >= PROGRESS_EMIT_CHUNK_BYTES;
                            if should_emit {
                                last_emitted_current_file_bytes =
                                    current_progress.bytes_copied_current_file;
                                progress_callback(current_progress.clone());
                            }
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
                        let entry = SyncFileEntry {
                            path: diff.path.clone(),
                            kind: diff.kind.clone(),
                            status: SyncFileStatus::Failed,
                            source_size: diff.source_size,
                            target_size: diff.target_size,
                            error: Some(e.to_string()),
                            target_path: diff.target_path.clone(),
                            source_root: diff.source_root.clone(),
                        };
                        file_callback(entry);
                    } else {
                        if let (Some(history), Some((size, modified))) =
                            (options.copy_history.as_ref(), source_before_copy)
                        {
                            // 복사 직후 바로 기록해, 중간에 취소돼도 복사한 파일은 남긴다.
                            // 계획과 크기가 다르면 계획 뒤에 바뀐 파일이므로 기록하지 않는다.
                            if size == file_size {
                                let candidate = CopyHistoryCandidate {
                                    source_path: source_path.clone(),
                                    target_path: target_path.clone(),
                                    target_modified: None,
                                    relative_path: diff.path.clone(),
                                    size,
                                    modified,
                                    content_verified: false,
                                };
                                Self::record_copy_history(history, vec![candidate]).await;
                            }
                        }
                        result.files_copied += 1;
                        result.bytes_copied += file_size;
                        current_progress.bytes_copied_current_file = file_size;
                        let entry = SyncFileEntry {
                            path: diff.path.clone(),
                            kind: diff.kind.clone(),
                            status: SyncFileStatus::Copied,
                            source_size: diff.source_size,
                            target_size: diff.target_size.or(Some(0)),
                            error: None,
                            target_path: diff.target_path.clone(),
                            source_root: diff.source_root.clone(),
                        };
                        file_callback(entry);
                    }

                    current_progress.processed_files += 1;
                    progress_callback(current_progress.clone());
                }
            }
        }

        Self::ensure_skip_target_unchanged(dry_run, options)?;
        if let Some(history) = options.copy_history.as_ref() {
            // 촬영 시각이 없는 파일은 내용 전체를 읽어 비교하므로 오래 걸릴 수 있다. 멈춘 것처럼
            // 보이지 않도록 한 파일씩 기록하며 진행 상황을 알린다.
            let total = dry_run.copy_history_in_sync.len();
            let mut last_emit: Option<std::time::Instant> = None;
            for (index, candidate) in dry_run.copy_history_in_sync.iter().enumerate() {
                if last_emit.is_none_or(|at| at.elapsed() >= std::time::Duration::from_millis(250)) {
                    last_emit = Some(std::time::Instant::now());
                    current_progress.phase = SyncProgressPhase::RecordingCopyHistory;
                    current_progress.current_file = Some(format!(
                        "Recording copy history... ({}/{total})",
                        index + 1
                    ));
                    progress_callback(current_progress.clone());
                }
                Self::record_copy_history(history, vec![candidate.clone()]).await;
            }
        }
        // 복사·기록이 걸린 동안 건너뛴 소스가 바뀌었거나 타깃이 바뀌었을 수도 있다. 건너뛴 파일이
        // 빠진 채 성공을 보고하지 않도록 반환 직전에 한 번 더 확인한다.
        Self::ensure_skipped_sources_unchanged(dry_run).await?;
        Self::ensure_skip_target_unchanged(dry_run, options)?;

        Ok(result)
    }

    pub async fn sync_files(
        &self,
        options: &SyncOptions,
        progress_callback: impl Fn(crate::sync_engine::types::SyncProgress),
        file_callback: impl Fn(SyncFileEntry),
    ) -> Result<SyncResult> {
        let (dry_run, _) = self
            .compare_dirs_internal(options, None, |_| {}, |_, _| {})
            .await?;
        self.sync_files_from_dry_run(&dry_run, options, progress_callback, file_callback)
            .await
    }

    pub async fn find_orphan_files(&self, exclude_patterns: &[String]) -> Result<Vec<OrphanFile>> {
        self.find_orphan_files_with_cancel(exclude_patterns, None, None)
            .await
    }

    /// 저장 규칙을 적용해 소스 파일들의 타깃 상대 경로를 계산한다.
    /// 메타데이터 읽기는 블로킹 I/O이므로 별도 스레드에서 수행한다.
    async fn build_target_mapping(
        source_canonical: &Path,
        source_files: &[FileMetadata],
        save_rule: &SaveRuleTemplateRecord,
        cancel_token: Option<CancellationToken>,
    ) -> Result<HashMap<PathBuf, PathBuf>> {
        let mapper = SaveRuleMapper::new(save_rule)
            .map_err(|error| anyhow::anyhow!("Invalid save rule template: {error}"))?;
        let mut entries: Vec<(PathBuf, SystemTime)> = source_files
            .iter()
            .filter(|file| file.is_file)
            .map(|file| (file.path.clone(), file.modified))
            .collect();
        entries.sort();
        let source_root = source_canonical.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut resolver = CollisionResolver::default();
            let mut mapping = HashMap::with_capacity(entries.len());
            for (index, (relative, modified)) in entries.iter().enumerate() {
                if index % 64 == 0 && cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
                    anyhow::bail!("Operation cancelled while applying save rules");
                }
                let mapped = mapper.map(&source_root.join(relative), relative, Some(*modified));
                let resolved = resolver.resolve(relative, mapped.target_relative);
                mapping.insert(relative.clone(), resolved);
            }
            Ok(mapping)
        })
        .await
        .context("Save rule mapping task failed")?
    }

    pub async fn find_orphan_files_with_cancel(
        &self,
        exclude_patterns: &[String],
        cancel_token: Option<CancellationToken>,
        save_rule: Option<&SaveRuleTemplateRecord>,
    ) -> Result<Vec<OrphanFile>> {
        // 모든 소스가 있어야 한다. 빠진 소스의 파일은 전부 고아로 보이기 때문이다 (ADR-0039).
        for (_, source) in self.all_source_paths() {
            Self::canonical_source_dir(source).await?;
        }

        let target_canonical = match tokio::fs::metadata(&self.target).await {
            Ok(target_meta) => {
                if !target_meta.is_dir() {
                    anyhow::bail!(
                        "Target path exists but is not a directory: {:?}",
                        self.target
                    );
                }
                tokio::fs::canonicalize(&self.target)
                    .await
                    .with_context(|| format!("Failed to canonicalize target: {:?}", self.target))?
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("Failed to access target: {:?}", self.target))
            }
        };

        let target_files = self
            .read_directory(
                &target_canonical,
                DryRunPhase::ScanningTarget,
                exclude_patterns,
                cancel_token.clone(),
                Arc::new(StdMutex::new(|_: DryRunProgress| {})),
            )
            .await
            .context("Failed to read target directory")?;

        let sources = self
            .scan_sources(
                exclude_patterns,
                cancel_token.clone(),
                Arc::new(StdMutex::new(|_: DryRunProgress| {})),
            )
            .await?;
        let planned = self
            .plan_target_paths(&sources, save_rule, cancel_token, &|_| {})
            .await?;

        // 저장 규칙이 있으면 "소스에 존재하는 경로"는 매핑된 타깃 경로와 그 상위 폴더들이다.
        let mapped_paths: Option<HashSet<PathBuf>> = if save_rule.is_some() {
            let mut expected = HashSet::new();
            for target_relative in planned.iter().map(|file| file.target_relative.clone()) {
                let mut ancestor = target_relative.parent().map(Path::to_path_buf);
                while let Some(dir) = ancestor {
                    if dir.as_os_str().is_empty() {
                        break;
                    }
                    ancestor = dir.parent().map(Path::to_path_buf);
                    expected.insert(dir);
                }
                expected.insert(target_relative);
            }
            Some(expected)
        } else {
            None
        };

        // 미러링이면 모든 소스의 경로(폴더 포함)와, 소스 간 충돌로 접미사가 붙은 타깃 경로가 기대 경로다.
        let mut source_paths: HashSet<&PathBuf> = sources
            .iter()
            .flat_map(|source| source.files.iter().map(|f| &f.path))
            .collect();
        source_paths.extend(planned.iter().map(|file| &file.target_relative));
        let is_expected = |path: &PathBuf| match &mapped_paths {
            Some(mapped) => mapped.contains(path),
            None => source_paths.contains(path),
        };
        let mut orphans: Vec<OrphanFile> = target_files
            .iter()
            .filter(|meta| !is_expected(&meta.path))
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

            for entry in WalkDir::new(&path)
                .into_iter()
                .filter_map(|entry| entry.ok())
            {
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

    pub async fn delete_orphan_paths(
        &self,
        relative_paths: &[PathBuf],
    ) -> Result<DeleteOrphanResult> {
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
            if relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
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

        reject_symlink_destination_under_root(&self.target, target).await?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }

        reject_symlink_destination_under_root(&self.target, target).await?;

        let mut source_file = fs::File::open(source).await?;
        let mut target_options = fs::OpenOptions::new();
        target_options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        target_options.custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits());
        let mut target_file = target_options.open(target).await?;
        let mut buffer = [0u8; 64 * 1024]; // 64KB chunks

        loop {
            let n = source_file.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            target_file.write_all(&buffer[..n]).await?;
            on_progress(n as u64);
        }
        // 마지막 쓰기가 끝난 뒤에 반환한다. 이후의 수정 시각 설정·검증·복사 기록이
        // 완성된 파일을 보게 한다.
        target_file.flush().await?;
        drop(target_file);

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
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex as StdMutex};
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

        let result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(result.files_copied, 1);

        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn copy_file_chunked_rejects_target_symlink() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        let outside_dir = TempDir::new()?;

        let source = source_dir.path().join("test.txt");
        let target = target_dir.path().join("test.txt");
        let outside = outside_dir.path().join("outside.txt");
        fs::write(&source, b"safe content").await?;
        fs::write(&outside, b"original outside").await?;
        std::os::unix::fs::symlink(&outside, &target)?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let result = engine
            .copy_file_chunked(&source, &target, &SyncOptions::default(), |_| {})
            .await;

        let err = result.expect_err("target symlink should be rejected");
        assert!(format!("{:#}", err).contains("Refusing to write through symlink"));
        assert_eq!(fs::read(&outside).await?, b"original outside");

        Ok(())
    }

    #[tokio::test]
    async fn test_prepare_sync_plan_with_progress_reports_scan_phases() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        fs::write(source_dir.path().join("a.txt"), b"hello").await?;
        fs::write(target_dir.path().join("a.txt"), b"older").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();
        let phases = Arc::new(StdMutex::new(Vec::new()));
        let phases_for_progress = phases.clone();

        let _ = engine
            .prepare_sync_plan_with_progress(
                &options,
                move |progress| {
                    phases_for_progress
                        .lock()
                        .expect("phase collection lock should succeed")
                        .push(progress.phase);
                },
                |_, _| {},
            )
            .await?;

        let recorded = phases
            .lock()
            .expect("phase collection lock should succeed")
            .clone();

        assert!(recorded.contains(&SyncProgressPhase::ScanningSource));
        assert!(recorded.contains(&SyncProgressPhase::ScanningTarget));
        assert!(recorded.contains(&SyncProgressPhase::Comparing));

        Ok(())
    }

    #[tokio::test]
    async fn test_prepare_sync_plan_with_progress_and_cancel_stops_mid_scan() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        for index in 0..64 {
            fs::write(
                source_dir.path().join(format!("file-{index}.txt")),
                b"payload",
            )
            .await?;
        }

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();
        let cancel_token = CancellationToken::new();
        let cancel_for_progress = cancel_token.clone();

        let result = engine
            .prepare_sync_plan_with_progress_and_cancel(
                &options,
                cancel_token,
                move |progress| {
                    if progress.phase == SyncProgressPhase::ScanningSource
                        && progress.processed_files > 0
                    {
                        cancel_for_progress.cancel();
                    }
                },
                |_, _| {},
            )
            .await;

        let error = result.expect_err("planning should cancel while scanning");
        assert!(format!("{:#}", error).contains("cancelled by user"));

        Ok(())
    }

    #[tokio::test]
    async fn test_dry_run_fails_when_source_scan_hits_walkdir_error() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        let restricted_dir = source_dir.path().join("restricted");
        let visible_file = source_dir.path().join("visible.txt");

        fs::create_dir(&restricted_dir).await?;
        fs::write(&visible_file, b"visible").await?;
        std::fs::set_permissions(&restricted_dir, std::fs::Permissions::from_mode(0o000))?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let result = engine.dry_run(&SyncOptions::default()).await;

        std::fs::set_permissions(&restricted_dir, std::fs::Permissions::from_mode(0o755))?;

        let err = result.expect_err("dry run should fail on traversal errors");
        let message = format!("{:#}", err);
        assert!(message.contains("Failed to read source directory"));
        assert!(message.contains("Failed to traverse directory entry"));

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
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(target_time),
        )?;

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

        let sync_result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(sync_result.files_copied, 0);

        let target_content = fs::read(&target_file).await?;
        assert_eq!(target_content, b"target-v2");
        Ok(())
    }

    #[tokio::test]
    async fn test_target_newer_same_content_is_not_conflict() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/photo.jpg");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"same-content").await?;
        fs::write(&target_file, b"same-content").await?;

        let source_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let target_time = source_time + std::time::Duration::from_secs(60);
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(target_time),
        )?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 0);

        let conflicts = engine.target_newer_conflicts(&options).await?;
        assert_eq!(conflicts.len(), 0);

        let sync_result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(sync_result.files_copied, 0);
        Ok(())
    }

    #[tokio::test]
    async fn test_source_newer_same_content_is_not_modified_without_checksum_mode() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/photo.jpg");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"same-content").await?;
        fs::write(&target_file, b"same-content").await?;

        let target_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let source_time = target_time + std::time::Duration::from_secs(60);
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(target_time),
        )?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions {
            checksum_mode: false,
            ..SyncOptions::default()
        };

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 0);
        assert!(dry_run.diffs.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn test_source_newer_different_content_same_size_is_modified_without_checksum_mode(
    ) -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/photo.jpg");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"source-v2").await?;
        fs::write(&target_file, b"target-v1").await?;

        let target_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let source_time = target_time + std::time::Duration::from_secs(60);
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(target_time),
        )?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions {
            checksum_mode: false,
            ..SyncOptions::default()
        };

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);
        assert_eq!(dry_run.files_modified, 1);
        assert_eq!(dry_run.diffs[0].kind, FileDiffKind::Modified);

        Ok(())
    }

    #[tokio::test]
    async fn test_subsecond_modified_time_drift_is_ignored_without_checksum_mode() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/clip.mp4");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"same-content").await?;
        fs::write(&target_file, b"same-content").await?;

        let base_secs = 1_700_000_000i64;
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_unix_time(base_secs, 900_000_000),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_unix_time(base_secs, 100_000_000),
        )?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions {
            checksum_mode: false,
            ..SyncOptions::default()
        };

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 0);
        assert!(dry_run.diffs.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn test_target_newer_different_size_is_conflict() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let relative = PathBuf::from("media/photo.jpg");
        let source_file = source_dir.path().join(&relative);
        let target_file = target_dir.path().join(&relative);
        fs::create_dir_all(source_file.parent().unwrap()).await?;
        fs::create_dir_all(target_file.parent().unwrap()).await?;

        fs::write(&source_file, b"source-v1").await?;
        fs::write(&target_file, b"target-v2-with-larger-content").await?;

        let source_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let target_time = source_time + std::time::Duration::from_secs(60);
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(target_time),
        )?;

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
        options.exclude_patterns = vec!["ignore_me.txt".to_string(), "node_modules/**".to_string()];

        let dry_run = engine.dry_run(&options).await?;
        // Should only copy file1.txt and file2.txt
        assert_eq!(dry_run.files_to_copy, 2);

        let result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(result.files_copied, 2);

        assert!(target_dir.path().join("file1.txt").exists());
        assert!(target_dir.path().join("file2.txt").exists());
        assert!(!target_dir.path().join("ignore_me.txt").exists());
        assert!(!target_dir.path().join("node_modules").exists());

        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_appledouble_pattern_skips_nested_sidecars() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        let nested = source_dir.path().join("DCIM/100_FUJI");
        fs::create_dir_all(&nested).await?;
        fs::write(nested.join("DSCF0697.HIF"), b"image").await?;
        fs::write(nested.join("._DSCF0697.HIF"), b"appledouble").await?;
        fs::write(nested.join("clip._v2.mp4"), b"video").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );

        let mut options = SyncOptions::default();
        options.exclude_patterns = vec!["._*".to_string()];

        let result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(result.files_copied, 2);

        let target_nested = target_dir.path().join("DCIM/100_FUJI");
        assert!(target_nested.join("DSCF0697.HIF").exists());
        assert!(target_nested.join("clip._v2.mp4").exists());
        assert!(!target_nested.join("._DSCF0697.HIF").exists());

        Ok(())
    }

    #[tokio::test]
    async fn test_root_metadata_dirs_are_always_excluded() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        for dir_name in HARD_IGNORED_ROOT_METADATA_DIRS {
            let metadata_dir = source_dir.path().join(dir_name);
            fs::create_dir_all(&metadata_dir).await?;
            fs::write(metadata_dir.join("metadata.bin"), b"meta").await?;
        }

        let nested_allowed = source_dir.path().join("photos/.Trashes/keep.txt");
        fs::create_dir_all(
            nested_allowed
                .parent()
                .expect("nested path should have parent"),
        )
        .await?;
        fs::write(&nested_allowed, b"nested").await?;
        fs::write(source_dir.path().join("keep.txt"), b"keep").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );

        let mut options = SyncOptions::default();
        options.exclude_patterns = vec![];

        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 2);

        let result = engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(result.files_copied, 2);

        for dir_name in HARD_IGNORED_ROOT_METADATA_DIRS {
            assert!(!target_dir.path().join(dir_name).exists());
        }
        assert!(target_dir.path().join("keep.txt").exists());
        assert!(target_dir.path().join("photos/.Trashes/keep.txt").exists());

        Ok(())
    }

    #[tokio::test]
    async fn test_exclusion_empty_patterns() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        let file1 = source_dir.path().join("file1.txt");
        fs::write(&file1, b"content").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let mut options = SyncOptions::default();
        options.exclude_patterns = vec!["file with spaces.txt".to_string(), "special*".to_string()];

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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );

        // Test count boundary (300개 패턴 -> MAX_PATTERN_COUNT=300 허용)
        let mut options = SyncOptions::default();
        options.exclude_patterns = (0..300).map(|i| format!("pattern_{}", i)).collect();
        let ok_result = engine.dry_run(&options).await;
        assert!(ok_result.is_ok(), "Expected 300 patterns to be allowed");

        // Test count limit (301개 패턴 -> MAX_PATTERN_COUNT=300 초과)
        let mut options = SyncOptions::default();
        options.exclude_patterns = (0..301).map(|i| format!("pattern_{}", i)).collect();
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
                    "Error chain should contain 'Too many', got: {}",
                    full_err
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
                    "Error chain should contain 'too long', got: {}",
                    full_err
                );
            }
        }

        Ok(())
    }

    #[tokio::test]
    async fn test_dry_run_with_cancel_respects_token() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        // Ensure traversal starts with at least one real file.
        fs::write(source_dir.path().join("test.txt"), b"test").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = SyncOptions::default();
        let cancel_token = CancellationToken::new();
        cancel_token.cancel();

        let result = engine.dry_run_with_cancel(&options, cancel_token).await;
        assert!(result.is_err());
        assert!(format!("{:#}", result.unwrap_err()).contains("cancelled by user"));

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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
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
    async fn test_find_orphan_files_ignores_root_metadata_dirs() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;

        fs::write(source_dir.path().join("shared.txt"), b"same").await?;
        fs::write(target_dir.path().join("shared.txt"), b"same").await?;
        fs::write(target_dir.path().join("orphan.txt"), b"orphan").await?;

        for dir_name in HARD_IGNORED_ROOT_METADATA_DIRS {
            let metadata_dir = target_dir.path().join(dir_name);
            fs::create_dir_all(&metadata_dir).await?;
            fs::write(metadata_dir.join("stale.bin"), b"stale").await?;
        }

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let orphans = engine.find_orphan_files(&[]).await?;

        assert!(orphans
            .iter()
            .any(|orphan| orphan.path == PathBuf::from("orphan.txt")));
        for dir_name in HARD_IGNORED_ROOT_METADATA_DIRS {
            let dir_path = PathBuf::from(dir_name);
            assert!(
                !orphans
                    .iter()
                    .any(|orphan| orphan.path.starts_with(&dir_path)),
                "orphan list should not include hard-ignored metadata dir: {dir_name}"
            );
        }

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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
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

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let result = engine
            .delete_orphan_paths(&[PathBuf::from("stale")])
            .await?;

        assert_eq!(result.deleted_files_count, 2);
        assert_eq!(result.deleted_dirs_count, 3);
        assert_eq!(result.deleted_count, 5);
        assert_eq!(result.failures.len(), 0);
        assert!(!target_dir.path().join("stale").exists());

        Ok(())
    }

    fn by_type_template() -> crate::save_rules::SaveRuleTemplateRecord {
        crate::save_rules::built_in_templates()
            .into_iter()
            .find(|template| template.id == crate::save_rules::PRESET_CAMERA_BY_TYPE)
            .expect("preset")
    }

    fn options_with_rule(template: crate::save_rules::SaveRuleTemplateRecord) -> SyncOptions {
        SyncOptions {
            checksum_mode: false,
            preserve_permissions: false,
            preserve_times: true,
            verify_after_copy: false,
            exclude_patterns: Vec::new(),
            save_rule: Some(template),
            copy_history: None,
        }
    }

    #[tokio::test]
    async fn save_rule_maps_new_files_into_category_folders() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        fs::create_dir_all(source_dir.path().join("DCIM/100MSDCF")).await?;
        fs::create_dir_all(source_dir.path().join("PRIVATE/M4ROOT/CLIP")).await?;
        fs::create_dir_all(source_dir.path().join("PRIVATE/M4ROOT/SUB")).await?;
        fs::write(source_dir.path().join("DCIM/100MSDCF/DSC00001.ARW"), b"raw").await?;
        fs::write(source_dir.path().join("DCIM/100MSDCF/DSC00001.JPG"), b"jpg").await?;
        fs::write(
            source_dir.path().join("PRIVATE/M4ROOT/CLIP/C0001.MP4"),
            b"clip",
        )
        .await?;
        fs::write(
            source_dir.path().join("PRIVATE/M4ROOT/SUB/C0001S03.MP4"),
            b"px",
        )
        .await?;
        fs::write(
            source_dir.path().join("PRIVATE/M4ROOT/CLIP/C0001M01.XML"),
            b"<x/>",
        )
        .await?;
        fs::write(source_dir.path().join("notes.pdf"), b"pdf").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = options_with_rule(by_type_template());
        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 6);
        let mapped: HashMap<PathBuf, PathBuf> = dry_run
            .diffs
            .iter()
            .map(|diff| (diff.path.clone(), diff.target_relative_path().to_path_buf()))
            .collect();
        assert_eq!(
            mapped[&PathBuf::from("DCIM/100MSDCF/DSC00001.ARW")],
            PathBuf::from("RAW/DSC00001.ARW")
        );
        assert_eq!(
            mapped[&PathBuf::from("DCIM/100MSDCF/DSC00001.JPG")],
            PathBuf::from("Photo/DSC00001.JPG")
        );
        assert_eq!(
            mapped[&PathBuf::from("PRIVATE/M4ROOT/CLIP/C0001.MP4")],
            PathBuf::from("Video/C0001.MP4")
        );
        assert_eq!(
            mapped[&PathBuf::from("PRIVATE/M4ROOT/SUB/C0001S03.MP4")],
            PathBuf::from("Proxy/C0001S03.MP4")
        );
        assert_eq!(
            mapped[&PathBuf::from("PRIVATE/M4ROOT/CLIP/C0001M01.XML")],
            PathBuf::from("Metadata/C0001M01.XML")
        );
        assert_eq!(
            mapped[&PathBuf::from("notes.pdf")],
            PathBuf::from("Other/notes.pdf")
        );

        let result = engine
            .sync_files_from_dry_run(&dry_run, &options, |_| {}, |_| {})
            .await?;
        assert_eq!(result.files_copied, 6);
        assert!(target_dir.path().join("RAW/DSC00001.ARW").exists());
        assert!(target_dir.path().join("Video/C0001.MP4").exists());
        assert!(target_dir.path().join("Other/notes.pdf").exists());
        assert!(!target_dir.path().join("DCIM").exists());

        // 두 번째 실행: 모두 동일하므로 복사할 것이 없어야 한다 (매핑된 경로로 비교).
        let second = engine.dry_run(&options).await?;
        assert_eq!(second.files_to_copy, 0, "{:?}", second.diffs);

        // 타깃의 매핑된 파일이 바뀌면 Modified로 감지되고 target_path를 유지한다.
        fs::write(
            source_dir.path().join("DCIM/100MSDCF/DSC00001.JPG"),
            b"jpg-v2",
        )
        .await?;
        let third = engine.dry_run(&options).await?;
        assert_eq!(third.files_to_copy, 1);
        assert_eq!(third.diffs[0].kind, FileDiffKind::Modified);
        assert_eq!(
            third.diffs[0].target_path.as_deref(),
            Some(Path::new("Photo/DSC00001.JPG"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn save_rule_orphan_scan_uses_mapped_paths() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        fs::create_dir_all(source_dir.path().join("DCIM/100MSDCF")).await?;
        fs::write(source_dir.path().join("DCIM/100MSDCF/DSC00001.JPG"), b"jpg").await?;
        fs::create_dir_all(target_dir.path().join("Photo")).await?;
        fs::write(target_dir.path().join("Photo/DSC00001.JPG"), b"jpg").await?;
        fs::write(target_dir.path().join("Photo/DSC00009.JPG"), b"gone").await?;
        fs::create_dir_all(target_dir.path().join("Stale")).await?;
        fs::write(target_dir.path().join("Stale/old.txt"), b"old").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let template = by_type_template();
        let orphans = engine
            .find_orphan_files_with_cancel(&[], None, Some(&template))
            .await?;
        let paths: Vec<PathBuf> = orphans.iter().map(|o| o.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("Photo/DSC00009.JPG"),
                PathBuf::from("Stale"),
                PathBuf::from("Stale/old.txt"),
            ]
        );

        // 규칙 없이 보면 매핑된 파일이 모두 고아로 보인다 (기존 동작 유지).
        let without_rule = engine.find_orphan_files(&[]).await?;
        assert!(without_rule
            .iter()
            .any(|o| o.path == PathBuf::from("Photo/DSC00001.JPG")));
        Ok(())
    }

    #[tokio::test]
    async fn save_rule_collisions_get_stable_suffixes() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        fs::create_dir_all(source_dir.path().join("DCIM/100MSDCF")).await?;
        fs::create_dir_all(source_dir.path().join("DCIM/101MSDCF")).await?;
        fs::write(source_dir.path().join("DCIM/100MSDCF/DSC00001.JPG"), b"a").await?;
        fs::write(source_dir.path().join("DCIM/101MSDCF/DSC00001.JPG"), b"bb").await?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = options_with_rule(by_type_template());
        let dry_run = engine.dry_run(&options).await?;
        let mut targets: Vec<PathBuf> = dry_run
            .diffs
            .iter()
            .map(|diff| diff.target_relative_path().to_path_buf())
            .collect();
        targets.sort();
        assert_eq!(
            targets,
            vec![
                PathBuf::from("Photo/DSC00001.JPG"),
                PathBuf::from("Photo/DSC00001_2.JPG")
            ]
        );
        engine
            .sync_files_from_dry_run(&dry_run, &options, |_| {}, |_| {})
            .await?;
        let second = engine.dry_run(&options).await?;
        assert_eq!(second.files_to_copy, 0);
        Ok(())
    }

    #[tokio::test]
    async fn save_rule_target_newer_conflict_uses_mapped_target() -> Result<()> {
        let source_dir = TempDir::new()?;
        let target_dir = TempDir::new()?;
        fs::create_dir_all(source_dir.path().join("DCIM")).await?;
        let source_file = source_dir.path().join("DCIM/DSC00001.JPG");
        fs::write(&source_file, b"source").await?;
        fs::create_dir_all(target_dir.path().join("Photo")).await?;
        let target_file = target_dir.path().join("Photo/DSC00001.JPG");
        fs::write(&target_file, b"target-v2").await?;
        let source_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        filetime::set_file_mtime(
            &source_file,
            filetime::FileTime::from_system_time(source_time),
        )?;
        filetime::set_file_mtime(
            &target_file,
            filetime::FileTime::from_system_time(source_time + std::time::Duration::from_secs(60)),
        )?;

        let engine = SyncEngine::new(
            source_dir.path().to_path_buf(),
            target_dir.path().to_path_buf(),
        );
        let options = options_with_rule(by_type_template());
        let (dry_run, conflicts) = engine
            .dry_run_with_progress_and_conflicts(
                &options,
                CancellationToken::new(),
                |_| {},
                |_, _| {},
            )
            .await?;
        assert_eq!(dry_run.files_to_copy, 0);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, PathBuf::from("DCIM/DSC00001.JPG"));
        assert_eq!(
            conflicts[0].target_relative_path.as_deref(),
            Some(Path::new("Photo/DSC00001.JPG"))
        );
        assert!(conflicts[0].target_path.ends_with("Photo/DSC00001.JPG"));
        Ok(())
    }

    async fn write_file(root: &Path, relative: &str, content: &[u8]) -> Result<()> {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(path, content).await?;
        Ok(())
    }

    fn multi_source_engine(slots: &[&TempDir], target: &TempDir) -> SyncEngine {
        SyncEngine::new(slots[0].path().to_path_buf(), target.path().to_path_buf())
            .with_extra_sources(
                slots[1..]
                    .iter()
                    .enumerate()
                    .map(|(index, dir)| ExtraSourcePath {
                        position: index + 1,
                        path: dir.path().to_path_buf(),
                    })
                    .collect(),
            )
    }

    #[tokio::test]
    async fn multi_source_copies_identical_collision_once() -> Result<()> {
        let slot_a = TempDir::new()?;
        let slot_b = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_a.path(), "DCIM/100MSDCF/DSC00001.JPG", b"same photo").await?;
        write_file(slot_b.path(), "DCIM/100MSDCF/DSC00001.JPG", b"same photo").await?;

        let engine = multi_source_engine(&[&slot_a, &slot_b], &target);
        let options = SyncOptions::default();
        let dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);
        assert!(dry_run.diffs[0].source_root.is_none());

        engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(
            fs::read(target.path().join("DCIM/100MSDCF/DSC00001.JPG")).await?,
            b"same photo"
        );
        assert!(!target.path().join("DCIM/100MSDCF/DSC00001_b.JPG").exists());

        // 두 번째 실행은 할 일이 없어야 한다.
        assert_eq!(engine.dry_run(&options).await?.files_to_copy, 0);
        Ok(())
    }

    #[tokio::test]
    async fn multi_source_letters_differing_collision_by_source_position() -> Result<()> {
        let slot_a = TempDir::new()?;
        let slot_b = TempDir::new()?;
        let slot_c = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_a.path(), "DCIM/DSC00001.JPG", b"card a").await?;
        write_file(slot_b.path(), "DCIM/DSC00001.JPG", b"card b!").await?;
        write_file(slot_c.path(), "DCIM/DSC00001.JPG", b"card b!").await?;
        write_file(slot_c.path(), "DCIM/C0001.MP4", b"video").await?;

        let engine = multi_source_engine(&[&slot_a, &slot_b, &slot_c], &target);
        let options = SyncOptions::default();
        let dry_run = engine.dry_run(&options).await?;
        // a 원본, b는 내용이 달라 _b, c는 b와 같은 내용이라 건너뜀, c의 영상은 그대로.
        assert_eq!(dry_run.files_to_copy, 3);

        engine.sync_files(&options, |_| {}, |_| {}).await?;
        assert_eq!(
            fs::read(target.path().join("DCIM/DSC00001.JPG")).await?,
            b"card a"
        );
        assert_eq!(
            fs::read(target.path().join("DCIM/DSC00001_b.JPG")).await?,
            b"card b!"
        );
        assert!(!target.path().join("DCIM/DSC00001_c.JPG").exists());
        assert_eq!(
            fs::read(target.path().join("DCIM/C0001.MP4")).await?,
            b"video"
        );

        assert_eq!(engine.dry_run(&options).await?.files_to_copy, 0);
        let orphans = engine.find_orphan_files(&[]).await?;
        assert!(orphans.is_empty(), "unexpected orphans: {orphans:?}");
        Ok(())
    }

    #[tokio::test]
    async fn multi_source_orphan_scan_uses_union_of_sources() -> Result<()> {
        let slot_a = TempDir::new()?;
        let slot_b = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_a.path(), "DCIM/A.JPG", b"a").await?;
        write_file(slot_b.path(), "DCIM/B.ARW", b"b").await?;
        write_file(target.path(), "DCIM/A.JPG", b"a").await?;
        write_file(target.path(), "DCIM/B.ARW", b"b").await?;
        write_file(target.path(), "DCIM/OLD.JPG", b"old").await?;

        let engine = multi_source_engine(&[&slot_a, &slot_b], &target);
        let orphans = engine.find_orphan_files(&[]).await?;
        let paths: Vec<_> = orphans.iter().map(|o| o.path.clone()).collect();
        assert_eq!(paths, vec![PathBuf::from("DCIM/OLD.JPG")]);
        Ok(())
    }

    #[tokio::test]
    async fn multi_source_orphan_scan_refuses_missing_source() -> Result<()> {
        let slot_a = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_a.path(), "DCIM/A.JPG", b"a").await?;
        write_file(target.path(), "DCIM/B.ARW", b"b").await?;
        let missing = slot_a.path().join("not-mounted");

        let engine = SyncEngine::new(slot_a.path().to_path_buf(), target.path().to_path_buf())
            .with_extra_sources(vec![ExtraSourcePath {
                position: 1,
                path: missing,
            }]);
        assert!(engine.find_orphan_files(&[]).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn multi_source_copy_rejects_unknown_source_root() -> Result<()> {
        let slot_a = TempDir::new()?;
        let slot_b = TempDir::new()?;
        let other = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_b.path(), "X.JPG", b"x").await?;
        write_file(other.path(), "X.JPG", b"other").await?;

        let engine = multi_source_engine(&[&slot_a, &slot_b], &target);
        let options = SyncOptions::default();
        let mut dry_run = engine.dry_run(&options).await?;
        assert_eq!(dry_run.diffs.len(), 1);
        dry_run.diffs[0].source_root = Some(fs::canonicalize(other.path()).await?);

        let result = engine
            .sync_files_from_dry_run(&dry_run, &options, |_| {}, |_| {})
            .await?;
        assert_eq!(result.files_copied, 0);
        assert_eq!(result.errors.len(), 1);
        assert!(!target.path().join("X.JPG").exists());
        Ok(())
    }

    #[test]
    fn cross_source_collision_suffix_falls_back_to_number() {
        let mut taken = HashSet::new();
        taken.insert(PathBuf::from("DCIM/X.JPG"));
        assert_eq!(
            resolve_cross_source_collision(Path::new("DCIM/X.JPG"), 1, &taken),
            PathBuf::from("DCIM/X_b.JPG")
        );
        taken.insert(PathBuf::from("DCIM/X_b.JPG"));
        assert_eq!(
            resolve_cross_source_collision(Path::new("DCIM/X.JPG"), 1, &taken),
            PathBuf::from("DCIM/X_b_2.JPG")
        );
        assert_eq!(
            resolve_cross_source_collision(Path::new("README"), 2, &HashSet::new()),
            PathBuf::from("README_c")
        );
    }

    #[tokio::test]
    async fn multi_source_letters_hold_when_first_source_is_missing() -> Result<()> {
        let slot_b = TempDir::new()?;
        let slot_c = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_b.path(), "DCIM/X.JPG", b"b").await?;
        write_file(slot_c.path(), "DCIM/X.JPG", b"c!").await?;

        // 첫 번째 소스(a)가 빠져 b가 엔진의 기본 소스가 됐다.
        let engine = SyncEngine::new(slot_b.path().to_path_buf(), target.path().to_path_buf())
            .with_source_position(1)
            .with_extra_sources(vec![ExtraSourcePath {
                position: 2,
                path: slot_c.path().to_path_buf(),
            }]);
        engine
            .sync_files(&SyncOptions::default(), |_| {}, |_| {})
            .await?;
        assert_eq!(fs::read(target.path().join("DCIM/X.JPG")).await?, b"b");
        assert_eq!(fs::read(target.path().join("DCIM/X_c.JPG")).await?, b"c!");
        Ok(())
    }

    #[tokio::test]
    async fn multi_source_letter_follows_task_position_when_a_source_is_skipped() -> Result<()> {
        let slot_a = TempDir::new()?;
        let slot_c = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(slot_a.path(), "DCIM/X.JPG", b"a").await?;
        write_file(slot_c.path(), "DCIM/X.JPG", b"c!").await?;

        // 두 번째 소스(b)는 연결되지 않아 빠졌다.
        let engine = SyncEngine::new(slot_a.path().to_path_buf(), target.path().to_path_buf())
            .with_extra_sources(vec![ExtraSourcePath {
                position: 2,
                path: slot_c.path().to_path_buf(),
            }]);
        engine
            .sync_files(&SyncOptions::default(), |_| {}, |_| {})
            .await?;
        assert_eq!(fs::read(target.path().join("DCIM/X_c.JPG")).await?, b"c!");
        assert!(!target.path().join("DCIM/X_b.JPG").exists());
        Ok(())
    }

    fn jpeg_with_capture(date_time_original: &str, padding: u8) -> Vec<u8> {
        let mut bytes = crate::save_rules::exif::test_support::TiffBuilder {
            little_endian: true,
            date_time_original: Some(date_time_original.to_string()),
            ..Default::default()
        }
        .build_jpeg();
        // 크기는 같고 내용만 다르게 만들기 위한 꼬리 바이트.
        bytes.extend_from_slice(&[padding; 16]);
        bytes
    }

    fn history_options(history: &Arc<CopyHistoryLedger>) -> SyncOptions {
        SyncOptions {
            checksum_mode: false,
            copy_history: Some(history.clone()),
            ..SyncOptions::default()
        }
    }

    async fn run_sync(engine: &SyncEngine, options: &SyncOptions) -> Result<SyncResult> {
        let (plan, _) = engine
            .compare_dirs_internal(options, None, |_| {}, |_, _| {})
            .await?;
        engine
            .sync_files_from_dry_run(&plan, options, |_| {}, |_| {})
            .await
    }

    #[tokio::test]
    async fn copy_history_skips_media_deleted_from_target() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        write_file(source.path(), "notes.txt", b"note").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);

        let first = run_sync(&engine, &options).await?;
        assert_eq!(first.files_copied, 3);
        assert_eq!(history.len(), 2, "only photo and RAW are recorded");

        fs::remove_dir_all(target.path().join("DCIM")).await?;
        fs::remove_file(target.path().join("notes.txt")).await?;

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.skipped_previously_copied, 2);
        assert_eq!(dry_run.files_to_copy, 1);
        assert_eq!(dry_run.diffs[0].path, PathBuf::from("notes.txt"));
        let mut skipped = dry_run.previously_copied_paths.clone();
        skipped.sort();
        assert_eq!(
            skipped,
            vec![
                PathBuf::from("DCIM/DSC00001.ARW"),
                PathBuf::from("DCIM/DSC00001.JPG")
            ]
        );

        let second = run_sync(&engine, &options).await?;
        assert_eq!(second.files_copied, 1);
        assert!(!target.path().join("DCIM/DSC00001.JPG").exists());
        assert!(target.path().join("notes.txt").exists());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_copies_same_name_and_size_with_new_capture_time() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        let first_shot = jpeg_with_capture("2026:10:22 14:03:55", 1);
        let reformatted_shot = jpeg_with_capture("2026:11:01 09:00:00", 2);
        assert_eq!(first_shot.len(), reformatted_shot.len());
        write_file(source.path(), "DCIM/DSC00001.JPG", &first_shot).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;

        // 카드를 포맷한 뒤 같은 번호로 새로 찍은 사진. 타깃은 다른 폴더로 정리된 상태.
        fs::remove_dir_all(target.path().join("DCIM")).await?;
        write_file(source.path(), "DCIM/DSC00001.JPG", &reformatted_shot).await?;

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.skipped_previously_copied, 0);
        assert_eq!(dry_run.files_to_copy, 1);
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_off_keeps_recopying() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let options = SyncOptions {
            checksum_mode: false,
            ..SyncOptions::default()
        };
        run_sync(&engine, &options).await?;
        fs::remove_dir_all(target.path().join("DCIM")).await?;

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 1);
        assert_eq!(dry_run.skipped_previously_copied, 0);
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_records_files_already_in_target_only_on_sync() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        // 옵션을 켜기 전에 이미 동기화된 상태.
        run_sync(
            &engine,
            &SyncOptions {
                checksum_mode: false,
                ..SyncOptions::default()
            },
        )
        .await?;

        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.files_to_copy, 0);
        assert!(history.is_empty(), "dry run must not record");

        let result = run_sync(&engine, &options).await?;
        assert_eq!(result.files_copied, 0);
        assert_eq!(history.len(), 1);

        fs::remove_dir_all(target.path().join("DCIM")).await?;
        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.skipped_previously_copied, 1);
        assert_eq!(dry_run.files_to_copy, 0);
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_failed_copies() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        // 비교 후 복사 전에 소스가 사라져 복사가 실패한다.
        fs::remove_file(source.path().join("DCIM/DSC00001.ARW")).await?;

        let result = engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        assert_eq!(result.files_copied, 0);
        assert_eq!(result.errors.len(), 1);
        assert!(history.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_in_sync_file_replaced_after_dry_run() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        let old_shot = jpeg_with_capture("2026:10:22 14:03:55", 1);
        let new_shot = jpeg_with_capture("2026:11:01 09:00:00", 2);
        write_file(source.path(), "DCIM/DSC00001.JPG", &old_shot).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        run_sync(
            &engine,
            &SyncOptions {
                checksum_mode: false,
                ..SyncOptions::default()
            },
        )
        .await?;

        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        // 캐시된 Dry Run: 양쪽이 같아 기록 후보로만 남는다.
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.copy_history_in_sync.len(), 1);

        // Dry Run 뒤 소스는 같은 이름·크기의 새 사진으로 바뀌고, 타깃의 옛 사진은 옮겨졌다.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        write_file(source.path(), "DCIM/DSC00001.JPG", &new_shot).await?;
        fs::remove_dir_all(target.path().join("DCIM")).await?;

        engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        assert!(history.is_empty(), "a file that was never copied must not be recorded");

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.skipped_previously_copied, 0);
        assert_eq!(dry_run.files_to_copy, 1);
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_in_sync_file_whose_target_was_replaced() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        let shot = jpeg_with_capture("2026:10:22 14:03:55", 1);
        let other_shot = jpeg_with_capture("2026:12:24 20:00:00", 3);
        write_file(source.path(), "DCIM/DSC00001.JPG", &shot).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        run_sync(
            &engine,
            &SyncOptions {
                checksum_mode: false,
                ..SyncOptions::default()
            },
        )
        .await?;

        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.copy_history_in_sync.len(), 1);

        // 비교 뒤 타깃 사진만 같은 크기의 다른 사진으로 바뀌었다.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        write_file(target.path(), "DCIM/DSC00001.JPG", &other_shot).await?;

        engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        assert!(history.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_in_sync_file_with_different_bytes() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        // 촬영 시각이 없는 RAW. 크기와 수정 시각은 같고 내용만 다르다.
        write_file(source.path(), "DCIM/IMG_0001.CR3", b"raw-bytes-A").await?;
        write_file(target.path(), "DCIM/IMG_0001.CR3", b"raw-bytes-B").await?;
        let modified = std::fs::metadata(source.path().join("DCIM/IMG_0001.CR3"))?.modified()?;
        std::fs::File::options()
            .write(true)
            .open(target.path().join("DCIM/IMG_0001.CR3"))?
            .set_modified(modified)?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);

        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.files_to_copy, 0, "size + mtime match counts as in sync");
        engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        assert!(history.is_empty(), "different bytes must not be recorded");

        // 내용까지 같으면 기록한다.
        write_file(target.path(), "DCIM/IMG_0001.CR3", b"raw-bytes-A").await?;
        std::fs::File::options()
            .write(true)
            .open(target.path().join("DCIM/IMG_0001.CR3"))?
            .set_modified(modified)?;
        run_sync(&engine, &options).await?;
        assert_eq!(history.len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_sync_fails_when_target_folder_changes_after_skips() -> Result<()> {
        let source = TempDir::new()?;
        let base = TempDir::new()?;
        let target = base.path().join("Archive");
        std::fs::create_dir_all(&target)?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        write_file(source.path(), "notes.txt", b"note").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.clone());
        let history = Arc::new(CopyHistoryLedger::for_target(
            target.to_string_lossy().into_owned(),
            [],
        ));
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        assert_eq!(history.len(), 1);
        fs::remove_dir_all(target.join("DCIM")).await?;

        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.skipped_previously_copied, 1);

        // 비교 뒤 같은 경로에 빈 디스크가 연결됐다.
        std::fs::remove_dir_all(&target)?;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        std::fs::create_dir_all(&target)?;
        let error = engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await
            .expect_err("skips decided on the old folder must not run on the new one");
        assert!(format!("{error:#}").contains("Target folder changed"));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_sync_fails_when_skipped_source_changes_after_compare() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        assert_eq!(history.len(), 1);
        fs::remove_dir_all(target.path().join("DCIM")).await?;

        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.skipped_previously_copied, 1);

        // 비교 뒤 같은 이름·크기의 다른 사진으로 바뀌었다.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:11:01 09:00:00", 1)).await?;
        let error = engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await
            .expect_err("a replaced skipped source must not stay skipped");
        assert!(format!("{error:#}").contains("changed after the compare"));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_sync_fails_when_skipped_capture_time_changes_with_same_size_and_mtime(
    ) -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        let photo = source.path().join("DCIM/DSC00001.JPG");
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        fs::remove_dir_all(target.path().join("DCIM")).await?;
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.skipped_previously_copied, 1);

        // 크기와 수정 시각은 그대로인 다른 사진으로 바뀌었다.
        let modified = std::fs::metadata(&photo)?.modified()?;
        std::fs::write(&photo, jpeg_with_capture("2026:11:01 09:00:00", 1))?;
        std::fs::File::options().write(true).open(&photo)?.set_modified(modified)?;
        let error = engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await
            .expect_err("a different photo must not stay skipped");
        assert!(format!("{error:#}").contains("changed after the compare"));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_skip_when_target_exists_with_other_case() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/IMG_0001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        std::fs::rename(
            target.path().join("DCIM/IMG_0001.JPG"),
            target.path().join("DCIM/IMG_0001.jpg"),
        )?;
        if !target.path().join("DCIM/IMG_0001.JPG").exists() {
            // 대소문자를 구분하는 볼륨에서는 해당하지 않는다.
            return Ok(());
        }

        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.skipped_previously_copied, 0);
        engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_sync_fails_when_skipped_target_path_is_filled() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        fs::remove_dir_all(target.path().join("DCIM")).await?;
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        assert_eq!(plan.skipped_previously_copied, 1);

        // 비교 뒤 그 타깃 경로에 다른 파일이 놓였다. 일반 비교·충돌 처리를 거쳐야 한다.
        write_file(target.path(), "DCIM/DSC00001.ARW", b"other-file").await?;
        let error = engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await
            .expect_err("a filled target path must be compared again");
        assert!(format!("{error:#}").contains("changed after the compare"));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_copy_whose_source_changed_after_plan() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        // 계획 뒤 복사 전에 소스가 다른 크기의 파일로 바뀌었다.
        write_file(source.path(), "DCIM/DSC00001.ARW", b"different-raw-bytes").await?;

        engine
            .sync_files_from_dry_run(&plan, &options, |_| {}, |_| {})
            .await?;
        assert!(history.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_does_not_record_copy_whose_target_was_replaced_after_copy() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let source_path = source.path().join("DCIM/DSC00001.JPG");
        let meta = std::fs::metadata(&source_path)?;
        // 복사가 끝난 직후 다른 도구가 타깃을 같은 크기의 다른 사진으로 바꿨다.
        write_file(target.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:11:01 09:00:00", 1)).await?;
        let history = Arc::new(CopyHistoryLedger::default());
        SyncEngine::record_copy_history(
            &history,
            vec![CopyHistoryCandidate {
                source_path,
                target_path: target.path().join("DCIM/DSC00001.JPG"),
                target_modified: None,
                relative_path: PathBuf::from("DCIM/DSC00001.JPG"),
                size: meta.len(),
                modified: meta.modified()?,
                content_verified: false,
            }],
        )
        .await;
        assert!(history.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_records_copied_file_from_target_bytes() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        run_sync(&engine, &history_options(&history)).await?;
        let keys = history.keys();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].captured, "exif:2026-10-22T14:03:55");
        Ok(())
    }

    #[tokio::test]
    async fn dry_run_cancel_stops_during_compare() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        for index in 0..8 {
            write_file(source.path(), &format!("DCIM/DSC0000{index}.ARW"), b"raw-bytes").await?;
        }
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let cancel_token = CancellationToken::new();
        let cancel_on_compare = cancel_token.clone();
        let result = engine
            .compare_dirs_internal(
                &SyncOptions::default(),
                Some(cancel_token),
                move |progress| {
                    if progress.phase == DryRunPhase::Comparing {
                        cancel_on_compare.cancel();
                    }
                },
                |_, _| {},
            )
            .await;
        let error = result.expect_err("compare should stop once cancelled");
        assert!(format!("{error:#}").contains("cancelled by user"));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_skip_keeps_save_rule_collision_suffixes() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        // 두 폴더의 같은 이름 사진은 저장 규칙에서 같은 타깃 경로로 모여 접미사가 붙는다.
        write_file(source.path(), "DCIM/100MSDCF/DSC00001.JPG", &jpeg_with_capture("2026:10:22 14:03:55", 1)).await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let mut options = options_with_rule(by_type_template());
        options.copy_history = Some(history.clone());
        run_sync(&engine, &options).await?;
        let first_target = fs::read_dir(target.path().join("Photo")).await;
        assert!(first_target.is_ok());

        fs::remove_dir_all(target.path().join("Photo")).await?;
        write_file(source.path(), "DCIM/101MSDCF/DSC00001.JPG", &jpeg_with_capture("2026:10:23 10:00:00", 2)).await?;

        let dry_run = engine.compare_dirs(&options).await?;
        assert_eq!(dry_run.skipped_previously_copied, 1);
        assert_eq!(dry_run.files_to_copy, 1);
        let planned_without_history = engine
            .compare_dirs(&options_with_rule(by_type_template()))
            .await?;
        let expected = planned_without_history
            .diffs
            .iter()
            .find(|diff| diff.path == Path::new("DCIM/101MSDCF/DSC00001.JPG"))
            .map(|diff| diff.target_relative_path().to_path_buf());
        assert_eq!(
            Some(dry_run.diffs[0].target_relative_path().to_path_buf()),
            expected
        );
        Ok(())
    }

    #[test]
    fn in_sync_candidate_verified_by_hash_skips_byte_compare() -> Result<()> {
        let dir = TempDir::new()?;
        let source_path = dir.path().join("a.CR3");
        let target_path = dir.path().join("b.CR3");
        std::fs::write(&source_path, b"raw-bytes-A")?;
        std::fs::write(&target_path, b"raw-bytes-B")?;
        let modified = std::fs::metadata(&source_path)?.modified()?;
        let stamp = copy_history::capture_stamp(&source_path, modified).expect("stamp");
        let mut candidate = CopyHistoryCandidate {
            source_path,
            target_path,
            target_modified: None,
            relative_path: PathBuf::from("a.CR3"),
            size: 11,
            modified,
            content_verified: false,
        };
        let history = CopyHistoryLedger::default();
        assert!(!SyncEngine::in_sync_candidate_is_same_file(&candidate, &stamp, &history));
        // 비교 때 해시가 같다고 확인한 파일은 내용을 다시 읽지 않는다.
        candidate.content_verified = true;
        assert!(SyncEngine::in_sync_candidate_is_same_file(&candidate, &stamp, &history));
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_reports_progress_while_recording_in_sync_files() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        run_sync(
            &engine,
            &SyncOptions {
                checksum_mode: false,
                ..SyncOptions::default()
            },
        )
        .await?;

        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        let (plan, _) = engine
            .compare_dirs_internal(&options, None, |_| {}, |_, _| {})
            .await?;
        let messages = std::sync::Mutex::new(Vec::new());
        engine
            .sync_files_from_dry_run(
                &plan,
                &options,
                |progress| {
                    if let Some(file) = progress.current_file {
                        messages.lock().unwrap().push((progress.phase, file));
                    }
                },
                |_| {},
            )
            .await?;
        assert_eq!(history.len(), 1);
        // 파일 복사 로그로 남지 않도록 복사 단계가 아닌 별도 단계로 알린다.
        assert!(messages.lock().unwrap().iter().any(|(phase, message)| {
            *phase == SyncProgressPhase::RecordingCopyHistory
                && message.starts_with("Recording copy history")
        }));
        assert!(crate::progress_phase_to_log_category(&SyncProgressPhase::RecordingCopyHistory).is_none());
        Ok(())
    }

    #[tokio::test]
    async fn copy_history_skips_report_compare_progress() -> Result<()> {
        let source = TempDir::new()?;
        let target = TempDir::new()?;
        write_file(source.path(), "DCIM/DSC00001.ARW", b"raw-bytes").await?;
        let engine = SyncEngine::new(source.path().to_path_buf(), target.path().to_path_buf());
        let history = Arc::new(CopyHistoryLedger::default());
        let options = history_options(&history);
        run_sync(&engine, &options).await?;
        fs::remove_dir_all(target.path().join("DCIM")).await?;

        let messages = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = messages.clone();
        let (plan, _) = engine
            .compare_dirs_internal(
                &options,
                None,
                move |progress| sink.lock().unwrap().push(progress.message),
                |_, _| {},
            )
            .await?;
        assert_eq!(plan.skipped_previously_copied, 1);
        assert!(messages
            .lock()
            .unwrap()
            .iter()
            .any(|message| message.ends_with("DSC00001.ARW")));
        Ok(())
    }
}
