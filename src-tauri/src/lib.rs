pub mod error_codes;
pub mod input_validation;
pub mod license;
pub mod license_validation;
pub mod logging;
pub mod path_validation;
pub mod sync_engine;
pub mod system_integration;
pub mod watcher;

#[cfg(test)]
mod lib_tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalSize, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;

use sync_engine::{
    types::{DeleteOrphanResult, OrphanFile, SyncResult, TargetNewerConflictCandidate},
    DryRunResult, SyncEngine, SyncOptions,
};
use system_integration::DiskMonitor;

use license::generate_licenses_report;
use logging::LogManager;
use logging::{add_log, get_system_logs, get_task_logs, LogCategory, DEFAULT_MAX_LOG_LINES};

use watcher::{WatchEvent, WatcherManager};

// Consolidated progress state (prevents race conditions and deadlocks)
struct SyncProgressStateInner {
    last_emit_time: Instant,
    last_log_key: String,
    log_buffer: Vec<logging::LogEntry>,
    last_log_emit_time: Instant,
}

impl SyncProgressStateInner {
    fn new() -> Self {
        Self {
            last_emit_time: Instant::now(),
            last_log_key: String::new(),
            log_buffer: Vec::with_capacity(50), // Buffer size 50
            last_log_emit_time: Instant::now(),
        }
    }
}

#[derive(Clone)]
struct SyncProgressState {
    inner: Arc<Mutex<SyncProgressStateInner>>,
}

impl SyncProgressState {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SyncProgressStateInner::new())),
        }
    }

    fn should_update_file(&self, category: &LogCategory, current_file: &str) -> bool {
        let state = self.inner.try_lock();
        if let Ok(mut state) = state {
            let key = format!("{category:?}:{current_file}");
            if state.last_log_key != key {
                state.last_log_key = key;
                true
            } else {
                false
            }
        } else {
            // Lock poisoned - log and skip update
            false
        }
    }

    fn should_emit_progress(&self) -> bool {
        let state = self.inner.try_lock();
        if let Ok(mut state) = state {
            if state.last_emit_time.elapsed() >= Duration::from_millis(100) {
                state.last_emit_time = Instant::now();
                true
            } else {
                false
            }
        } else {
            // Lock poisoned - don't emit to prevent cascading failures
            false
        }
    }

    fn add_log(&self, entry: logging::LogEntry) -> Option<Vec<logging::LogEntry>> {
        let state = self.inner.try_lock();
        if let Ok(mut state) = state {
            state.log_buffer.push(entry);

            // Flush if buffer full or time elapsed (200ms)
            if state.log_buffer.len() >= 50
                || state.last_log_emit_time.elapsed() >= Duration::from_millis(200)
            {
                state.last_log_emit_time = Instant::now();
                let batch = std::mem::replace(&mut state.log_buffer, Vec::with_capacity(50));
                Some(batch)
            } else {
                None
            }
        } else {
            None
        }
    }

    // Force flush remaining logs
    fn flush_logs(&self) -> Option<Vec<logging::LogEntry>> {
        let state = self.inner.try_lock();
        if let Ok(mut state) = state {
            if state.log_buffer.is_empty() {
                None
            } else {
                let batch = std::mem::replace(&mut state.log_buffer, Vec::with_capacity(50));
                Some(batch)
            }
        } else {
            None
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    log_manager: Arc<LogManager>,
    /// 현재 실행 중인 작업들의 취소 토큰 맵 (task_id -> CancellationToken)
    cancel_tokens: Arc<RwLock<HashMap<String, CancellationToken>>>,
    /// 파일 시스템 감시 매니저
    watcher_manager: Arc<RwLock<WatcherManager>>,
    /// 프론트엔드에서 전달된 최신 런타임 설정
    runtime_config: Arc<RwLock<RuntimeConfigPayload>>,
    /// 현재 동기화 실행 중인 태스크 집합 (중복 실행 방지)
    syncing_tasks: Arc<RwLock<HashSet<String>>>,
    /// 런타임 동기화 대기 큐
    runtime_sync_queue: Arc<RwLock<VecDeque<String>>>,
    /// 큐에 올라간 태스크 집합 (중복 enqueue 방지)
    queued_sync_tasks: Arc<RwLock<HashSet<String>>>,
    /// 런타임 큐 디스패처 실행 여부
    runtime_dispatcher_running: Arc<Mutex<bool>>,
    /// 런타임 동기화 슬롯 해제 알림
    runtime_sync_slot_released: Arc<Notify>,
    /// 초기 watchMode 일괄 동기화 실행 여부
    runtime_initial_watch_bootstrapped: Arc<AtomicBool>,
    /// 런타임이 관리 중인 watcher source 추적 (task_id -> source)
    runtime_watch_sources: Arc<RwLock<HashMap<String, String>>>,
    /// 타겟 최신 파일 충돌 검토 세션
    conflict_review_sessions: Arc<RwLock<HashMap<String, ConflictReviewSession>>>,
    /// 충돌 세션/랜덤 토큰 생성 시퀀스
    conflict_review_seq: Arc<AtomicU64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigPayload {
    #[serde(default)]
    tasks: Vec<RuntimeSyncTask>,
    #[serde(default)]
    exclusion_sets: Vec<RuntimeExclusionSet>,
    #[serde(default)]
    settings: RuntimeSettings,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    #[serde(default = "default_data_unit_system")]
    data_unit_system: DataUnitSystem,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSyncTask {
    id: String,
    name: String,
    source: String,
    target: String,
    #[serde(default)]
    checksum_mode: bool,
    #[serde(default)]
    watch_mode: bool,
    #[serde(default)]
    auto_unmount: bool,
    #[serde(default = "default_verify_after_copy")]
    verify_after_copy: bool,
    #[serde(default)]
    exclusion_sets: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeExclusionSet {
    id: String,
    name: String,
    #[serde(default)]
    patterns: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    watching_tasks: Vec<String>,
    syncing_tasks: Vec<String>,
    queued_tasks: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeWatchStateEvent {
    task_id: String,
    watching: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSyncStateEvent {
    task_id: String,
    syncing: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSyncQueueStateEvent {
    task_id: String,
    queued: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ConflictSessionOrigin {
    Manual,
    Watch,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ConflictItemStatus {
    Pending,
    ForceCopied,
    SafeCopied,
    Skipped,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictFileInfo {
    size: u64,
    modified_unix_ms: Option<i64>,
    created_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetNewerConflictItem {
    id: String,
    relative_path: String,
    source_path: String,
    target_path: String,
    source: ConflictFileInfo,
    target: ConflictFileInfo,
    status: ConflictItemStatus,
    note: Option<String>,
    resolved_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReviewSession {
    id: String,
    task_id: String,
    task_name: String,
    source_root: String,
    target_root: String,
    origin: ConflictSessionOrigin,
    created_at_unix_ms: i64,
    items: Vec<TargetNewerConflictItem>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictSessionSummary {
    id: String,
    task_id: String,
    task_name: String,
    source_root: String,
    target_root: String,
    origin: ConflictSessionOrigin,
    created_at_unix_ms: i64,
    total_count: usize,
    pending_count: usize,
    resolved_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictSessionDetail {
    id: String,
    task_id: String,
    task_name: String,
    source_root: String,
    target_root: String,
    origin: ConflictSessionOrigin,
    created_at_unix_ms: i64,
    total_count: usize,
    pending_count: usize,
    resolved_count: usize,
    items: Vec<TargetNewerConflictItem>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReviewQueueChangedEvent {
    sessions: Vec<ConflictSessionSummary>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReviewOpenSessionEvent {
    session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReviewSessionUpdatedEvent {
    session_id: String,
    pending_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum ConflictResolutionAction {
    ForceCopy,
    RenameThenCopy,
    Skip,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictResolutionRequest {
    item_id: String,
    action: ConflictResolutionAction,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictResolutionFailure {
    item_id: String,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictResolutionResult {
    session_id: String,
    requested_count: usize,
    processed_count: usize,
    pending_count: usize,
    failures: Vec<ConflictResolutionFailure>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseConflictReviewSessionResult {
    closed: bool,
    had_pending: bool,
    skipped_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncExecutionResult {
    sync_result: SyncResult,
    conflict_session_id: Option<String>,
    conflict_count: usize,
    has_pending_conflicts: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictPreviewPayload {
    kind: String,
    source_text: Option<String>,
    target_text: Option<String>,
    source_truncated: bool,
    target_truncated: bool,
}

const RUNTIME_SYNC_MAX_CONCURRENCY: usize = 2;

fn default_verify_after_copy() -> bool {
    true
}

fn default_data_unit_system() -> DataUnitSystem {
    DataUnitSystem::Binary
}

pub(crate) fn progress_phase_to_log_category(
    phase: &sync_engine::types::SyncPhase,
) -> Option<LogCategory> {
    match phase {
        sync_engine::types::SyncPhase::Copying => Some(LogCategory::FileCopied),
        _ => None,
    }
}

pub(crate) fn compute_volume_mount_diff(
    previous_mounts: &HashSet<String>,
    current_mounts: &HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut mounted: Vec<String> = current_mounts
        .difference(previous_mounts)
        .cloned()
        .collect();
    let mut unmounted: Vec<String> = previous_mounts
        .difference(current_mounts)
        .cloned()
        .collect();

    mounted.sort();
    unmounted.sort();
    (mounted, unmounted)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct VolumeEmitDebounceState {
    last_emit_at: Option<Instant>,
    trailing_pending: bool,
}

impl VolumeEmitDebounceState {
    pub(crate) fn new() -> Self {
        Self {
            last_emit_at: None,
            trailing_pending: false,
        }
    }
}

fn volume_emit_window_elapsed(
    last_emit_at: Option<Instant>,
    now: Instant,
    debounce_duration: Duration,
) -> bool {
    last_emit_at
        .map(|last| now.duration_since(last) >= debounce_duration)
        .unwrap_or(true)
}

pub(crate) fn handle_volume_watch_event(
    state: &mut VolumeEmitDebounceState,
    now: Instant,
    debounce_duration: Duration,
) -> bool {
    if volume_emit_window_elapsed(state.last_emit_at, now, debounce_duration) {
        state.last_emit_at = Some(now);
        state.trailing_pending = false;
        true
    } else {
        state.trailing_pending = true;
        false
    }
}

pub(crate) fn handle_volume_watch_tick(
    state: &mut VolumeEmitDebounceState,
    now: Instant,
    debounce_duration: Duration,
) -> bool {
    if !state.trailing_pending {
        return false;
    }

    if volume_emit_window_elapsed(state.last_emit_at, now, debounce_duration) {
        state.last_emit_at = Some(now);
        state.trailing_pending = false;
        true
    } else {
        false
    }
}

fn volume_watch_next_tick_delay(
    state: &VolumeEmitDebounceState,
    now: Instant,
    debounce_duration: Duration,
) -> Option<Duration> {
    if !state.trailing_pending {
        return None;
    }

    let Some(last_emit_at) = state.last_emit_at else {
        return Some(Duration::from_millis(0));
    };

    let elapsed = now.saturating_duration_since(last_emit_at);
    Some(debounce_duration.saturating_sub(elapsed))
}

fn emit_runtime_watch_state(
    app: &tauri::AppHandle,
    task_id: &str,
    watching: bool,
    reason: Option<String>,
) {
    let event = RuntimeWatchStateEvent {
        task_id: task_id.to_string(),
        watching,
        reason,
    };
    let _ = app.emit("runtime-watch-state", &event);
}

fn emit_runtime_sync_state(
    app: &tauri::AppHandle,
    task_id: &str,
    syncing: bool,
    reason: Option<String>,
) {
    let event = RuntimeSyncStateEvent {
        task_id: task_id.to_string(),
        syncing,
        reason,
    };
    let _ = app.emit("runtime-sync-state", &event);
}

fn emit_runtime_sync_queue_state(
    app: &tauri::AppHandle,
    task_id: &str,
    queued: bool,
    reason: Option<String>,
) {
    let event = RuntimeSyncQueueStateEvent {
        task_id: task_id.to_string(),
        queued,
        reason,
    };
    let _ = app.emit("runtime-sync-queue-state", &event);
}

fn unix_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn system_time_to_unix_ms(value: SystemTime) -> Option<i64> {
    value
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

fn conflict_file_info_changed(before: &ConflictFileInfo, current: &ConflictFileInfo) -> bool {
    before.size != current.size
        || before.modified_unix_ms != current.modified_unix_ms
        || before.created_unix_ms != current.created_unix_ms
}

fn pending_conflict_count(items: &[TargetNewerConflictItem]) -> usize {
    items
        .iter()
        .filter(|item| item.status == ConflictItemStatus::Pending)
        .count()
}

fn to_conflict_summary(session: &ConflictReviewSession) -> ConflictSessionSummary {
    let pending_count = pending_conflict_count(&session.items);
    let total_count = session.items.len();
    ConflictSessionSummary {
        id: session.id.clone(),
        task_id: session.task_id.clone(),
        task_name: session.task_name.clone(),
        source_root: session.source_root.clone(),
        target_root: session.target_root.clone(),
        origin: session.origin.clone(),
        created_at_unix_ms: session.created_at_unix_ms,
        total_count,
        pending_count,
        resolved_count: total_count.saturating_sub(pending_count),
    }
}

fn to_conflict_detail(session: &ConflictReviewSession) -> ConflictSessionDetail {
    let summary = to_conflict_summary(session);
    ConflictSessionDetail {
        id: summary.id,
        task_id: summary.task_id,
        task_name: summary.task_name,
        source_root: summary.source_root,
        target_root: summary.target_root,
        origin: summary.origin,
        created_at_unix_ms: summary.created_at_unix_ms,
        total_count: summary.total_count,
        pending_count: summary.pending_count,
        resolved_count: summary.resolved_count,
        items: session.items.clone(),
    }
}

async fn list_conflict_session_summaries_internal(
    state: &AppState,
) -> Vec<ConflictSessionSummary> {
    let sessions = state.conflict_review_sessions.read().await;
    let mut summaries: Vec<ConflictSessionSummary> =
        sessions.values().map(to_conflict_summary).collect();
    summaries.sort_by(|a, b| b.created_at_unix_ms.cmp(&a.created_at_unix_ms));
    summaries
}

async fn emit_conflict_review_queue_changed(app: &tauri::AppHandle, state: &AppState) {
    let sessions = list_conflict_session_summaries_internal(state).await;
    let _ = app.emit(
        "conflict-review-queue-changed",
        &ConflictReviewQueueChangedEvent { sessions },
    );
}

fn conflict_file_info_from_candidate(
    snapshot: &sync_engine::ConflictFileSnapshot,
) -> ConflictFileInfo {
    ConflictFileInfo {
        size: snapshot.size,
        modified_unix_ms: snapshot.modified_unix_ms,
        created_unix_ms: snapshot.created_unix_ms,
    }
}

fn build_conflict_item(
    index: usize,
    candidate: &TargetNewerConflictCandidate,
) -> TargetNewerConflictItem {
    TargetNewerConflictItem {
        id: format!("item-{:06}", index),
        relative_path: candidate.path.to_string_lossy().to_string(),
        source_path: candidate.source_path.to_string_lossy().to_string(),
        target_path: candidate.target_path.to_string_lossy().to_string(),
        source: conflict_file_info_from_candidate(&candidate.source),
        target: conflict_file_info_from_candidate(&candidate.target),
        status: ConflictItemStatus::Pending,
        note: None,
        resolved_at_unix_ms: None,
    }
}

fn session_id_for_task(task_id: &str, seq: u64) -> String {
    let ts = unix_now_ms();
    format!("conflict-{task_id}-{ts}-{seq}")
}

fn random_suffix_token(seed: u64) -> String {
    const ALPHANUM: &[u8; 36] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut value = if seed == 0 { 1 } else { seed };
    let mut out = [b'A'; 3];
    for slot in &mut out {
        let index = (value % 36) as usize;
        *slot = ALPHANUM[index];
        value /= 36;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn safe_copy_timestamp_label(modified_unix_ms: Option<i64>) -> String {
    let dt = modified_unix_ms
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .unwrap_or_else(chrono::Utc::now);
    dt.format("%Y%m%d_%H%M%S").to_string()
}

async fn read_current_conflict_file_info(path: &Path) -> Result<ConflictFileInfo, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Failed to read file metadata '{}': {e}", path.display()))?;

    Ok(ConflictFileInfo {
        size: metadata.len(),
        modified_unix_ms: metadata.modified().ok().and_then(system_time_to_unix_ms),
        created_unix_ms: metadata.created().ok().and_then(system_time_to_unix_ms),
    })
}

async fn copy_file_preserve(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    tokio::fs::copy(source, target)
        .await
        .map_err(|e| format!("Failed to copy file: {e}"))?;

    let meta = tokio::fs::metadata(source)
        .await
        .map_err(|e| format!("Failed to read source metadata: {e}"))?;
    tokio::fs::set_permissions(target, meta.permissions())
        .await
        .map_err(|e| format!("Failed to preserve permissions: {e}"))?;

    if let Ok(modified) = meta.modified() {
        let _ = filetime::set_file_mtime(target, filetime::FileTime::from_system_time(modified));
    }

    Ok(())
}

fn preview_kind_for_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    let Some(ext) = ext else {
        return "other";
    };

    let image_ext = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic"];
    let video_ext = ["mp4", "mov", "m4v", "avi", "mkv", "webm"];
    let text_ext = [
        "txt", "md", "json", "yaml", "yml", "toml", "xml", "log", "rs", "ts", "tsx", "js",
        "jsx", "css", "html", "csv", "ini",
    ];
    let document_ext = ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "pages", "numbers", "key"];

    if image_ext.contains(&ext.as_str()) {
        "image"
    } else if video_ext.contains(&ext.as_str()) {
        "video"
    } else if text_ext.contains(&ext.as_str()) {
        "text"
    } else if document_ext.contains(&ext.as_str()) {
        "document"
    } else {
        "other"
    }
}

async fn read_text_preview(path: &str, max_bytes: usize) -> (Option<String>, bool) {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return (None, false);
    };
    let mut reader = tokio::io::BufReader::new(file);
    let mut buffer = vec![0u8; max_bytes.saturating_add(1)];
    let Ok(read_count) = tokio::io::AsyncReadExt::read(&mut reader, &mut buffer).await else {
        return (None, false);
    };
    let truncated = read_count > max_bytes;
    let content = &buffer[..read_count.min(max_bytes)];
    match std::str::from_utf8(content) {
        Ok(text) => (Some(text.to_string()), truncated),
        Err(_) => (None, false),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UuidTokenType {
    Disk,
    Volume,
    Legacy,
}

struct ParsedUuidSourcePath<'a> {
    token_type: UuidTokenType,
    uuid: &'a str,
    sub_path: &'a str,
}

fn parse_uuid_source_path(path_str: &str) -> Option<ParsedUuidSourcePath<'_>> {
    let token = if path_str.starts_with("[DISK_UUID:") {
        Some(("[DISK_UUID:", UuidTokenType::Disk))
    } else if path_str.starts_with("[VOLUME_UUID:") {
        Some(("[VOLUME_UUID:", UuidTokenType::Volume))
    } else if path_str.starts_with("[UUID:") {
        Some(("[UUID:", UuidTokenType::Legacy))
    } else {
        None
    }?;

    let (prefix, token_type) = token;
    let end_idx = path_str.find(']')?;

    Some(ParsedUuidSourcePath {
        token_type,
        uuid: &path_str[prefix.len()..end_idx],
        sub_path: &path_str[end_idx + 1..],
    })
}

fn has_uuid_source_prefix(path_str: &str) -> bool {
    path_str.starts_with("[DISK_UUID:")
        || path_str.starts_with("[VOLUME_UUID:")
        || path_str.starts_with("[UUID:")
}

fn uuid_token_label(token_type: UuidTokenType) -> &'static str {
    match token_type {
        UuidTokenType::Disk => "DISK_UUID",
        UuidTokenType::Volume => "VOLUME_UUID",
        UuidTokenType::Legacy => "UUID",
    }
}

fn resolve_path_with_uuid(path_str: &str) -> Result<PathBuf, String> {
    let Some(parsed) = parse_uuid_source_path(path_str) else {
        return Ok(PathBuf::from(path_str));
    };

    let monitor = DiskMonitor::new();
    let volumes = monitor.list_volumes().map_err(|e| e.to_string())?;

    let volume = match parsed.token_type {
        UuidTokenType::Disk => volumes
            .iter()
            .find(|v| v.disk_uuid.as_deref() == Some(parsed.uuid))
            .cloned(),
        UuidTokenType::Volume => volumes
            .iter()
            .find(|v| v.volume_uuid.as_deref() == Some(parsed.uuid))
            .cloned(),
        UuidTokenType::Legacy => volumes
            .iter()
            .find(|v| v.disk_uuid.as_deref() == Some(parsed.uuid))
            .cloned()
            .or_else(|| {
                volumes
                    .iter()
                    .find(|v| v.volume_uuid.as_deref() == Some(parsed.uuid))
                    .cloned()
            }),
    }
    .ok_or_else(|| {
        format!(
            "Volume with {} {} not found (not mounted?)",
            uuid_token_label(parsed.token_type),
            parsed.uuid
        )
    })?;

    let clean_sub_path = parsed.sub_path.trim_start_matches('/');
    Ok(volume.mount_point.join(clean_sub_path))
}

fn resolve_runtime_exclude_patterns(
    task: &RuntimeSyncTask,
    sets: &[RuntimeExclusionSet],
) -> Vec<String> {
    if task.exclusion_sets.is_empty() {
        return Vec::new();
    }

    let selected: HashSet<&str> = task.exclusion_sets.iter().map(String::as_str).collect();
    sets.iter()
        .filter(|set| selected.contains(set.id.as_str()))
        .flat_map(|set| set.patterns.clone())
        .collect()
}

fn normalize_path_components(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn path_key_for_compare(path: &Path) -> String {
    let normalized = normalize_path_components(path);
    let mut key = normalized.to_string_lossy().replace('\\', "/");
    while key.ends_with('/') && key.len() > 1 {
        key.pop();
    }
    key.to_lowercase()
}

fn is_same_or_subpath(parent: &str, child: &str) -> bool {
    if parent == child {
        return true;
    }
    child
        .strip_prefix(parent)
        .map(|rest| rest.starts_with('/'))
        .unwrap_or(false)
}

fn is_path_overlap(a: &str, b: &str) -> bool {
    is_same_or_subpath(a, b) || is_same_or_subpath(b, a)
}

fn resolved_path_key(path: &str) -> Result<String, String> {
    match resolve_path_with_uuid(path) {
        Ok(resolved) => Ok(path_key_for_compare(&resolved)),
        Err(err) => {
            if has_uuid_source_prefix(path) {
                Ok(path_key_for_compare(&PathBuf::from(path)))
            } else {
                Err(err)
            }
        }
    }
}

fn validate_runtime_tasks(tasks: &[RuntimeSyncTask]) -> Result<(), String> {
    struct ValidatedTask {
        id: String,
        name: String,
        source_key: String,
        target_key: String,
        watch_mode: bool,
    }

    let mut validated_tasks: Vec<ValidatedTask> = Vec::with_capacity(tasks.len());

    for task in tasks {
        input_validation::validate_task_id(&task.id).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(&task.source).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(&task.target).map_err(|e| e.to_string())?;

        let source_key = resolved_path_key(&task.source)?;
        let target_key = resolved_path_key(&task.target)?;

        if is_path_overlap(&source_key, &target_key) {
            return Err(format!(
                "Task '{}' has overlapping source/target paths. source='{}', target='{}'",
                task.name, task.source, task.target
            ));
        }

        validated_tasks.push(ValidatedTask {
            id: task.id.clone(),
            name: task.name.clone(),
            source_key,
            target_key,
            watch_mode: task.watch_mode,
        });
    }

    for left_index in 0..validated_tasks.len() {
        for right_index in (left_index + 1)..validated_tasks.len() {
            let left = &validated_tasks[left_index];
            let right = &validated_tasks[right_index];

            if is_path_overlap(&left.target_key, &right.target_key) {
                return Err(format!(
                    "Target path conflict: '{}' and '{}' use overlapping targets.",
                    left.name, right.name
                ));
            }
        }
    }

    for watch_task in validated_tasks.iter().filter(|task| task.watch_mode) {
        for other in &validated_tasks {
            if other.id == watch_task.id {
                continue;
            }

            if is_path_overlap(&other.target_key, &watch_task.source_key) {
                return Err(format!(
                    "Watch loop risk: target of '{}' overlaps watch source of '{}'.",
                    other.name, watch_task.name
                ));
            }
        }
    }

    Ok(())
}

fn runtime_desired_watch_sources(tasks: &[RuntimeSyncTask]) -> HashMap<String, String> {
    tasks
        .iter()
        .filter(|task| task.watch_mode)
        .map(|task| (task.id.clone(), task.source.clone()))
        .collect()
}

fn runtime_find_watch_task<'a>(
    tasks: &'a [RuntimeSyncTask],
    task_id: &str,
) -> Option<&'a RuntimeSyncTask> {
    tasks
        .iter()
        .find(|task| task.id == task_id && task.watch_mode)
}

async fn is_runtime_watch_task_active(task_id: &str, state: &AppState) -> bool {
    let managed = {
        let sources = state.runtime_watch_sources.read().await;
        sources.contains_key(task_id)
    };

    if !managed {
        return false;
    }

    let manager = state.watcher_manager.read().await;
    manager.get_watching_tasks().iter().any(|id| id == task_id)
}

async fn acquire_sync_slot(task_id: &str, state: &AppState) -> bool {
    let mut syncing = state.syncing_tasks.write().await;
    syncing.insert(task_id.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSyncAcquireResult {
    Acquired,
    AlreadySyncing,
    CapacityReached,
}

async fn acquire_runtime_sync_slot(task_id: &str, state: &AppState) -> RuntimeSyncAcquireResult {
    let mut syncing = state.syncing_tasks.write().await;

    if syncing.contains(task_id) {
        return RuntimeSyncAcquireResult::AlreadySyncing;
    }

    if syncing.len() >= RUNTIME_SYNC_MAX_CONCURRENCY {
        return RuntimeSyncAcquireResult::CapacityReached;
    }

    syncing.insert(task_id.to_string());
    RuntimeSyncAcquireResult::Acquired
}

async fn release_sync_slot(task_id: &str, state: &AppState) {
    let removed = {
        let mut syncing = state.syncing_tasks.write().await;
        syncing.remove(task_id)
    };

    if removed {
        state.runtime_sync_slot_released.notify_one();
    }
}

async fn enqueue_runtime_sync_task(
    task_id: &str,
    app: &tauri::AppHandle,
    state: &AppState,
    reason: Option<String>,
) -> bool {
    {
        let syncing = state.syncing_tasks.read().await;
        if syncing.contains(task_id) {
            return false;
        }
    }

    let mut queued_set = state.queued_sync_tasks.write().await;
    if !queued_set.insert(task_id.to_string()) {
        return false;
    }
    drop(queued_set);

    let mut queue = state.runtime_sync_queue.write().await;
    queue.push_back(task_id.to_string());
    drop(queue);

    emit_runtime_sync_queue_state(app, task_id, true, reason);
    true
}

async fn dequeue_runtime_sync_task(state: &AppState) -> Option<String> {
    let next = {
        let mut queue = state.runtime_sync_queue.write().await;
        queue.pop_front()
    };

    if let Some(task_id) = &next {
        let mut queued_set = state.queued_sync_tasks.write().await;
        queued_set.remove(task_id);
    }

    next
}

fn schedule_runtime_sync_dispatcher(app: tauri::AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        let should_start = {
            let mut running = state.runtime_dispatcher_running.lock().await;
            if *running {
                false
            } else {
                *running = true;
                true
            }
        };

        if !should_start {
            return;
        }

        loop {
            let current_syncing = {
                let syncing = state.syncing_tasks.read().await;
                syncing.len()
            };

            let has_queued = {
                let queue = state.runtime_sync_queue.read().await;
                !queue.is_empty()
            };

            if should_wait_for_runtime_slot(has_queued, current_syncing) {
                state.runtime_sync_slot_released.notified().await;
                continue;
            }

            if !has_queued {
                break;
            }

            let Some(task_id) = dequeue_runtime_sync_task(&state).await else {
                break;
            };

            emit_runtime_sync_queue_state(&app, &task_id, false, None);

            let app_for_sync = app.clone();
            let state_for_sync = state.clone();
            tauri::async_runtime::spawn(async move {
                runtime_sync_task(task_id, app_for_sync, state_for_sync).await;
            });
        }

        {
            let mut running = state.runtime_dispatcher_running.lock().await;
            *running = false;
        }

        let has_queued = {
            let queue = state.runtime_sync_queue.read().await;
            !queue.is_empty()
        };

        if should_reschedule_runtime_dispatcher(has_queued) {
            schedule_runtime_sync_dispatcher(app.clone(), state.clone());
        }
    });
}

fn should_wait_for_runtime_slot(has_queued: bool, current_syncing: usize) -> bool {
    has_queued && current_syncing >= RUNTIME_SYNC_MAX_CONCURRENCY
}

fn should_reschedule_runtime_dispatcher(has_queued: bool) -> bool {
    has_queued
}

#[cfg(test)]
mod runtime_dispatcher_tests {
    use super::{
        should_reschedule_runtime_dispatcher, should_wait_for_runtime_slot,
        RUNTIME_SYNC_MAX_CONCURRENCY,
    };

    #[test]
    fn waits_for_slot_release_only_when_full_and_queued() {
        assert!(should_wait_for_runtime_slot(
            true,
            RUNTIME_SYNC_MAX_CONCURRENCY
        ));
        assert!(!should_wait_for_runtime_slot(
            true,
            RUNTIME_SYNC_MAX_CONCURRENCY - 1
        ));
        assert!(!should_wait_for_runtime_slot(
            false,
            RUNTIME_SYNC_MAX_CONCURRENCY
        ));
    }

    #[test]
    fn reschedules_only_when_queue_has_work_after_shutdown() {
        assert!(should_reschedule_runtime_dispatcher(true));
        assert!(!should_reschedule_runtime_dispatcher(false));
    }
}

async fn runtime_get_state_internal(state: &AppState) -> RuntimeState {
    let watching_tasks = {
        let manager = state.watcher_manager.read().await;
        manager.get_watching_tasks()
    };
    let syncing_tasks = {
        let syncing = state.syncing_tasks.read().await;
        syncing.iter().cloned().collect()
    };
    let queued_tasks = {
        let queue = state.runtime_sync_queue.read().await;
        queue.iter().cloned().collect()
    };

    RuntimeState {
        watching_tasks,
        syncing_tasks,
        queued_tasks,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncOrigin {
    Manual,
    Watch,
}

async fn create_conflict_review_session(
    task_id: &str,
    task_name: &str,
    source_root: &Path,
    target_root: &Path,
    candidates: &[TargetNewerConflictCandidate],
    origin: SyncOrigin,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Option<String> {
    if candidates.is_empty() {
        return None;
    }

    let seq = state.conflict_review_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let session_id = session_id_for_task(task_id, seq);
    let items = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| build_conflict_item(index + 1, candidate))
        .collect();

    let session = ConflictReviewSession {
        id: session_id.clone(),
        task_id: task_id.to_string(),
        task_name: task_name.to_string(),
        source_root: source_root.to_string_lossy().to_string(),
        target_root: target_root.to_string_lossy().to_string(),
        origin: if origin == SyncOrigin::Watch {
            ConflictSessionOrigin::Watch
        } else {
            ConflictSessionOrigin::Manual
        },
        created_at_unix_ms: unix_now_ms(),
        items,
    };

    {
        let mut sessions = state.conflict_review_sessions.write().await;
        sessions.insert(session_id.clone(), session);
    }

    state.log_manager.log_with_category(
        "warning",
        &format!(
            "Target newer conflicts detected: {} item(s). Session: {}",
            candidates.len(),
            session_id
        ),
        Some(task_id.to_string()),
        LogCategory::Other,
    );

    emit_conflict_review_queue_changed(app, state).await;
    Some(session_id)
}

async fn maybe_notify_conflict_for_watch(
    app: &tauri::AppHandle,
    task_name: &str,
    conflict_count: usize,
) {
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let main_visible = main_window.is_visible().unwrap_or(true);
    if main_visible {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("SyncWatcher")
            .body(&format!(
                "Watch conflict detected in '{}': {} file(s) need review.",
                task_name, conflict_count
            ))
            .show();
    }
}

async fn execute_sync_internal(
    task_id: String,
    task_name: String,
    source: PathBuf,
    target: PathBuf,
    checksum_mode: bool,
    verify_after_copy: bool,
    exclude_patterns: Vec<String>,
    app: tauri::AppHandle,
    state: AppState,
    sync_slot_pre_acquired: bool,
    sync_origin: SyncOrigin,
) -> Result<SyncExecutionResult, String> {
    if !sync_slot_pre_acquired && !acquire_sync_slot(&task_id, &state).await {
        return Err("Task is already syncing".to_string());
    }

    let sync_result = async {
        let source = resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        let target = resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;

        // Validate all inputs
        input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;

        // 취소 토큰 생성 및 등록
        let cancel_token = CancellationToken::new();
        {
            let mut tokens = state.cancel_tokens.write().await;
            tokens.insert(task_id.clone(), cancel_token.clone());
        }

        state.log_manager.log_with_category(
            "info",
            "Sync started",
            Some(task_id.clone()),
            LogCategory::SyncStarted,
        );

        let engine = SyncEngine::new(source.clone(), target.clone());
        let options = SyncOptions {
            checksum_mode,
            preserve_permissions: true,
            preserve_times: true,
            verify_after_copy,
            exclude_patterns,
        };

        let target_newer_conflicts = engine
            .target_newer_conflicts(&options)
            .await
            .map_err(|e| format!("{:#}", e))?;

        // 동기화 실행 (취소 토큰과 함께)
        let task_id_clone = task_id.clone();
        let task_id_for_event = task_id.clone(); // Closure용 별도 복사본
        let app_clone = app.clone();

        #[derive(serde::Serialize, Clone)]
        struct ProgressEvent {
            #[serde(rename = "taskId")]
            task_id: String,
            message: String,
            current: u64,
            total: u64,
        }

        let progress_state = SyncProgressState::new();
        let log_manager = state.log_manager.clone();
        let task_id_for_log = task_id.clone();
        let app_for_log = app.clone(); // For log events

        // Create clones for the closure
        let progress_state_closure = progress_state.clone();
        let log_manager_closure = log_manager.clone();

        let result = tokio::select! {
            res = engine.sync_files(&options, move |progress| {
                 // 1. Detailed Logging: Batching
                if let Some(current) = &progress.current_file {
                    if let Some(category) = progress_phase_to_log_category(&progress.phase) {
                        if progress_state_closure.should_update_file(&category, current) {
                            let now = chrono::Utc::now().to_rfc3339();
                            let message = match &category {
                                LogCategory::FileCopied => format!("Copy: {}", current),
                                LogCategory::FileDeleted => format!("Delete: {}", current),
                                _ => current.to_string(),
                            };
                            let entry = logging::LogEntry {
                                id: now.clone(),
                                timestamp: now,
                                level: "info".to_string(),
                                message,
                                task_id: Some(task_id_for_log.clone()),
                                category,
                            };

                            if let Some(batch) = progress_state_closure.add_log(entry) {
                                log_manager_closure.log_batch_entries(
                                    batch,
                                    Some(task_id_for_log.clone()),
                                    Some(&app_for_log),
                                );
                            }
                        }
                    }
                }

                 // 2. UI Throttling: 100ms
                let should_emit = progress_state_closure.should_emit_progress();

                if should_emit || progress.processed_files == progress.total_files {
                     let event = ProgressEvent {
                        task_id: task_id_for_event.clone(),
                        message: progress.clone().current_file.unwrap_or_else(|| "Syncing...".to_string()),
                        current: progress.processed_files,
                        total: progress.total_files,
                    };
                    let _ = app_clone.emit("sync-progress", &event);
                }
            }) => {
                // Flush remaining logs on completion
                if let Some(batch) = progress_state.flush_logs() {
                    log_manager.log_batch_entries(batch, Some(task_id.clone()), Some(&app));
                }
                res
            },
            _ = cancel_token.cancelled() => {
                 // Flush logs on cancel too
                if let Some(batch) = progress_state.flush_logs() {
                    log_manager.log_batch_entries(batch, Some(task_id.clone()), Some(&app));
                }
                Err(anyhow::anyhow!("Operation cancelled by user"))
            }
        };

        // 취소 토큰 정리
        {
            let mut tokens = state.cancel_tokens.write().await;
            tokens.remove(&task_id_clone);
        }

        match &result {
            Ok(res) => {
                let unit_system = state.runtime_config.read().await.settings.data_unit_system;
                let msg = format!(
                    "Sync completed.\nCopied: {} files\nData transferred: {}",
                    format_number(res.files_copied),
                    format_bytes_with_unit(res.bytes_copied, unit_system)
                );
                state.log_manager.log_with_category(
                    "success",
                    &msg,
                    Some(task_id.clone()),
                    LogCategory::SyncCompleted,
                );

                let conflict_session_id = create_conflict_review_session(
                    &task_id,
                    &task_name,
                    &source,
                    &target,
                    &target_newer_conflicts,
                    sync_origin,
                    &state,
                    &app,
                )
                .await;
                if conflict_session_id.is_some() && sync_origin == SyncOrigin::Watch {
                    maybe_notify_conflict_for_watch(&app, &task_name, target_newer_conflicts.len())
                        .await;
                }

                Ok(SyncExecutionResult {
                    sync_result: res.clone(),
                    conflict_session_id,
                    conflict_count: target_newer_conflicts.len(),
                    has_pending_conflicts: !target_newer_conflicts.is_empty(),
                })
            }
            Err(e) => {
                let msg = format!("Sync failed: {:#}", e);
                state.log_manager.log_with_category(
                    "error",
                    &msg,
                    Some(task_id.clone()),
                    LogCategory::SyncError,
                );
                Err(format!("{:#}", e))
            }
        }
    }
    .await;

    release_sync_slot(&task_id, &state).await;
    sync_result
}

async fn runtime_sync_task(task_id: String, app: tauri::AppHandle, state: AppState) {
    let runtime_config = {
        let config = state.runtime_config.read().await;
        config.clone()
    };

    let task = runtime_find_watch_task(&runtime_config.tasks, &task_id).cloned();

    let Some(task) = task else {
        return;
    };

    if !is_runtime_watch_task_active(&task.id, &state).await {
        return;
    }

    match acquire_runtime_sync_slot(&task.id, &state).await {
        RuntimeSyncAcquireResult::Acquired => {}
        RuntimeSyncAcquireResult::AlreadySyncing => {
            return;
        }
        RuntimeSyncAcquireResult::CapacityReached => {
            let queued = enqueue_runtime_sync_task(
                &task.id,
                &app,
                &state,
                Some("Waiting for available sync slot".to_string()),
            )
            .await;

            if queued {
                schedule_runtime_sync_dispatcher(app.clone(), state.clone());
            }
            return;
        }
    }

    emit_runtime_sync_state(&app, &task.id, true, None);

    let exclude_patterns = resolve_runtime_exclude_patterns(&task, &runtime_config.exclusion_sets);
    let result = execute_sync_internal(
        task.id.clone(),
        task.name.clone(),
        PathBuf::from(task.source.clone()),
        PathBuf::from(task.target.clone()),
        task.checksum_mode,
        task.verify_after_copy,
        exclude_patterns,
        app.clone(),
        state.clone(),
        true,
        SyncOrigin::Watch,
    )
    .await;

    if let Ok(exec_result) = &result {
        if task.auto_unmount && !exec_result.has_pending_conflicts {
            if let Ok(source_path) = resolve_path_with_uuid(&task.source) {
                if let Err(err) = DiskMonitor::unmount_volume(&source_path) {
                    state.log_manager.log(
                        "warning",
                        &format!("Auto unmount failed: {}", err),
                        Some(task.id.clone()),
                    );
                }
            }
        } else if task.auto_unmount && exec_result.has_pending_conflicts {
            state.log_manager.log_with_category(
                "warning",
                "Auto unmount skipped because conflict review is pending",
                Some(task.id.clone()),
                LogCategory::Other,
            );
        }
    }

    let reason = result.err();
    emit_runtime_sync_state(&app, &task.id, false, reason);

    schedule_runtime_sync_dispatcher(app, state);
}

async fn start_watch_internal(
    task_id: String,
    source_path: PathBuf,
    app: tauri::AppHandle,
    state: AppState,
    runtime_owned: bool,
) -> Result<PathBuf, String> {
    let source_path =
        resolve_path_with_uuid(source_path.to_str().unwrap_or("")).map_err(|e| e.to_string())?;

    // Validate inputs
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(source_path.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;

    let task_id_clone = task_id.clone();
    let app_clone = app.clone();
    let state_clone = state.clone();

    let mut manager = state.watcher_manager.write().await;
    manager
        .start_watching(task_id.clone(), source_path.clone(), move |event| {
            // 변경 감지 시 프론트엔드에 이벤트 전송
            let watch_event = WatchEvent::from_notify_event(task_id_clone.clone(), &event);
            let _ = app_clone.emit("watch-event", &watch_event);

            if runtime_owned {
                let app_for_sync = app_clone.clone();
                let state_for_sync = state_clone.clone();
                let task_id_for_sync = task_id_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let queued = enqueue_runtime_sync_task(
                        &task_id_for_sync,
                        &app_for_sync,
                        &state_for_sync,
                        Some("Triggered by watch event".to_string()),
                    )
                    .await;

                    if queued {
                        schedule_runtime_sync_dispatcher(app_for_sync, state_for_sync);
                    }
                });
            }
        })
        .map_err(|e| format!("{}:{}", error_codes::ERR_WATCH_START_FAILED, e))?;

    state.log_manager.log_with_category(
        "info",
        &format!("Watch started: {}", source_path.display()),
        Some(task_id),
        LogCategory::WatchStarted,
    );

    Ok(source_path)
}

async fn reconcile_runtime_watchers(app: tauri::AppHandle, state: AppState) -> Result<(), String> {
    let runtime_config = {
        let config = state.runtime_config.read().await;
        config.clone()
    };

    // Validate payload before applying runtime changes.
    validate_runtime_tasks(&runtime_config.tasks)?;
    for set in &runtime_config.exclusion_sets {
        input_validation::validate_exclude_patterns(&set.patterns).map_err(|e| e.to_string())?;
    }

    let desired = runtime_desired_watch_sources(&runtime_config.tasks);

    let watching_now: HashSet<String> = {
        let manager = state.watcher_manager.read().await;
        manager.get_watching_tasks().into_iter().collect()
    };

    let managed_sources = {
        let sources = state.runtime_watch_sources.read().await;
        sources.clone()
    };

    // Start or restart desired watchers.
    for (task_id, source) in &desired {
        let source_changed = managed_sources
            .get(task_id)
            .map(|existing| existing != source)
            .unwrap_or(false);
        let is_managed = managed_sources.contains_key(task_id);
        let is_watching = watching_now.contains(task_id);

        if !is_managed || !is_watching || source_changed {
            match start_watch_internal(
                task_id.clone(),
                PathBuf::from(source),
                app.clone(),
                state.clone(),
                true,
            )
            .await
            {
                Ok(_) => {
                    {
                        let mut sources = state.runtime_watch_sources.write().await;
                        sources.insert(task_id.clone(), source.clone());
                    }
                    emit_runtime_watch_state(&app, task_id, true, None);
                }
                Err(err) => {
                    {
                        let mut sources = state.runtime_watch_sources.write().await;
                        sources.remove(task_id);
                    }
                    emit_runtime_watch_state(&app, task_id, false, Some(err));
                }
            }
        }
    }

    // Stop watchers no longer managed by runtime config.
    for task_id in managed_sources.keys() {
        if desired.contains_key(task_id) {
            continue;
        }

        let stop_result = {
            let mut manager = state.watcher_manager.write().await;
            manager
                .stop_watching(task_id)
                .map_err(|e| format!("{}:{}", error_codes::ERR_WATCH_STOP_FAILED, e))
        };

        match stop_result {
            Ok(()) => {
                state.log_manager.log_with_category(
                    "info",
                    "Watch stopped",
                    Some(task_id.clone()),
                    LogCategory::WatchStopped,
                );
                {
                    let mut sources = state.runtime_watch_sources.write().await;
                    sources.remove(task_id);
                }
                {
                    let mut queued = state.queued_sync_tasks.write().await;
                    queued.remove(task_id);
                }
                {
                    let mut queue = state.runtime_sync_queue.write().await;
                    queue.retain(|queued_task_id| queued_task_id != task_id);
                }
                emit_runtime_sync_queue_state(
                    &app,
                    task_id,
                    false,
                    Some("Watch task removed".to_string()),
                );
                emit_runtime_watch_state(&app, task_id, false, None);
            }
            Err(err) => {
                emit_runtime_watch_state(&app, task_id, true, Some(err));
            }
        }
    }

    Ok(())
}

async fn enqueue_initial_runtime_watch_syncs(app: tauri::AppHandle, state: AppState) {
    let runtime_config = {
        let config = state.runtime_config.read().await;
        config.clone()
    };

    let mut enqueued_any = false;
    for task in runtime_config.tasks.iter().filter(|task| task.watch_mode) {
        let queued = enqueue_runtime_sync_task(
            &task.id,
            &app,
            &state,
            Some("Initial sync after runtime initialization".to_string()),
        )
        .await;

        enqueued_any = enqueued_any || queued;
    }

    if enqueued_any {
        schedule_runtime_sync_dispatcher(app, state);
    }
}

#[tauri::command]
async fn get_app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_dir = app_data.join("config");
    tokio::fs::create_dir_all(&config_dir)
        .await
        .map_err(|e| e.to_string())?;
    Ok(config_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn join_paths(path1: String, path2: String) -> Result<String, String> {
    use std::path::Path;
    let p1 = Path::new(&path1);
    let p2 = Path::new(&path2);
    p1.join(p2)
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
#[allow(dead_code)]
async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_yaml_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_yaml_file(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_directory_exists(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
async fn open_in_editor(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    // Path validation for security
    let path_obj = Path::new(&path);

    // Only allow absolute paths
    if !path_obj.is_absolute() {
        return Err("Only absolute paths are allowed".to_string());
    }

    // Canonicalize the path to resolve symlinks and .. components
    let canonical = path_obj
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    // Get the config directory for validation
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let config_dir = app_data.join("config");

    // Ensure config directory exists for comparison
    let config_canonical = config_dir.canonicalize().unwrap_or(config_dir);

    // Verify the path is within the config directory
    let canonical_str = canonical.to_string_lossy();
    let config_str = config_canonical.to_string_lossy();

    if !canonical_str.as_ref().starts_with(config_str.as_ref()) {
        return Err(format!("Access denied: Path outside config directory\nAllowed: {config_str}\nRequested: {canonical_str}"));
    }

    // Try to open with default system editor
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-t")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open first, fall back to common editors
        let editors = vec!["xdg-open", "gedit", "kate", "code", "vim"];
        let mut opened = false;

        for editor in editors {
            if std::process::Command::new(editor)
                .arg(&canonical)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err("No suitable editor found".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad.exe")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn sync_dry_run(
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    checksum_mode: bool,
    exclude_patterns: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<DryRunResult, String> {
    let source =
        resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    let target =
        resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;

    // Validate all inputs
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(source.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(target.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;

    state
        .log_manager
        .log("info", "Dry run started", Some(task_id.clone()));

    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy: false,
        exclude_patterns,
    };

    match engine.dry_run(&options).await {
        Ok(result) => {
            let unit_system = state.runtime_config.read().await.settings.data_unit_system;
            let msg = format!(
                "Dry run completed.\nTo copy: {} files\nTotal size: {}",
                format_number(result.files_to_copy as u64),
                format_bytes_with_unit(result.bytes_to_copy, unit_system)
            );
            state.log_manager.log("success", &msg, Some(task_id));
            Ok(result)
        }
        Err(e) => {
            let msg = format!("Dry run failed: {:#}", e);
            state.log_manager.log("error", &msg, Some(task_id));
            Err(format!("{:#}", e))
        }
    }
}

#[tauri::command]
async fn find_orphan_files(
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    exclude_patterns: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<OrphanFile>, String> {
    let source =
        resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    let target =
        resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;

    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(source.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(target.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;

    let engine = SyncEngine::new(source, target);
    let orphans = engine
        .find_orphan_files(&exclude_patterns)
        .await
        .map_err(|e| format!("{:#}", e))?;

    state.log_manager.log_with_category(
        "info",
        &format!("Orphan scan completed: {} candidates", orphans.len()),
        Some(task_id),
        LogCategory::Other,
    );

    Ok(orphans)
}

#[tauri::command]
async fn delete_orphan_files(
    task_id: String,
    target: PathBuf,
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteOrphanResult, String> {
    let target =
        resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(target.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;

    let mut relative_paths: Vec<PathBuf> = Vec::new();
    let mut invalid_count = 0usize;
    for raw_path in paths {
        let candidate = PathBuf::from(&raw_path);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            invalid_count += 1;
            continue;
        }
        relative_paths.push(candidate);
    }

    // `delete_orphan_paths` only operates on `target`; source is intentionally unused here.
    let engine = SyncEngine::new(PathBuf::from("."), target);
    let mut result = engine
        .delete_orphan_paths(&relative_paths)
        .await
        .map_err(|e| format!("{:#}", e))?;
    result.skipped_count += invalid_count;

    state.log_manager.log_with_category(
        "info",
        &format!(
            "Orphan delete completed: files={}, dirs={}, total_deleted={}, skipped={}, failures={}",
            result.deleted_files_count,
            result.deleted_dirs_count,
            result.deleted_count,
            result.skipped_count,
            result.failures.len()
        ),
        Some(task_id.clone()),
        LogCategory::FileDeleted,
    );

    if !result.failures.is_empty() {
        state.log_manager.log_with_category(
            "warning",
            &format!("Orphan delete failures: {}", result.failures.len()),
            Some(task_id),
            LogCategory::Other,
        );
    } else {
        state.log_manager.log_with_category(
            "success",
            "Orphan delete completed without failures",
            Some(task_id),
            LogCategory::Other,
        );
    }

    Ok(result)
}

#[tauri::command]
async fn list_conflict_review_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConflictSessionSummary>, String> {
    Ok(list_conflict_session_summaries_internal(state.inner()).await)
}

#[tauri::command]
async fn get_conflict_review_session(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ConflictSessionDetail, String> {
    let sessions = state.conflict_review_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Conflict session not found: {session_id}"))?;
    Ok(to_conflict_detail(session))
}

#[tauri::command]
async fn open_conflict_review_window(
    session_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let sessions = state.conflict_review_sessions.read().await;
        if !sessions.contains_key(&session_id) {
            return Err(format!("Conflict session not found: {session_id}"));
        }
    }

    if let Some(window) = app.get_webview_window("conflict-review") {
        let _ = window.emit(
            "conflict-review-open-session",
            ConflictReviewOpenSessionEvent {
                session_id: session_id.clone(),
            },
        );
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?view=conflict-review&sessionId={session_id}").into());
    let window = WebviewWindowBuilder::new(&app, "conflict-review", url)
        .title("SyncWatcher - Conflict Review")
        .inner_size(1320.0, 900.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to open conflict review window: {e}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
async fn resolve_conflict_items(
    session_id: String,
    resolutions: Vec<ConflictResolutionRequest>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ConflictResolutionResult, String> {
    if resolutions.is_empty() {
        let pending_count = {
            let sessions = state.conflict_review_sessions.read().await;
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| format!("Conflict session not found: {session_id}"))?;
            pending_conflict_count(&session.items)
        };
        return Ok(ConflictResolutionResult {
            session_id,
            requested_count: 0,
            processed_count: 0,
            pending_count,
            failures: Vec::new(),
        });
    }

    {
        let sessions = state.conflict_review_sessions.read().await;
        if !sessions.contains_key(&session_id) {
            return Err(format!("Conflict session not found: {session_id}"));
        }
    }

    let mut processed_count = 0usize;
    let mut failures = Vec::new();

    for request in &resolutions {
        let item_snapshot = {
            let sessions = state.conflict_review_sessions.read().await;
            let Some(session) = sessions.get(&session_id) else {
                break;
            };
            session
                .items
                .iter()
                .find(|item| item.id == request.item_id)
                .cloned()
                .map(|item| (item, session.task_id.clone()))
        };

        let Some((item_snapshot, session_task_id)) = item_snapshot else {
            failures.push(ConflictResolutionFailure {
                item_id: request.item_id.clone(),
                message: "Conflict item not found".to_string(),
            });
            continue;
        };

        if item_snapshot.status != ConflictItemStatus::Pending {
            continue;
        }

        let source_path = PathBuf::from(&item_snapshot.source_path);
        let target_path = PathBuf::from(&item_snapshot.target_path);

        match (
            read_current_conflict_file_info(&source_path).await,
            read_current_conflict_file_info(&target_path).await,
        ) {
            (Ok(current_source), Ok(current_target)) => {
                let source_changed = conflict_file_info_changed(&item_snapshot.source, &current_source);
                let target_changed = conflict_file_info_changed(&item_snapshot.target, &current_target);
                if source_changed || target_changed {
                    state.log_manager.log_with_category(
                        "warning",
                        &format!(
                            "Conflict item changed since detection: {} (source_changed={}, target_changed={})",
                            item_snapshot.relative_path, source_changed, target_changed
                        ),
                        Some(session_task_id.clone()),
                        LogCategory::Other,
                    );
                }
            }
            (Err(source_err), Err(target_err)) => {
                state.log_manager.log_with_category(
                    "warning",
                    &format!(
                        "Conflict preflight metadata check failed for source and target ({}): source_error='{}', target_error='{}'",
                        item_snapshot.relative_path, source_err, target_err
                    ),
                    Some(session_task_id.clone()),
                    LogCategory::Other,
                );
            }
            (Err(source_err), _) => {
                state.log_manager.log_with_category(
                    "warning",
                    &format!(
                        "Conflict preflight metadata check failed for source ({}): {}",
                        item_snapshot.relative_path, source_err
                    ),
                    Some(session_task_id.clone()),
                    LogCategory::Other,
                );
            }
            (_, Err(target_err)) => {
                state.log_manager.log_with_category(
                    "warning",
                    &format!(
                        "Conflict preflight metadata check failed for target ({}): {}",
                        item_snapshot.relative_path, target_err
                    ),
                    Some(session_task_id.clone()),
                    LogCategory::Other,
                );
            }
        }

        let apply_result: Result<(ConflictItemStatus, Option<String>), String> = match request.action {
            ConflictResolutionAction::Skip => Ok((
                ConflictItemStatus::Skipped,
                Some("User chose to skip this conflict item.".to_string()),
            )),
            ConflictResolutionAction::ForceCopy => {
                copy_file_preserve(&source_path, &target_path)
                    .await
                    .map(|_| {
                        (
                            ConflictItemStatus::ForceCopied,
                            Some("Copied source file to target (force overwrite).".to_string()),
                        )
                    })
            }
            ConflictResolutionAction::RenameThenCopy => {
                let source_path = source_path.clone();
                let target_path = target_path.clone();
                let parent = match target_path.parent() {
                    Some(value) => value.to_path_buf(),
                    None => {
                        Err("Target file parent directory is invalid".to_string())?
                    }
                };
                tokio::fs::create_dir_all(&parent)
                    .await
                    .map_err(|e| format!("Failed to ensure target parent directory: {e}"))?;

                if tokio::fs::metadata(&target_path).await.is_err() {
                    Err("Target file does not exist for safe copy rename".to_string())?;
                }

                let file_name = source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file");
                let (stem, ext) = match file_name.rsplit_once('.') {
                    Some((left, right)) if !left.is_empty() && !right.is_empty() => {
                        (left.to_string(), Some(right.to_string()))
                    }
                    _ => (file_name.to_string(), None),
                };
                let timestamp = safe_copy_timestamp_label(item_snapshot.source.modified_unix_ms);

                let mut renamed_to: Option<PathBuf> = None;
                for attempt in 0..20u64 {
                    let seq = state.conflict_review_seq.fetch_add(1, Ordering::SeqCst) + 1;
                    let seed = (unix_now_ms() as u64)
                        .wrapping_add(seq)
                        .wrapping_add(attempt);
                    let suffix = random_suffix_token(seed);
                    let backup_name = if let Some(ext) = ext.as_deref() {
                        format!("{stem}_{timestamp}_{suffix}.{ext}")
                    } else {
                        format!("{stem}_{timestamp}_{suffix}")
                    };
                    let backup_path = parent.as_path().join(backup_name);
                    if tokio::fs::metadata(&backup_path).await.is_ok() {
                        continue;
                    }

                    tokio::fs::rename(&target_path, &backup_path)
                        .await
                        .map_err(|e| format!("Failed to rename target file: {e}"))?;
                    renamed_to = Some(backup_path);
                    break;
                }

                let renamed_to = match renamed_to {
                    Some(value) => value,
                    None => Err("Failed to generate non-conflicting backup file name".to_string())?,
                };

                copy_file_preserve(&source_path, &target_path)
                    .await
                    .map(|_| {
                        (
                            ConflictItemStatus::SafeCopied,
                            Some(format!(
                                "Renamed existing target to '{}' and copied source file.",
                                renamed_to.to_string_lossy()
                            )),
                        )
                    })
                    .map_err(|e| {
                        format!(
                            "Target was renamed to '{}' but source copy failed: {}",
                            renamed_to.to_string_lossy(),
                            e
                        )
                    })
            }
        };

        match apply_result {
            Ok((next_status, note)) => {
                processed_count += 1;
                let mut sessions = state.conflict_review_sessions.write().await;
                if let Some(session) = sessions.get_mut(&session_id) {
                    if let Some(item) = session
                        .items
                        .iter_mut()
                        .find(|item| item.id == request.item_id)
                    {
                        item.status = next_status;
                        item.note = note;
                        item.resolved_at_unix_ms = Some(unix_now_ms());
                    }
                }
            }
            Err(error) => {
                failures.push(ConflictResolutionFailure {
                    item_id: request.item_id.clone(),
                    message: error.clone(),
                });
                let mut sessions = state.conflict_review_sessions.write().await;
                if let Some(session) = sessions.get_mut(&session_id) {
                    if let Some(item) = session
                        .items
                        .iter_mut()
                        .find(|item| item.id == request.item_id)
                    {
                        item.note = Some(error);
                    }
                }
            }
        }
    }

    let pending_count = {
        let sessions = state.conflict_review_sessions.read().await;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Conflict session not found: {session_id}"))?;
        pending_conflict_count(&session.items)
    };

    emit_conflict_review_queue_changed(&app, state.inner()).await;
    let _ = app.emit(
        "conflict-review-session-updated",
        ConflictReviewSessionUpdatedEvent {
            session_id: session_id.clone(),
            pending_count,
        },
    );

    Ok(ConflictResolutionResult {
        session_id,
        requested_count: resolutions.len(),
        processed_count,
        pending_count,
        failures,
    })
}

#[tauri::command]
async fn close_conflict_review_session(
    session_id: String,
    force_skip_pending: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CloseConflictReviewSessionResult, String> {
    let mut sessions = state.conflict_review_sessions.write().await;
    let Some(session) = sessions.get_mut(&session_id) else {
        return Err(format!("Conflict session not found: {session_id}"));
    };

    let had_pending = pending_conflict_count(&session.items) > 0;
    if had_pending && !force_skip_pending {
        return Ok(CloseConflictReviewSessionResult {
            closed: false,
            had_pending: true,
            skipped_count: 0,
        });
    }

    let mut skipped_count = 0usize;
    if had_pending && force_skip_pending {
        for item in &mut session.items {
            if item.status == ConflictItemStatus::Pending {
                item.status = ConflictItemStatus::Skipped;
                item.note = Some("Skipped when session closed with pending items.".to_string());
                item.resolved_at_unix_ms = Some(unix_now_ms());
                skipped_count += 1;
            }
        }
    }

    sessions.remove(&session_id);
    drop(sessions);

    emit_conflict_review_queue_changed(&app, state.inner()).await;
    let _ = app.emit(
        "conflict-review-session-updated",
        ConflictReviewSessionUpdatedEvent {
            session_id,
            pending_count: 0,
        },
    );

    Ok(CloseConflictReviewSessionResult {
        closed: true,
        had_pending,
        skipped_count,
    })
}

#[tauri::command]
async fn get_conflict_item_preview(
    session_id: String,
    item_id: String,
    max_bytes: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<ConflictPreviewPayload, String> {
    let (source_path, target_path) = {
        let sessions = state.conflict_review_sessions.read().await;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Conflict session not found: {session_id}"))?;
        let item = session
            .items
            .iter()
            .find(|entry| entry.id == item_id)
            .ok_or_else(|| format!("Conflict item not found: {item_id}"))?;
        (item.source_path.clone(), item.target_path.clone())
    };

    let max_bytes = max_bytes.unwrap_or(64 * 1024).clamp(1024, 512 * 1024);
    let mut kind = preview_kind_for_path(&source_path).to_string();

    let mut source_text = None;
    let mut target_text = None;
    let mut source_truncated = false;
    let mut target_truncated = false;

    if kind == "text" {
        let (left, left_truncated) = read_text_preview(&source_path, max_bytes).await;
        let (right, right_truncated) = read_text_preview(&target_path, max_bytes).await;
        source_text = left;
        target_text = right;
        source_truncated = left_truncated;
        target_truncated = right_truncated;
        if source_text.is_none() || target_text.is_none() {
            kind = "other".to_string();
        }
    }

    Ok(ConflictPreviewPayload {
        kind,
        source_text,
        target_text,
        source_truncated,
        target_truncated,
    })
}

#[tauri::command]
fn list_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.list_volumes().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_removable_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.get_removable_volumes().map_err(|e| e.to_string())
}

/// Disk UUID로 현재 마운트된 볼륨의 경로를 찾습니다.
/// SD 카드 포맷 후 이름이 변경되어도 동일한 디바이스를 찾을 수 있습니다.
#[tauri::command]
fn resolve_path_by_uuid(disk_uuid: String) -> Result<std::path::PathBuf, String> {
    let monitor = DiskMonitor::new();
    let volumes = monitor.list_volumes().map_err(|e| e.to_string())?;

    for volume in volumes {
        if let Some(ref uuid) = volume.disk_uuid {
            if uuid == &disk_uuid {
                return Ok(volume.mount_point);
            }
        }
    }

    Err(format!("볼륨을 찾을 수 없습니다. UUID: {}", disk_uuid))
}

/// Removable 디스크를 언마운트합니다.
#[tauri::command]
async fn unmount_volume(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let resolved_path = resolve_path_with_uuid(path.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    DiskMonitor::unmount_volume(&resolved_path).map_err(|e| e.to_string())?;

    state.log_manager.log_with_category(
        "success",
        &format!("Volume unmounted: {}", resolved_path.display()),
        None,
        LogCategory::VolumeUnmounted,
    );

    Ok(())
}

#[tauri::command]
async fn start_sync(
    task_id: String,
    task_name: Option<String>,
    source: PathBuf,
    target: PathBuf,
    checksum_mode: bool,
    verify_after_copy: bool,
    exclude_patterns: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SyncExecutionResult, String> {
    let result = execute_sync_internal(
        task_id,
        task_name.unwrap_or_else(|| "Manual Sync".to_string()),
        source,
        target,
        checksum_mode,
        verify_after_copy,
        exclude_patterns,
        app,
        state.inner().clone(),
        false,
        SyncOrigin::Manual,
    )
    .await?;

    Ok(result)
}

#[tauri::command]
async fn list_sync_tasks() -> Result<Vec<SyncTask>, String> {
    Ok(vec![])
}

/// 실행 중인 동기화 작업을 취소합니다.
#[tauri::command]
async fn cancel_operation(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let tokens = state.cancel_tokens.read().await;
    if let Some(token) = tokens.get(&task_id) {
        token.cancel();
        state
            .log_manager
            .log("warning", "Operation cancelled by user", Some(task_id));
        Ok(true)
    } else {
        Ok(false) // 해당 task_id로 실행 중인 작업 없음
    }
}

/// 파일 시스템 감시를 시작합니다.
#[tauri::command]
async fn start_watch(
    task_id: String,
    source_path: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let started_task_id = task_id.clone();
    let _ = start_watch_internal(
        task_id,
        source_path,
        app.clone(),
        state.inner().clone(),
        false,
    )
    .await?;
    emit_runtime_watch_state(&app, &started_task_id, true, None);
    Ok(())
}

/// 파일 시스템 감시를 중지합니다.
#[tauri::command]
async fn stop_watch(
    task_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut sources = state.runtime_watch_sources.write().await;
        sources.remove(&task_id);
    }
    {
        let mut queued = state.queued_sync_tasks.write().await;
        queued.remove(&task_id);
    }
    {
        let mut queue = state.runtime_sync_queue.write().await;
        queue.retain(|queued_task_id| queued_task_id != &task_id);
    }

    let mut manager = state.watcher_manager.write().await;
    manager
        .stop_watching(&task_id)
        .map_err(|e| format!("{}:{}", error_codes::ERR_WATCH_STOP_FAILED, e))?;

    state.log_manager.log_with_category(
        "info",
        "Watch stopped",
        Some(task_id.clone()),
        LogCategory::WatchStopped,
    );
    emit_runtime_sync_queue_state(
        &app,
        &task_id,
        false,
        Some("Watch manually stopped".to_string()),
    );
    emit_runtime_watch_state(&app, &task_id, false, None);
    Ok(())
}

/// 현재 감시 중인 Task 목록을 반환합니다.
#[tauri::command]
async fn get_watching_tasks(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.watcher_manager.read().await;
    Ok(manager.get_watching_tasks())
}

#[tauri::command]
async fn runtime_set_config(
    payload: RuntimeConfigPayload,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<RuntimeState, String> {
    validate_runtime_tasks(&payload.tasks)?;

    for set in &payload.exclusion_sets {
        input_validation::validate_exclude_patterns(&set.patterns).map_err(|e| e.to_string())?;
    }

    {
        let mut config = state.runtime_config.write().await;
        *config = payload;
    }

    reconcile_runtime_watchers(app.clone(), state.inner().clone()).await?;

    if state
        .runtime_initial_watch_bootstrapped
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        enqueue_initial_runtime_watch_syncs(app.clone(), state.inner().clone()).await;
    }

    Ok(runtime_get_state_internal(state.inner()).await)
}

#[tauri::command]
async fn runtime_validate_tasks(tasks: Vec<RuntimeSyncTask>) -> Result<(), String> {
    validate_runtime_tasks(&tasks)
}

#[tauri::command]
async fn runtime_get_state(state: tauri::State<'_, AppState>) -> Result<RuntimeState, String> {
    Ok(runtime_get_state_internal(state.inner()).await)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncTask {
    pub id: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub enabled: bool,
}

#[derive(Debug, Copy, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DataUnitSystem {
    #[default]
    Binary,
    Decimal,
}

pub fn format_bytes(bytes: u64) -> String {
    format_bytes_with_unit(bytes, DataUnitSystem::Binary)
}

pub fn format_bytes_with_unit(bytes: u64, unit_system: DataUnitSystem) -> String {
    let (base, units): (f64, &[&str]) = match unit_system {
        DataUnitSystem::Binary => (1024.0, &["B", "KiB", "MiB", "GiB", "TiB", "PiB"]),
        DataUnitSystem::Decimal => (1000.0, &["B", "KB", "MB", "GB", "TB", "PB"]),
    };

    if bytes < base as u64 {
        return format!("{} B", format_number(bytes));
    }

    let exp = ((bytes as f64).ln() / base.ln()).floor() as usize;
    let unit_index = exp.min(units.len() - 1);
    let value = bytes as f64 / base.powi(unit_index as i32);
    format!("{value:.2} {}", units[unit_index])
}

pub fn format_number(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    let mut count = 0;
    for c in s.chars().rev() {
        if count > 0 && count % 3 == 0 {
            result.push(',');
        }
        result.push(c);
        count += 1;
    }
    result.chars().rev().collect()
}

/// Mac 알림 센터에 알림을 보냅니다.
#[tauri::command]
async fn send_notification(
    title: String,
    body: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("알림 전송 실패: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn hide_to_background(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn restore_main_window_from_tray(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[Tray] Main window not found");
        return;
    };

    #[cfg(target_os = "macos")]
    {
        if let Err(err) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            eprintln!("[Tray] Failed to set activation policy: {}", err);
        }
    }

    if let Err(err) = window.show() {
        eprintln!("[Tray] Failed to show main window: {}", err);
    }
    if let Err(err) = window.unminimize() {
        eprintln!("[Tray] Failed to unminimize main window: {}", err);
    }
    if let Err(err) = window.set_focus() {
        eprintln!("[Tray] Failed to focus main window: {}", err);
    }
}

fn adjust_window_if_mostly_offscreen(window: &WebviewWindow) -> tauri::Result<()> {
    let window_position = window.outer_position()?;
    let window_size = window.outer_size()?;
    let monitors = window.available_monitors()?;

    if monitors.is_empty() || window_size.width == 0 || window_size.height == 0 {
        return Ok(());
    }

    let window_left = i64::from(window_position.x);
    let window_top = i64::from(window_position.y);
    let window_right = window_left + i64::from(window_size.width);
    let window_bottom = window_top + i64::from(window_size.height);
    let window_area = u64::from(window_size.width) * u64::from(window_size.height);

    let mut max_visible_area: u64 = 0;
    let mut position_inside_any_work_area = false;

    for monitor in &monitors {
        let work_area = monitor.work_area();
        let area_left = i64::from(work_area.position.x);
        let area_top = i64::from(work_area.position.y);
        let area_right = area_left + i64::from(work_area.size.width);
        let area_bottom = area_top + i64::from(work_area.size.height);

        if window_left >= area_left
            && window_left < area_right
            && window_top >= area_top
            && window_top < area_bottom
        {
            position_inside_any_work_area = true;
        }

        let visible_width = (window_right.min(area_right) - window_left.max(area_left)).max(0);
        let visible_height = (window_bottom.min(area_bottom) - window_top.max(area_top)).max(0);
        let visible_area = (visible_width as u64) * (visible_height as u64);

        if visible_area > max_visible_area {
            max_visible_area = visible_area;
        }
    }

    let visible_ratio = max_visible_area as f64 / window_area as f64;
    let should_reposition = !position_inside_any_work_area || visible_ratio < 0.5;

    if !should_reposition {
        return Ok(());
    }

    let target_monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?)
        .or_else(|| monitors.first().cloned());

    if let Some(monitor) = target_monitor {
        let new_width = ((monitor.work_area().size.width as f64) * 0.4).round() as u32;
        let new_height = ((monitor.work_area().size.height as f64) * 0.7).round() as u32;
        window.set_size(Size::Physical(PhysicalSize::new(
            new_width.max(320),
            new_height.max(200),
        )))?;
        window.center()?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_log_manager = Arc::new(LogManager::new(DEFAULT_MAX_LOG_LINES));
    let setup_log_manager = shared_log_manager.clone();
    let managed_log_manager = shared_log_manager;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // 윈도우 위치 조정
            if let Some(main_window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _ = adjust_window_if_mostly_offscreen(&main_window);
                });
            }

            // System Tray
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let open_i =
                    MenuItem::with_id(app, "tray_open", "SyncWatcher 열기", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "tray_quit", "끝내기", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

                let mut tray_builder = TrayIconBuilder::new()
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("SyncWatcher");

                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }

                tray_builder
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray_open" => {
                            restore_main_window_from_tray(app);
                        }
                        "tray_quit" => {
                            let _ = app.emit("tray-quit-requested", ());
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            restore_main_window_from_tray(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // main window close intercept
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = app_handle.emit("close-requested", ());
                    }
                });
            }

            // /Volumes 디렉토리 감시 시작 (볼륨 마운트/언마운트 감지)
            let app_handle = app.handle().clone();
            let volume_log_manager = setup_log_manager.clone();
            std::thread::spawn(move || {
                use std::panic::{catch_unwind, AssertUnwindSafe};

                let result = catch_unwind(AssertUnwindSafe(|| {
                    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
                    use std::sync::mpsc::{channel, RecvTimeoutError};
                    use std::time::Duration as StdDuration;

                    let removable_mounts = || -> HashSet<String> {
                        match DiskMonitor::new().get_removable_volumes() {
                            Ok(volumes) => volumes
                                .into_iter()
                                .filter_map(|volume| {
                                    volume.mount_point.to_str().map(|path| path.to_string())
                                })
                                .collect(),
                            Err(err) => {
                                eprintln!(
                                    "[VolumesWatcher] Failed to list removable volumes: {}",
                                    err
                                );
                                HashSet::new()
                            }
                        }
                    };

                    let mut previous_removable_mounts = removable_mounts();

                    let (tx, rx) = channel();
                    let config = Config::default().with_poll_interval(StdDuration::from_secs(2));

                    let mut watcher: RecommendedWatcher = match notify::Watcher::new(tx, config) {
                        Ok(w) => w,
                        Err(e) => {
                            eprintln!("[VolumesWatcher] Failed to create watcher: {}", e);
                            return;
                        }
                    };

                    if let Err(e) = watcher.watch(
                        std::path::Path::new("/Volumes"),
                        RecursiveMode::NonRecursive,
                    ) {
                        eprintln!("[VolumesWatcher] Failed to watch /Volumes: {}", e);
                        return;
                    }

                    println!("[VolumesWatcher] Started watching /Volumes");

                    let debounce_duration = StdDuration::from_millis(500);
                    let mut emit_state = VolumeEmitDebounceState::new();

                    let mut refresh_and_emit = || {
                        let current_removable_mounts = removable_mounts();
                        let (mounted, unmounted) = compute_volume_mount_diff(
                            &previous_removable_mounts,
                            &current_removable_mounts,
                        );

                        for mount_path in mounted {
                            volume_log_manager.log_with_category(
                                "info",
                                &format!("Volume mounted: {}", mount_path),
                                None,
                                LogCategory::VolumeMounted,
                            );
                        }

                        for mount_path in unmounted {
                            volume_log_manager.log_with_category(
                                "info",
                                &format!("Volume unmounted: {}", mount_path),
                                None,
                                LogCategory::VolumeUnmounted,
                            );
                        }

                        previous_removable_mounts = current_removable_mounts;
                        let _ = app_handle.emit("volumes-changed", ());
                    };

                    loop {
                        let now = Instant::now();
                        let next_tick = volume_watch_next_tick_delay(&emit_state, now, debounce_duration);

                        if let Some(delay) = next_tick {
                            if delay.is_zero() {
                                if handle_volume_watch_tick(
                                    &mut emit_state,
                                    now,
                                    debounce_duration,
                                ) {
                                    refresh_and_emit();
                                }
                                continue;
                            }
                        }

                        let recv_result = if let Some(delay) = next_tick {
                            rx.recv_timeout(delay)
                        } else {
                            match rx.recv() {
                                Ok(value) => Ok(value),
                                Err(_) => Err(RecvTimeoutError::Disconnected),
                            }
                        };

                        match recv_result {
                            Ok(Ok(_event)) => {
                                if handle_volume_watch_event(
                                    &mut emit_state,
                                    Instant::now(),
                                    debounce_duration,
                                ) {
                                    refresh_and_emit();
                                }
                            }
                            Ok(Err(e)) => {
                                eprintln!("[VolumesWatcher] Watch error: {}", e);
                            }
                            Err(RecvTimeoutError::Timeout) => {
                                if handle_volume_watch_tick(
                                    &mut emit_state,
                                    Instant::now(),
                                    debounce_duration,
                                ) {
                                    refresh_and_emit();
                                }
                            }
                            Err(RecvTimeoutError::Disconnected) => {
                                break;
                            }
                        }
                    }
                }));

                if let Err(e) = result {
                    let msg = if let Some(s) = e.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = e.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "Unknown panic".to_string()
                    };
                    eprintln!("[VolumesWatcher] Thread panicked: {}", msg);
                }
            });

            Ok(())
        })
        .manage(AppState {
            log_manager: managed_log_manager,
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
            runtime_config: Arc::new(RwLock::new(RuntimeConfigPayload::default())),
            syncing_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_sync_queue: Arc::new(RwLock::new(VecDeque::new())),
            queued_sync_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_dispatcher_running: Arc::new(Mutex::new(false)),
            runtime_sync_slot_released: Arc::new(Notify::new()),
            runtime_initial_watch_bootstrapped: Arc::new(AtomicBool::new(false)),
            runtime_watch_sources: Arc::new(RwLock::new(HashMap::new())),
            conflict_review_sessions: Arc::new(RwLock::new(HashMap::new())),
            conflict_review_seq: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            sync_dry_run,
            find_orphan_files,
            delete_orphan_files,
            list_conflict_review_sessions,
            get_conflict_review_session,
            open_conflict_review_window,
            resolve_conflict_items,
            close_conflict_review_session,
            get_conflict_item_preview,
            list_volumes,
            get_removable_volumes,
            resolve_path_by_uuid,
            unmount_volume,
            start_sync,
            list_sync_tasks,
            cancel_operation,
            send_notification,
            hide_to_background,
            quit_app,
            start_watch,
            stop_watch,
            get_watching_tasks,
            runtime_set_config,
            runtime_validate_tasks,
            runtime_get_state,
            get_app_config_dir,
            join_paths,
            read_yaml_file,
            write_yaml_file,
            ensure_directory_exists,
            file_exists,
            open_in_editor,
            add_log,
            get_system_logs,
            get_task_logs,
            generate_licenses_report,
            license_validation::activate_license_key,
            license_validation::validate_license_key,
            license_validation::get_license_status,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
                let _ = app_handle.emit("close-requested", ());
            }
        }
    });
}
