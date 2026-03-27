pub mod config_store;
pub mod control_plane;
pub mod error_codes;
pub mod input_validation;
pub mod license;
pub mod license_validation;
pub mod logging;
pub mod mcp_jobs;
pub mod path_validation;
pub mod sync_engine;
pub mod system_integration;
pub mod watcher;

#[cfg(test)]
mod lib_tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalSize, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;

use sync_engine::{
    types::{
        DeleteOrphanResult, DryRunPhase, DryRunProgress, DryRunSummary, FileDiff, OrphanFile,
        SyncResult, TargetNewerConflictCandidate, TargetPreflightInfo, TargetPreflightKind,
    },
    DryRunResult, SyncEngine, SyncOptions,
};
use system_integration::DiskMonitor;

use config_store::{
    apply_sync_task_update, build_sync_task_record, default_config_dir,
    default_exclusion_set_records, settings_snapshot_from_store, validate_exclusion_sets,
    AppSettings, ConfigStore, ConfigStoreChangedEvent, DeleteResultEnvelope, ExclusionSetEnvelope,
    ExclusionSetRecord, ExclusionSetsEnvelope, McpSettingsPatch, NewSyncTaskRecord,
    SettingsEnvelope, SourceIdentitySnapshot, SyncTaskEnvelope, SyncTaskRecord, SyncTasksEnvelope,
    UpdateSettingsPayload, UpdateSyncTaskRequest,
};
use control_plane::{ControlPlaneHandle, ControlPlaneRequest, ControlPlaneResponse};
use license::generate_licenses_report;
use logging::LogManager;
use logging::{add_log, get_system_logs, get_task_logs, LogCategory, DEFAULT_MAX_LOG_LINES};
use mcp_jobs::{McpJobKind, McpJobProgress, McpJobRecord, McpJobRegistry, McpJobStatus};

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

const DRY_RUN_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const DRY_RUN_DIFF_BATCH_EMIT_INTERVAL: Duration = Duration::from_millis(200);
const DRY_RUN_DIFF_BATCH_MAX_SIZE: usize = 50;

struct DryRunLiveStateInner {
    last_progress_emit_at: Instant,
    pending_diff_since: Option<Instant>,
    pending_diffs: Vec<FileDiff>,
    latest_progress: Option<DryRunProgress>,
}

impl DryRunLiveStateInner {
    fn new() -> Self {
        Self {
            last_progress_emit_at: Instant::now() - DRY_RUN_PROGRESS_EMIT_INTERVAL,
            pending_diff_since: None,
            pending_diffs: Vec::with_capacity(DRY_RUN_DIFF_BATCH_MAX_SIZE),
            latest_progress: None,
        }
    }
}

#[derive(Clone)]
struct DryRunLiveState {
    inner: Arc<StdMutex<DryRunLiveStateInner>>,
}

impl DryRunLiveState {
    fn new() -> Self {
        Self {
            inner: Arc::new(StdMutex::new(DryRunLiveStateInner::new())),
        }
    }

    fn record_progress(
        &self,
        progress: DryRunProgress,
        now: Instant,
    ) -> (
        Option<DryRunProgress>,
        Option<(Vec<FileDiff>, DryRunProgress)>,
    ) {
        let Ok(mut state) = self.inner.lock() else {
            return (None, None);
        };

        state.latest_progress = Some(progress.clone());

        let batch = if let Some(pending_since) = state.pending_diff_since {
            if now.duration_since(pending_since) >= DRY_RUN_DIFF_BATCH_EMIT_INTERVAL
                && !state.pending_diffs.is_empty()
            {
                state.pending_diff_since = None;
                Some((
                    std::mem::replace(
                        &mut state.pending_diffs,
                        Vec::with_capacity(DRY_RUN_DIFF_BATCH_MAX_SIZE),
                    ),
                    progress.clone(),
                ))
            } else {
                None
            }
        } else {
            None
        };

        let should_emit_progress =
            now.duration_since(state.last_progress_emit_at) >= DRY_RUN_PROGRESS_EMIT_INTERVAL;
        let emitted_progress = if should_emit_progress {
            state.last_progress_emit_at = now;
            Some(progress)
        } else {
            None
        };

        (emitted_progress, batch)
    }

    fn record_diff(
        &self,
        diff: FileDiff,
        progress: DryRunProgress,
        now: Instant,
    ) -> Option<(Vec<FileDiff>, DryRunProgress)> {
        let Ok(mut state) = self.inner.lock() else {
            return None;
        };

        state.latest_progress = Some(progress.clone());
        if state.pending_diffs.is_empty() {
            state.pending_diff_since = Some(now);
        }

        state.pending_diffs.push(diff);

        if state.pending_diffs.len() >= DRY_RUN_DIFF_BATCH_MAX_SIZE {
            state.pending_diff_since = None;
            return Some((
                std::mem::replace(
                    &mut state.pending_diffs,
                    Vec::with_capacity(DRY_RUN_DIFF_BATCH_MAX_SIZE),
                ),
                progress,
            ));
        }

        None
    }

    fn flush_pending_diffs(
        &self,
        progress: DryRunProgress,
    ) -> Option<(Vec<FileDiff>, DryRunProgress)> {
        let Ok(mut state) = self.inner.lock() else {
            return None;
        };

        if state.pending_diffs.is_empty() {
            return None;
        }

        state.pending_diff_since = None;
        Some((
            std::mem::replace(
                &mut state.pending_diffs,
                Vec::with_capacity(DRY_RUN_DIFF_BATCH_MAX_SIZE),
            ),
            progress,
        ))
    }

    fn latest_progress(&self) -> Option<DryRunProgress> {
        let Ok(state) = self.inner.lock() else {
            return None;
        };

        state.latest_progress.clone()
    }
}

#[derive(Clone)]
pub struct AppState {
    config_store: Arc<ConfigStore>,
    log_manager: Arc<LogManager>,
    /// 현재 실행 중인 작업들의 취소 토큰 맵 (task_id -> CancellationToken)
    cancel_tokens: Arc<RwLock<HashMap<String, CancellationToken>>>,
    /// 현재 실행 중인 dry-run 작업들의 취소 토큰 맵 (task_id -> CancellationToken)
    dry_run_cancel_tokens: Arc<RwLock<HashMap<String, CancellationToken>>>,
    /// 현재 실행 중인 dry-run task 집합
    dry_running_tasks: Arc<RwLock<HashSet<String>>>,
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
    /// syncing 중 추가 변경이 감지된 태스크 집합 (1회 재실행 보장)
    runtime_pending_sync_tasks: Arc<RwLock<HashSet<String>>>,
    /// 런타임 큐 디스패처 실행 여부
    runtime_dispatcher_running: Arc<Mutex<bool>>,
    /// 런타임 큐 디스패처 재평가 알림
    runtime_dispatcher_wakeup: Arc<Notify>,
    /// 런타임 동기화 슬롯 해제 알림
    runtime_sync_slot_released: Arc<Notify>,
    /// watched source downstream release settle deadline
    runtime_chain_settle_until: Arc<RwLock<HashMap<String, Instant>>>,
    /// 현재 target path에 write 중인 producer 집합
    runtime_active_producers: Arc<RwLock<HashMap<String, RuntimeActiveProducer>>>,
    /// 초기 watchMode 일괄 동기화 실행 여부
    runtime_initial_watch_bootstrapped: Arc<AtomicBool>,
    /// runtime config 적용 직렬화 락 (last-write-wins 보장)
    runtime_config_apply_lock: Arc<Mutex<()>>,
    /// 런타임이 관리 중인 watcher source 추적 (task_id -> source)
    runtime_watch_sources: Arc<RwLock<HashMap<String, String>>>,
    /// auto-unmount 세션 비활성화 task 집합 (앱 재시작 시 초기화)
    auto_unmount_session_disabled_tasks: Arc<RwLock<HashSet<String>>>,
    /// 타겟 최신 파일 충돌 검토 세션
    conflict_review_sessions: Arc<RwLock<HashMap<String, ConflictReviewSession>>>,
    /// 충돌 세션/랜덤 토큰 생성 시퀀스
    conflict_review_seq: Arc<AtomicU64>,
    /// task 단위의 상호배타 operation 락
    active_task_operations: Arc<RwLock<HashMap<String, TaskOperationKind>>>,
    /// 로컬 MCP control plane listener 상태
    control_plane_handle: Arc<Mutex<Option<ControlPlaneHandle>>>,
    /// MCP 장기 작업 상태 저장소
    mcp_jobs: Arc<McpJobRegistry>,
    /// MCP job id 시퀀스
    mcp_job_seq: Arc<AtomicU64>,
}

#[derive(Default)]
struct AppExitControl {
    allow_force_exit: AtomicBool,
}

const AUTOSTART_ARG: &str = "--autostart";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutostartLaunchDecision {
    pub argv_present: bool,
    pub autolaunch_enabled: Option<bool>,
    pub hidden_start_accepted: bool,
    pub reject_reason: Option<&'static str>,
    pub status_error: Option<String>,
}

impl AutostartLaunchDecision {
    fn hidden_start_status(&self) -> &'static str {
        if self.hidden_start_accepted {
            "accepted"
        } else if self.argv_present {
            "rejected"
        } else {
            "not_requested"
        }
    }
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    watching_tasks: Vec<String>,
    syncing_tasks: Vec<String>,
    queued_tasks: Vec<String>,
    dry_running_tasks: Vec<String>,
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDryRunStateEvent {
    task_id: String,
    dry_running: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DryRunProgressEvent {
    task_id: String,
    phase: DryRunPhase,
    message: String,
    current: u64,
    total: u64,
    processed_bytes: u64,
    total_bytes: u64,
    summary: DryRunSummary,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DryRunDiffBatchEvent {
    task_id: String,
    phase: DryRunPhase,
    message: String,
    summary: DryRunSummary,
    diffs: Vec<FileDiff>,
    #[serde(rename = "targetPreflight")]
    target_preflight: Option<TargetPreflightInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeAutoUnmountRequestEvent {
    task_id: String,
    task_name: String,
    source: String,
    files_copied: u64,
    bytes_copied: u64,
    reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskOperationKind {
    Sync,
    DryRun,
    OrphanScan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigStoreScopeKind {
    Settings,
    SyncTasks,
    ExclusionSets,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigStoreFileScope {
    Settings,
    SyncTasks,
    ExclusionSets,
}

impl ConfigStoreFileScope {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "settings" => Ok(Self::Settings),
            "syncTasks" => Ok(Self::SyncTasks),
            "exclusionSets" => Ok(Self::ExclusionSets),
            _ => Err(format!("Unsupported config store scope: {value}")),
        }
    }

    fn event_scope(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::SyncTasks => "syncTasks",
            Self::ExclusionSets => "exclusionSets",
        }
    }

    fn file_path(self, store: &ConfigStore) -> PathBuf {
        match self {
            Self::Settings => store.settings_file_path(),
            Self::SyncTasks => store.tasks_file_path(),
            Self::ExclusionSets => store.exclusion_sets_file_path(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum CloseRequestSource {
    WindowClose,
    CmdQuit,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedEvent {
    source: CloseRequestSource,
}

const APP_CHECK_FOR_UPDATES_MENU_ID: &str = "app-check-for-updates";
const APP_CHECK_FOR_UPDATES_EVENT: &str = "app-check-for-updates-requested";

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
    target_preflight: Option<TargetPreflightInfo>,
}

#[derive(Debug, Clone)]
struct ValidatedRuntimeTask {
    id: String,
    name: String,
    source_key: String,
    target_key: String,
    watch_mode: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RuntimeTaskValidationCode {
    SourceTargetOverlap,
    DuplicateTarget,
    TargetSubdirConflict,
    WatchCycle,
    InvalidInput,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeTaskValidationIssue {
    code: RuntimeTaskValidationCode,
    task_id: Option<String>,
    task_name: Option<String>,
    conflicting_task_ids: Vec<String>,
    conflicting_task_names: Vec<String>,
    source: Option<String>,
    target: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeTaskValidationResult {
    ok: bool,
    issue: Option<RuntimeTaskValidationIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeProducerKind {
    WatchSync,
    ManualSync,
    ConflictForceCopy,
    ConflictRenameThenCopy,
}

#[derive(Debug, Clone)]
struct RuntimeActiveProducer {
    producer_id: String,
    kind: RuntimeProducerKind,
    target_key: String,
}

#[derive(Debug, Clone)]
struct RuntimeDispatchSelection {
    candidate_task_id: Option<String>,
    next_deadline: Option<Instant>,
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
const RUNTIME_DOWNSTREAM_SETTLE_WINDOW: Duration = Duration::from_millis(500);

fn default_verify_after_copy() -> bool {
    true
}

fn default_data_unit_system() -> DataUnitSystem {
    DataUnitSystem::Binary
}

fn is_uuid_source(source: &str, source_type: Option<config_store::SyncTaskSourceType>) -> bool {
    match source_type {
        Some(config_store::SyncTaskSourceType::Uuid) => true,
        Some(config_store::SyncTaskSourceType::Path) => false,
        None => has_uuid_source_prefix(source),
    }
}

fn normalize_sync_task_record(mut task: SyncTaskRecord) -> SyncTaskRecord {
    if matches!(
        task.source_type.clone(),
        Some(config_store::SyncTaskSourceType::Path) | None
    ) {
        task.source_uuid = None;
        task.source_uuid_type = None;
        task.source_sub_path = None;
        task.source_identity = None;
    }

    task.auto_unmount = task.auto_unmount
        && task.watch_mode
        && is_uuid_source(&task.source, task.source_type.clone());
    task
}

fn to_runtime_task_record(task: &SyncTaskRecord) -> RuntimeSyncTask {
    RuntimeSyncTask {
        id: task.id.clone(),
        name: task.name.clone(),
        source: task.source.clone(),
        target: task.target.clone(),
        checksum_mode: task.checksum_mode,
        watch_mode: task.watch_mode,
        auto_unmount: task.auto_unmount && is_uuid_source(&task.source, task.source_type.clone()),
        verify_after_copy: task.verify_after_copy,
        exclusion_sets: task.exclusion_sets.clone(),
    }
}

fn to_runtime_exclusion_set_record(set: &ExclusionSetRecord) -> RuntimeExclusionSet {
    RuntimeExclusionSet {
        id: set.id.clone(),
        name: set.name.clone(),
        patterns: set.patterns.clone(),
    }
}

fn to_runtime_settings_record(settings: &AppSettings) -> RuntimeSettings {
    RuntimeSettings {
        data_unit_system: settings.data_unit_system,
    }
}

fn validate_settings_record(settings: &AppSettings) -> Result<(), String> {
    if settings.language.trim().is_empty() {
        return Err("Settings.language cannot be empty".to_string());
    }

    if !(100..=100_000).contains(&settings.max_log_lines) {
        return Err("Settings.maxLogLines must be between 100 and 100000".to_string());
    }

    Ok(())
}

fn validate_sync_task_records(tasks: &[SyncTaskRecord]) -> Result<(), String> {
    for task in tasks {
        if task.name.trim().is_empty() {
            return Err("Task name cannot be empty".to_string());
        }
    }

    let runtime_tasks: Vec<RuntimeSyncTask> = tasks.iter().map(to_runtime_task_record).collect();
    validate_runtime_tasks(&runtime_tasks)
}

fn config_store_error_to_string(error: config_store::ConfigStoreError) -> String {
    error.to_tauri_error_string()
}

async fn current_settings_snapshot(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<config_store::SettingsSnapshot, String> {
    let settings = state
        .config_store
        .load_settings()
        .map_err(config_store_error_to_string)?;
    settings_snapshot_from_store(app, settings)
        .await
        .map_err(config_store_error_to_string)
}

fn emit_config_store_changed(app: &tauri::AppHandle, scopes: &[&str]) {
    let _ = app.emit(
        "config-store-changed",
        &ConfigStoreChangedEvent {
            scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
        },
    );
}

fn config_store_scope_for_path(path: &Path, state: &AppState) -> Option<ConfigStoreScopeKind> {
    let settings_path = state.config_store.settings_file_path();
    if path == settings_path.as_path() {
        return Some(ConfigStoreScopeKind::Settings);
    }

    let tasks_path = state.config_store.tasks_file_path();
    if path == tasks_path.as_path() {
        return Some(ConfigStoreScopeKind::SyncTasks);
    }

    let exclusion_sets_path = state.config_store.exclusion_sets_file_path();
    if path == exclusion_sets_path.as_path() {
        return Some(ConfigStoreScopeKind::ExclusionSets);
    }

    None
}

async fn apply_config_write_side_effects(
    path: &Path,
    app: tauri::AppHandle,
    state: AppState,
) -> Result<(), String> {
    let Some(scope) = config_store_scope_for_path(path, &state) else {
        return Ok(());
    };

    let _ = apply_canonical_config_to_runtime(app.clone(), state.clone()).await?;

    match scope {
        ConfigStoreScopeKind::Settings => {
            let settings = state
                .config_store
                .load_settings()
                .map_err(config_store_error_to_string)?;
            emit_config_store_changed(&app, &["settings"]);
            sync_control_plane_listener(app, state, settings.mcp_enabled).await?;
        }
        ConfigStoreScopeKind::SyncTasks => {
            emit_config_store_changed(&app, &["syncTasks"]);
        }
        ConfigStoreScopeKind::ExclusionSets => {
            emit_config_store_changed(&app, &["exclusionSets"]);
        }
    }

    Ok(())
}

fn validate_repaired_config_store_file(
    scope: ConfigStoreFileScope,
    content: &str,
) -> Result<(), String> {
    match scope {
        ConfigStoreFileScope::Settings => {
            let settings = serde_yaml::from_str::<AppSettings>(content)
                .map_err(|error| format!("Invalid settings.yaml content: {error}"))?;
            validate_settings_record(&settings)
        }
        ConfigStoreFileScope::SyncTasks => {
            let tasks = serde_yaml::from_str::<Vec<SyncTaskRecord>>(content)
                .map_err(|error| format!("Invalid tasks.yaml content: {error}"))?;
            validate_sync_task_records(&tasks)
        }
        ConfigStoreFileScope::ExclusionSets => {
            let sets = serde_yaml::from_str::<Vec<ExclusionSetRecord>>(content)
                .map_err(|error| format!("Invalid exclusion_sets.yaml content: {error}"))?;
            validate_exclusion_sets(&sets).map_err(config_store_error_to_string)
        }
    }
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

fn emit_runtime_dry_run_state(
    app: &tauri::AppHandle,
    task_id: &str,
    dry_running: bool,
    reason: Option<String>,
) {
    let event = RuntimeDryRunStateEvent {
        task_id: task_id.to_string(),
        dry_running,
        reason,
    };
    let _ = app.emit("runtime-dry-run-state", &event);
}

fn emit_dry_run_progress(app: &tauri::AppHandle, event: &DryRunProgressEvent) {
    let _ = app.emit("dry-run-progress", event);
}

fn emit_dry_run_diff_batch(app: &tauri::AppHandle, event: &DryRunDiffBatchEvent) {
    let _ = app.emit("dry-run-diff-batch", event);
}

fn dry_run_progress_event(task_id: &str, progress: &DryRunProgress) -> DryRunProgressEvent {
    DryRunProgressEvent {
        task_id: task_id.to_string(),
        phase: progress.phase.clone(),
        message: progress.message.clone(),
        current: progress.current,
        total: progress.total,
        processed_bytes: progress.processed_bytes,
        total_bytes: progress.total_bytes,
        summary: progress.summary.clone(),
    }
}

fn mcp_progress_from_dry_run(progress: &DryRunProgress) -> McpJobProgress {
    McpJobProgress {
        message: Some(progress.message.clone()),
        current: progress.current,
        total: progress.total,
        processed_bytes: progress.processed_bytes,
        total_bytes: progress.total_bytes,
        current_file_bytes_copied: 0,
        current_file_total_bytes: 0,
    }
}

fn emit_runtime_auto_unmount_request(
    app: &tauri::AppHandle,
    task_id: &str,
    task_name: &str,
    source: &str,
    files_copied: u64,
    bytes_copied: u64,
    reason: &str,
) {
    let event = RuntimeAutoUnmountRequestEvent {
        task_id: task_id.to_string(),
        task_name: task_name.to_string(),
        source: source.to_string(),
        files_copied,
        bytes_copied,
        reason: reason.to_string(),
    };
    let _ = app.emit("runtime-auto-unmount-request", &event);
}

fn emit_close_requested(app: &tauri::AppHandle, source: CloseRequestSource) {
    let event = CloseRequestedEvent { source };
    let _ = app.emit("close-requested", &event);
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

async fn list_conflict_session_summaries_internal(state: &AppState) -> Vec<ConflictSessionSummary> {
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

    let image_ext = [
        "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic",
    ];
    let video_ext = ["mp4", "mov", "m4v", "avi", "mkv", "webm"];
    let text_ext = [
        "txt", "md", "json", "yaml", "yml", "toml", "xml", "log", "rs", "ts", "tsx", "js", "jsx",
        "css", "html", "csv", "ini",
    ];
    let document_ext = [
        "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "pages", "numbers", "key",
    ];

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

fn uuid_token_prefix(token_type: UuidTokenType) -> &'static str {
    match token_type {
        UuidTokenType::Disk => "[DISK_UUID:",
        UuidTokenType::Volume => "[VOLUME_UUID:",
        UuidTokenType::Legacy => "[UUID:",
    }
}

fn normalize_uuid_sub_path(sub_path: &str) -> Result<String, String> {
    let trimmed = sub_path.trim();
    if trimmed.is_empty() {
        return Ok("/".to_string());
    }

    let with_leading = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    };

    let mut normalized = with_leading;
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }

    for component in Path::new(&normalized).components() {
        if matches!(component, Component::ParentDir) {
            return Err(
                "UUID source path is invalid or escapes the mounted volume root".to_string(),
            );
        }
    }

    if normalized.is_empty() {
        return Ok("/".to_string());
    }

    Ok(normalized)
}

enum ResolvePathWithUuidOutcome {
    Resolved(PathBuf),
    UuidNotMounted {
        token_type: UuidTokenType,
        uuid: String,
        normalized_source: String,
    },
}

fn resolve_path_with_uuid_outcome(path_str: &str) -> Result<ResolvePathWithUuidOutcome, String> {
    if !has_uuid_source_prefix(path_str) {
        return Ok(ResolvePathWithUuidOutcome::Resolved(PathBuf::from(
            path_str,
        )));
    }

    let parsed = parse_uuid_source_path(path_str)
        .ok_or_else(|| "Invalid UUID source token format".to_string())?;
    if parsed.uuid.trim().is_empty() {
        return Err("Invalid UUID source token format".to_string());
    }

    let normalized_sub_path = normalize_uuid_sub_path(parsed.sub_path)?;
    let normalized_source = format!(
        "{}{}]{}",
        uuid_token_prefix(parsed.token_type),
        parsed.uuid,
        normalized_sub_path
    );

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
    };

    let Some(volume) = volume else {
        return Ok(ResolvePathWithUuidOutcome::UuidNotMounted {
            token_type: parsed.token_type,
            uuid: parsed.uuid.to_string(),
            normalized_source,
        });
    };

    let clean_sub_path = normalized_sub_path.trim_start_matches('/');
    let resolved = volume.mount_point.join(clean_sub_path);
    let mount_root_key = path_key_for_compare(&volume.mount_point);
    let resolved_key = path_key_for_compare(&resolved);
    if !is_same_or_subpath(&mount_root_key, &resolved_key) {
        return Err("UUID source path is invalid or escapes the mounted volume root".to_string());
    }

    Ok(ResolvePathWithUuidOutcome::Resolved(resolved))
}

fn resolve_path_with_uuid(path_str: &str) -> Result<PathBuf, String> {
    match resolve_path_with_uuid_outcome(path_str)? {
        ResolvePathWithUuidOutcome::Resolved(path) => Ok(path),
        ResolvePathWithUuidOutcome::UuidNotMounted {
            token_type, uuid, ..
        } => Err(format!(
            "Volume with {} {} not found (not mounted?)",
            uuid_token_label(token_type),
            uuid
        )),
    }
}

#[derive(
    Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema, PartialEq, Eq,
)]
#[serde(rename_all = "camelCase")]
struct SyncTaskSourceRecommendation {
    task_id: String,
    task_name: String,
    current_uuid: String,
    current_uuid_type: String,
    proposed_uuid: String,
    proposed_uuid_type: String,
    suggested_source: String,
    proposed_mount_point: PathBuf,
    proposed_volume_name: String,
    confidence_label: String,
    evidence: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
struct SyncTaskSourceRecommendationsEnvelope {
    recommendations: Vec<SyncTaskSourceRecommendation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecommendationConfidence {
    DeviceSerial,
    DeviceGuid,
    MediaUuid,
    LastSeenUuid,
    Composite,
}

impl RecommendationConfidence {
    fn label(self, has_transport_serial: bool) -> &'static str {
        match self {
            RecommendationConfidence::Composite if has_transport_serial => "medium",
            RecommendationConfidence::Composite => "fallback",
            RecommendationConfidence::LastSeenUuid => "medium",
            RecommendationConfidence::DeviceSerial
            | RecommendationConfidence::DeviceGuid
            | RecommendationConfidence::MediaUuid => "high",
        }
    }
}

fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn task_uuid_descriptor(
    task: &SyncTaskRecord,
) -> Option<(UuidTokenType, config_store::SourceUuidType, String)> {
    if let (Some(uuid), Some(uuid_type)) = (&task.source_uuid, &task.source_uuid_type) {
        let token_type = match uuid_type {
            config_store::SourceUuidType::Disk => UuidTokenType::Disk,
            config_store::SourceUuidType::Volume => UuidTokenType::Volume,
        };
        return Some((token_type, uuid_type.clone(), uuid.clone()));
    }

    let parsed = parse_uuid_source_path(&task.source)?;
    let preferred_type = match parsed.token_type {
        UuidTokenType::Disk => config_store::SourceUuidType::Disk,
        UuidTokenType::Volume => config_store::SourceUuidType::Volume,
        UuidTokenType::Legacy => config_store::SourceUuidType::Disk,
    };
    Some((parsed.token_type, preferred_type, parsed.uuid.to_string()))
}

fn effective_source_identity(task: &SyncTaskRecord) -> SourceIdentitySnapshot {
    let mut identity = task.source_identity.clone().unwrap_or_default();
    if let Some((token_type, preferred_type, uuid)) = task_uuid_descriptor(task) {
        if identity.last_seen_disk_uuid.is_none()
            && (preferred_type == config_store::SourceUuidType::Disk
                || token_type == UuidTokenType::Disk)
        {
            identity.last_seen_disk_uuid = Some(uuid.clone());
        }
        if identity.last_seen_volume_uuid.is_none()
            && (preferred_type == config_store::SourceUuidType::Volume
                || token_type == UuidTokenType::Volume)
        {
            identity.last_seen_volume_uuid = Some(uuid);
        }
    }
    identity
}

fn select_volume_for_task<'a>(
    token_type: UuidTokenType,
    uuid: &str,
    volumes: &'a [system_integration::VolumeInfo],
) -> Option<&'a system_integration::VolumeInfo> {
    match token_type {
        UuidTokenType::Disk => volumes
            .iter()
            .find(|volume| volume.disk_uuid.as_deref() == Some(uuid)),
        UuidTokenType::Volume => volumes
            .iter()
            .find(|volume| volume.volume_uuid.as_deref() == Some(uuid)),
        UuidTokenType::Legacy => volumes
            .iter()
            .find(|volume| volume.disk_uuid.as_deref() == Some(uuid))
            .or_else(|| {
                volumes
                    .iter()
                    .find(|volume| volume.volume_uuid.as_deref() == Some(uuid))
            }),
    }
}

fn build_source_identity_snapshot(
    task: &SyncTaskRecord,
    volumes: &[system_integration::VolumeInfo],
) -> Option<SourceIdentitySnapshot> {
    let (token_type, _, uuid) = task_uuid_descriptor(task)?;
    let volume = select_volume_for_task(token_type, &uuid, volumes)?;
    Some(SourceIdentitySnapshot {
        device_serial: trim_to_option(volume.device_serial.clone()),
        media_uuid: trim_to_option(volume.media_uuid.clone()),
        device_guid: trim_to_option(volume.device_guid.clone()),
        transport_serial: trim_to_option(volume.transport_serial.clone()),
        bus_protocol: trim_to_option(volume.bus_protocol.clone()),
        filesystem_name: trim_to_option(volume.filesystem_name.clone()),
        total_bytes: volume.total_bytes,
        volume_name: trim_to_option(Some(volume.name.clone())),
        last_seen_disk_uuid: trim_to_option(volume.disk_uuid.clone()),
        last_seen_volume_uuid: trim_to_option(volume.volume_uuid.clone()),
    })
}

fn refresh_uuid_source_identity(
    task: &mut SyncTaskRecord,
    volumes: &[system_integration::VolumeInfo],
) {
    if !is_uuid_source(&task.source, task.source_type.clone()) {
        task.source_identity = None;
        return;
    }

    if let Some(snapshot) = build_source_identity_snapshot(task, volumes) {
        task.source_identity = Some(snapshot);
    }
}

fn eq_option_case_insensitive(left: &Option<String>, right: &Option<String>) -> bool {
    match (left.as_deref(), right.as_deref()) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        _ => false,
    }
}

fn normalized_uuid_sub_path_for_task(task: &SyncTaskRecord) -> Option<String> {
    task.source_sub_path
        .clone()
        .or_else(|| parse_uuid_source_path(&task.source).map(|parsed| parsed.sub_path.to_string()))
        .and_then(|sub_path| normalize_uuid_sub_path(&sub_path).ok())
}

fn uuid_sub_path_for_task(task: &SyncTaskRecord) -> Option<String> {
    normalized_uuid_sub_path_for_task(task)
        .and_then(|normalized| (normalized != "/").then_some(normalized))
}

fn composite_candidate_matches(
    task: &SyncTaskRecord,
    identity: &SourceIdentitySnapshot,
    volume: &system_integration::VolumeInfo,
) -> Option<Vec<String>> {
    let total_bytes = identity.total_bytes?;
    let filesystem_name = identity.filesystem_name.as_ref()?;
    if volume.total_bytes != Some(total_bytes) {
        return None;
    }
    if volume.filesystem_name.as_deref() != Some(filesystem_name.as_str()) {
        return None;
    }

    let sub_path_exists = uuid_sub_path_for_task(task)
        .map(|sub_path| {
            volume
                .mount_point
                .join(sub_path.trim_start_matches('/'))
                .exists()
        })
        .unwrap_or(false);
    let volume_name_matches = identity.volume_name.as_deref() == Some(volume.name.as_str());

    if !volume_name_matches && !sub_path_exists {
        return None;
    }

    let mut evidence = vec![
        format!("capacity matched ({total_bytes} bytes)"),
        format!("filesystem matched ({filesystem_name})"),
    ];
    if volume_name_matches {
        evidence.push(format!("volume name matched ({})", volume.name));
    }
    if sub_path_exists {
        evidence.push("configured source subpath exists".to_string());
    }
    if eq_option_case_insensitive(&identity.transport_serial, &volume.transport_serial) {
        evidence.push("transport serial matched".to_string());
    }

    Some(evidence)
}

fn select_unique_volume<'a>(
    matches: Vec<(&'a system_integration::VolumeInfo, Vec<String>)>,
) -> Option<(&'a system_integration::VolumeInfo, Vec<String>)> {
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

fn resolve_recommended_uuid(
    preferred_type: config_store::SourceUuidType,
    volume: &system_integration::VolumeInfo,
) -> Option<(config_store::SourceUuidType, String)> {
    match preferred_type {
        config_store::SourceUuidType::Disk => volume
            .disk_uuid
            .clone()
            .map(|uuid| (config_store::SourceUuidType::Disk, uuid))
            .or_else(|| {
                volume
                    .volume_uuid
                    .clone()
                    .map(|uuid| (config_store::SourceUuidType::Volume, uuid))
            }),
        config_store::SourceUuidType::Volume => volume
            .volume_uuid
            .clone()
            .map(|uuid| (config_store::SourceUuidType::Volume, uuid))
            .or_else(|| {
                volume
                    .disk_uuid
                    .clone()
                    .map(|uuid| (config_store::SourceUuidType::Disk, uuid))
            }),
    }
}

fn build_recommendation(
    task: &SyncTaskRecord,
    volume: &system_integration::VolumeInfo,
    current_token_type: UuidTokenType,
    current_uuid: &str,
    preferred_type: config_store::SourceUuidType,
    confidence: RecommendationConfidence,
    evidence: Vec<String>,
) -> Option<SyncTaskSourceRecommendation> {
    let (proposed_uuid_type, proposed_uuid) = resolve_recommended_uuid(preferred_type, volume)?;
    let token_label = match current_token_type {
        UuidTokenType::Disk => "disk",
        UuidTokenType::Volume => "volume",
        UuidTokenType::Legacy => "legacy",
    };
    let proposed_type_label = match proposed_uuid_type {
        config_store::SourceUuidType::Disk => "disk",
        config_store::SourceUuidType::Volume => "volume",
    };
    let suggested_source = format!(
        "{}{}]{}",
        if proposed_uuid_type == config_store::SourceUuidType::Disk {
            "[DISK_UUID:"
        } else {
            "[VOLUME_UUID:"
        },
        proposed_uuid,
        normalized_uuid_sub_path_for_task(task)?
    );
    let has_transport_serial = evidence
        .iter()
        .any(|item| item == "transport serial matched");

    Some(SyncTaskSourceRecommendation {
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        current_uuid: current_uuid.to_string(),
        current_uuid_type: token_label.to_string(),
        proposed_uuid,
        proposed_uuid_type: proposed_type_label.to_string(),
        suggested_source,
        proposed_mount_point: volume.mount_point.clone(),
        proposed_volume_name: volume.name.clone(),
        confidence_label: confidence.label(has_transport_serial).to_string(),
        evidence,
    })
}

fn find_task_source_recommendation(
    task: &SyncTaskRecord,
    volumes: &[system_integration::VolumeInfo],
) -> Option<SyncTaskSourceRecommendation> {
    let (current_token_type, preferred_type, current_uuid) = task_uuid_descriptor(task)?;
    if select_volume_for_task(current_token_type, &current_uuid, volumes).is_some() {
        return None;
    }

    let identity = effective_source_identity(task);

    let exact_checks = [
        (
            RecommendationConfidence::DeviceSerial,
            identity.device_serial.clone(),
            "device serial matched".to_string(),
            Box::new(|volume: &system_integration::VolumeInfo, value: &str| {
                volume.device_serial.as_deref() == Some(value)
            }) as Box<dyn Fn(&system_integration::VolumeInfo, &str) -> bool>,
        ),
        (
            RecommendationConfidence::DeviceGuid,
            identity.device_guid.clone(),
            "device GUID matched".to_string(),
            Box::new(|volume: &system_integration::VolumeInfo, value: &str| {
                volume.device_guid.as_deref() == Some(value)
            }),
        ),
        (
            RecommendationConfidence::MediaUuid,
            identity.media_uuid.clone(),
            "media UUID matched".to_string(),
            Box::new(|volume: &system_integration::VolumeInfo, value: &str| {
                volume.media_uuid.as_deref() == Some(value)
            }),
        ),
        (
            RecommendationConfidence::LastSeenUuid,
            identity
                .last_seen_disk_uuid
                .clone()
                .or_else(|| identity.last_seen_volume_uuid.clone()),
            "last seen UUID matched".to_string(),
            Box::new(|volume: &system_integration::VolumeInfo, value: &str| {
                volume.disk_uuid.as_deref() == Some(value)
                    || volume.volume_uuid.as_deref() == Some(value)
            }),
        ),
    ];

    for (confidence, probe, evidence_label, matcher) in exact_checks {
        let Some(probe) = trim_to_option(probe) else {
            continue;
        };
        let matches = volumes
            .iter()
            .filter(|volume| matcher(volume, &probe))
            .map(|volume| (volume, vec![evidence_label.clone()]))
            .collect::<Vec<_>>();
        if let Some((volume, evidence)) = select_unique_volume(matches) {
            return build_recommendation(
                task,
                volume,
                current_token_type,
                &current_uuid,
                preferred_type,
                confidence,
                evidence,
            );
        }
    }

    let composite_matches = volumes
        .iter()
        .filter_map(|volume| {
            composite_candidate_matches(task, &identity, volume).map(|evidence| (volume, evidence))
        })
        .collect::<Vec<_>>();
    let (volume, evidence) = select_unique_volume(composite_matches)?;
    build_recommendation(
        task,
        volume,
        current_token_type,
        &current_uuid,
        preferred_type,
        RecommendationConfidence::Composite,
        evidence,
    )
}

async fn find_sync_task_source_recommendations_internal(
    state: &AppState,
) -> Result<Vec<SyncTaskSourceRecommendation>, String> {
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let volumes = DiskMonitor::new()
        .get_removable_volumes()
        .map_err(|error| format!("Failed to list removable volumes: {error}"))?;

    Ok(tasks
        .iter()
        .filter(|task| is_uuid_source(&task.source, task.source_type.clone()))
        .filter_map(|task| find_task_source_recommendation(task, &volumes))
        .collect())
}

fn resolve_runtime_exclude_patterns(
    task: &RuntimeSyncTask,
    sets: &[RuntimeExclusionSet],
) -> Vec<String> {
    if task.exclusion_sets.is_empty() {
        return Vec::new();
    }

    let selected: HashSet<&str> = task.exclusion_sets.iter().map(String::as_str).collect();
    let mut resolved_patterns = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for set in sets.iter().filter(|set| selected.contains(set.id.as_str())) {
        for pattern in &set.patterns {
            if seen.insert(pattern.as_str()) {
                resolved_patterns.push(pattern.clone());
            }
        }
    }

    resolved_patterns
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

fn ensure_non_overlapping_paths(source: &Path, target: &Path) -> Result<(), String> {
    let source_key = path_key_for_compare(source);
    let target_key = path_key_for_compare(target);

    if is_path_overlap(&source_key, &target_key) {
        return Err(format!(
            "Source and target paths overlap and are not allowed. source='{}', target='{}'",
            source.display(),
            target.display()
        ));
    }

    Ok(())
}

fn mounted_volume_root(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();

    match components.next()? {
        Component::RootDir => {}
        _ => return None,
    }

    match components.next()? {
        Component::Normal(segment) if segment.to_string_lossy().eq_ignore_ascii_case("Volumes") => {
        }
        _ => return None,
    }

    match components.next()? {
        Component::Normal(volume_name) => {
            let mut root = PathBuf::from("/Volumes");
            root.push(volume_name);
            Some(root)
        }
        _ => None,
    }
}

fn mounted_volume_roots() -> Result<HashSet<String>, String> {
    DiskMonitor::new()
        .list_volumes()
        .map(|volumes| {
            volumes
                .into_iter()
                .map(|volume| path_key_for_compare(&volume.mount_point))
                .collect()
        })
        .map_err(|error| format!("Failed to list mounted volumes: {error}"))
}

pub(crate) fn classify_missing_target_path(
    target: &Path,
    mounted_roots: &HashSet<String>,
) -> Result<TargetPreflightKind, String> {
    if let Some(volume_root) = mounted_volume_root(target) {
        let volume_key = path_key_for_compare(&volume_root);
        if !mounted_roots.contains(&volume_key) {
            return Err(format!(
                "Target volume is not mounted: {}",
                volume_root.display()
            ));
        }
    }

    Ok(TargetPreflightKind::WillCreateDirectory)
}

pub(crate) async fn preflight_target_path(
    target: &Path,
    create_missing: bool,
) -> Result<TargetPreflightInfo, String> {
    match tokio::fs::metadata(target).await {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(format!(
                    "Target path exists but is not a directory: {}",
                    target.display()
                ));
            }

            return Ok(TargetPreflightInfo {
                kind: TargetPreflightKind::Ready,
                path: target.display().to_string(),
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to access target path '{}': {}",
                target.display(),
                error
            ));
        }
    }

    if mounted_volume_root(target).is_some() {
        let mounted_roots = mounted_volume_roots()?;
        classify_missing_target_path(target, &mounted_roots)?;
    }

    if create_missing {
        tokio::fs::create_dir_all(target).await.map_err(|error| {
            format!(
                "Failed to create target directory '{}': {error}",
                target.display()
            )
        })?;

        Ok(TargetPreflightInfo {
            kind: TargetPreflightKind::CreatedDirectory,
            path: target.display().to_string(),
        })
    } else {
        Ok(TargetPreflightInfo {
            kind: TargetPreflightKind::WillCreateDirectory,
            path: target.display().to_string(),
        })
    }
}

fn resolved_path_key(path: &str) -> Result<String, String> {
    match resolve_path_with_uuid_outcome(path)? {
        ResolvePathWithUuidOutcome::Resolved(path) => Ok(path_key_for_compare(&path)),
        ResolvePathWithUuidOutcome::UuidNotMounted {
            normalized_source, ..
        } => Ok(path_key_for_compare(&PathBuf::from(normalized_source))),
    }
}

impl RuntimeTaskValidationIssue {
    fn invalid_input(task: Option<&RuntimeSyncTask>) -> Self {
        Self {
            code: RuntimeTaskValidationCode::InvalidInput,
            task_id: task.map(|item| item.id.clone()),
            task_name: task.map(|item| item.name.clone()),
            conflicting_task_ids: Vec::new(),
            conflicting_task_names: Vec::new(),
            source: task.map(|item| item.source.clone()),
            target: task.map(|item| item.target.clone()),
        }
    }
}

fn runtime_validation_issue_task_ids(issue: &RuntimeTaskValidationIssue) -> Vec<String> {
    let mut task_ids = Vec::new();
    if let Some(task_id) = &issue.task_id {
        task_ids.push(task_id.clone());
    }
    task_ids.extend(issue.conflicting_task_ids.iter().cloned());
    task_ids.sort();
    task_ids.dedup();
    task_ids
}

fn runtime_validation_issue_display_names(issue: &RuntimeTaskValidationIssue) -> Vec<String> {
    let mut names = Vec::new();

    if let Some(task_name) = issue.task_name.as_ref().filter(|name| !name.is_empty()) {
        names.push(task_name.clone());
    } else if let Some(task_id) = &issue.task_id {
        names.push(task_id.clone());
    }

    let related_count = issue
        .conflicting_task_ids
        .len()
        .max(issue.conflicting_task_names.len());

    for index in 0..related_count {
        if let Some(task_name) = issue
            .conflicting_task_names
            .get(index)
            .filter(|name| !name.is_empty())
        {
            names.push(task_name.clone());
        } else if let Some(task_id) = issue.conflicting_task_ids.get(index) {
            names.push(task_id.clone());
        }
    }

    names
}

fn runtime_validation_issue_log_message(issue: &RuntimeTaskValidationIssue) -> String {
    match issue.code {
        RuntimeTaskValidationCode::SourceTargetOverlap => format!(
            "Validation blocked saving sync task '{}' because source and target overlap.",
            issue
                .task_name
                .as_deref()
                .unwrap_or(issue.task_id.as_deref().unwrap_or("unknown"))
        ),
        RuntimeTaskValidationCode::DuplicateTarget => format!(
            "Validation blocked saving sync tasks '{}' and '{}' because target paths conflict.",
            issue
                .task_name
                .as_deref()
                .unwrap_or(issue.task_id.as_deref().unwrap_or("unknown")),
            issue
                .conflicting_task_names
                .first()
                .map(String::as_str)
                .or_else(|| issue.conflicting_task_ids.first().map(String::as_str))
                .unwrap_or("unknown"),
        ),
        RuntimeTaskValidationCode::TargetSubdirConflict => format!(
            "Validation blocked saving sync tasks '{}' and '{}' because target paths cannot be parent/child.",
            issue
                .task_name
                .as_deref()
                .unwrap_or(issue.task_id.as_deref().unwrap_or("unknown")),
            issue
                .conflicting_task_names
                .first()
                .map(String::as_str)
                .or_else(|| issue.conflicting_task_ids.first().map(String::as_str))
                .unwrap_or("unknown"),
        ),
        RuntimeTaskValidationCode::WatchCycle => {
            let cycle_names = runtime_validation_issue_display_names(issue);
            format!(
                "Validation blocked saving watch tasks because a cycle was detected: {}.",
                cycle_names
                    .iter()
                    .map(|name| format!("'{name}'"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        RuntimeTaskValidationCode::InvalidInput => format!(
            "Validation blocked saving sync task '{}' because its configuration is invalid.",
            issue
                .task_name
                .as_deref()
                .unwrap_or(issue.task_id.as_deref().unwrap_or("unknown"))
        ),
    }
}

fn record_runtime_validation_issue(
    issue: &RuntimeTaskValidationIssue,
    app: Option<&tauri::AppHandle>,
    state: &AppState,
) {
    let message = runtime_validation_issue_log_message(issue);
    state.log_manager.log_with_category_and_event(
        "error",
        &message,
        None,
        LogCategory::ValidationError,
        app,
    );

    for task_id in runtime_validation_issue_task_ids(issue) {
        state.log_manager.log_with_category_and_event(
            "error",
            &message,
            Some(task_id),
            LogCategory::ValidationError,
            app,
        );
    }
}

fn find_runtime_task_validation_issue(
    tasks: &[RuntimeSyncTask],
) -> Option<RuntimeTaskValidationIssue> {
    let mut validated_tasks: Vec<ValidatedRuntimeTask> = Vec::with_capacity(tasks.len());

    for task in tasks {
        if input_validation::validate_task_id(&task.id).is_err()
            || input_validation::validate_path_argument(&task.source).is_err()
            || input_validation::validate_path_argument(&task.target).is_err()
        {
            return Some(RuntimeTaskValidationIssue::invalid_input(Some(task)));
        }

        let source_key = match resolved_path_key(&task.source) {
            Ok(value) => value,
            Err(_) => return Some(RuntimeTaskValidationIssue::invalid_input(Some(task))),
        };
        let target_key = match resolved_path_key(&task.target) {
            Ok(value) => value,
            Err(_) => return Some(RuntimeTaskValidationIssue::invalid_input(Some(task))),
        };

        if is_path_overlap(&source_key, &target_key) {
            return Some(RuntimeTaskValidationIssue {
                code: RuntimeTaskValidationCode::SourceTargetOverlap,
                task_id: Some(task.id.clone()),
                task_name: Some(task.name.clone()),
                conflicting_task_ids: Vec::new(),
                conflicting_task_names: Vec::new(),
                source: Some(task.source.clone()),
                target: Some(task.target.clone()),
            });
        }

        validated_tasks.push(ValidatedRuntimeTask {
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
                let code = if left.target_key == right.target_key {
                    RuntimeTaskValidationCode::DuplicateTarget
                } else {
                    RuntimeTaskValidationCode::TargetSubdirConflict
                };

                return Some(RuntimeTaskValidationIssue {
                    code,
                    task_id: Some(left.id.clone()),
                    task_name: Some(left.name.clone()),
                    conflicting_task_ids: vec![right.id.clone()],
                    conflicting_task_names: vec![right.name.clone()],
                    source: None,
                    target: Some(tasks[left_index].target.clone()),
                });
            }
        }
    }

    if let Some(cycle) = find_runtime_watch_cycle(&validated_tasks) {
        let mut ordered_cycle_ids: Vec<String> = Vec::new();
        for task_id in cycle {
            if ordered_cycle_ids
                .iter()
                .any(|existing| existing == &task_id)
            {
                continue;
            }
            ordered_cycle_ids.push(task_id);
        }

        let names_by_id: HashMap<&str, &str> = validated_tasks
            .iter()
            .map(|task| (task.id.as_str(), task.name.as_str()))
            .collect();
        let cycle_names: Vec<String> = ordered_cycle_ids
            .iter()
            .map(|task_id| {
                names_by_id
                    .get(task_id.as_str())
                    .copied()
                    .unwrap_or(task_id.as_str())
                    .to_string()
            })
            .collect();

        return Some(RuntimeTaskValidationIssue {
            code: RuntimeTaskValidationCode::WatchCycle,
            task_id: ordered_cycle_ids.first().cloned(),
            task_name: cycle_names.first().cloned(),
            conflicting_task_ids: ordered_cycle_ids.iter().skip(1).cloned().collect(),
            conflicting_task_names: cycle_names.iter().skip(1).cloned().collect(),
            source: None,
            target: None,
        });
    }

    None
}

fn build_validated_runtime_tasks(
    tasks: &[RuntimeSyncTask],
) -> Result<Vec<ValidatedRuntimeTask>, String> {
    let mut validated_tasks: Vec<ValidatedRuntimeTask> = Vec::with_capacity(tasks.len());

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

        validated_tasks.push(ValidatedRuntimeTask {
            id: task.id.clone(),
            name: task.name.clone(),
            source_key,
            target_key,
            watch_mode: task.watch_mode,
        });
    }

    Ok(validated_tasks)
}

fn build_runtime_watch_upstreams(
    validated_tasks: &[ValidatedRuntimeTask],
) -> HashMap<String, HashSet<String>> {
    let mut upstreams: HashMap<String, HashSet<String>> = HashMap::new();

    for downstream in validated_tasks.iter().filter(|task| task.watch_mode) {
        let entry = upstreams.entry(downstream.id.clone()).or_default();
        for upstream in validated_tasks.iter().filter(|task| task.watch_mode) {
            if upstream.id == downstream.id {
                continue;
            }

            if is_path_overlap(&upstream.target_key, &downstream.source_key) {
                entry.insert(upstream.id.clone());
            }
        }
    }

    upstreams
}

fn find_runtime_watch_cycle(validated_tasks: &[ValidatedRuntimeTask]) -> Option<Vec<String>> {
    fn visit(
        task_id: &str,
        upstreams: &HashMap<String, HashSet<String>>,
        visiting: &mut Vec<String>,
        visited: &mut HashSet<String>,
    ) -> Option<Vec<String>> {
        if let Some(index) = visiting.iter().position(|candidate| candidate == task_id) {
            let mut cycle = visiting[index..].to_vec();
            cycle.push(task_id.to_string());
            return Some(cycle);
        }

        if !visited.insert(task_id.to_string()) {
            return None;
        }

        visiting.push(task_id.to_string());

        if let Some(task_upstreams) = upstreams.get(task_id) {
            for upstream_id in task_upstreams {
                if let Some(cycle) = visit(upstream_id, upstreams, visiting, visited) {
                    return Some(cycle);
                }
            }
        }

        visiting.pop();
        None
    }

    let upstreams = build_runtime_watch_upstreams(validated_tasks);
    let mut visited: HashSet<String> = HashSet::new();
    let mut visiting: Vec<String> = Vec::new();

    for task in validated_tasks.iter().filter(|task| task.watch_mode) {
        if let Some(cycle) = visit(&task.id, &upstreams, &mut visiting, &mut visited) {
            return Some(cycle);
        }
    }

    None
}

fn validate_runtime_tasks(tasks: &[RuntimeSyncTask]) -> Result<(), String> {
    let validated_tasks = build_validated_runtime_tasks(tasks)?;

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

    if let Some(cycle) = find_runtime_watch_cycle(&validated_tasks) {
        let cycle_names = cycle
            .iter()
            .map(|task_id| {
                validated_tasks
                    .iter()
                    .find(|task| &task.id == task_id)
                    .map(|task| task.name.as_str())
                    .unwrap_or(task_id.as_str())
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join(" -> ");
        return Err(format!("Watch cycle detected: {cycle_names}"));
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSyncEnqueueResult {
    Enqueued,
    AlreadyQueued,
    DeferredWhileSyncing,
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
        state.runtime_dispatcher_wakeup.notify_waiters();
        state.runtime_sync_slot_released.notify_one();
    }
}

fn runtime_sync_origin_producer_kind(sync_origin: SyncOrigin) -> RuntimeProducerKind {
    match sync_origin {
        SyncOrigin::Manual => RuntimeProducerKind::ManualSync,
        SyncOrigin::Watch => RuntimeProducerKind::WatchSync,
    }
}

fn runtime_sync_producer_id(task_id: &str, sync_origin: SyncOrigin) -> String {
    let scope = match sync_origin {
        SyncOrigin::Manual => "manual",
        SyncOrigin::Watch => "watch",
    };
    format!("sync:{scope}:{task_id}")
}

fn runtime_conflict_producer_id(
    session_id: &str,
    item_id: &str,
    kind: RuntimeProducerKind,
) -> String {
    let scope = match kind {
        RuntimeProducerKind::ConflictForceCopy => "force-copy",
        RuntimeProducerKind::ConflictRenameThenCopy => "rename-then-copy",
        RuntimeProducerKind::WatchSync => "watch-sync",
        RuntimeProducerKind::ManualSync => "manual-sync",
    };
    format!("conflict:{scope}:{session_id}:{item_id}")
}

async fn register_runtime_producer(
    producer_id: String,
    kind: RuntimeProducerKind,
    target_key: String,
    state: &AppState,
) {
    let producer = RuntimeActiveProducer {
        producer_id: producer_id.clone(),
        kind,
        target_key,
    };
    let mut producers = state.runtime_active_producers.write().await;
    producers.insert(producer_id, producer);
}

fn downstream_watch_task_ids_for_target(
    validated_tasks: &[ValidatedRuntimeTask],
    target_key: &str,
) -> Vec<String> {
    validated_tasks
        .iter()
        .filter(|task| task.watch_mode && is_path_overlap(target_key, &task.source_key))
        .map(|task| task.id.clone())
        .collect()
}

async fn remove_queued_runtime_watch_task(
    task_id: &str,
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    reason: &str,
) {
    let queued_removed = {
        let mut queued = state.queued_sync_tasks.write().await;
        if !queued.remove(task_id) {
            false
        } else {
            let mut queue = state.runtime_sync_queue.write().await;
            queue.retain(|queued_task_id| queued_task_id != task_id);
            true
        }
    };

    if queued_removed {
        let Some(app) = app else {
            return;
        };
        emit_runtime_sync_queue_state(app, task_id, false, Some(reason.to_string()));
    }
}

async fn block_downstream_watch_tasks_for_target(
    target_key: &str,
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    reason: &str,
) {
    let runtime_config = {
        let config = state.runtime_config.read().await;
        config.clone()
    };
    let Ok(validated_tasks) = build_validated_runtime_tasks(&runtime_config.tasks) else {
        return;
    };
    let overlapping_watch_task_ids =
        downstream_watch_task_ids_for_target(&validated_tasks, target_key);

    {
        let mut settle = state.runtime_chain_settle_until.write().await;
        for task_id in &overlapping_watch_task_ids {
            settle.remove(task_id);
        }
    }

    for task_id in &overlapping_watch_task_ids {
        {
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.remove(task_id);
        }
        remove_queued_runtime_watch_task(task_id, app, state, reason).await;
    }
}

async fn mark_downstream_watch_tasks_settle_for_target(target_key: &str, state: &AppState) {
    let runtime_config = {
        let config = state.runtime_config.read().await;
        config.clone()
    };
    let Ok(validated_tasks) = build_validated_runtime_tasks(&runtime_config.tasks) else {
        return;
    };
    let overlapping_watch_task_ids =
        downstream_watch_task_ids_for_target(&validated_tasks, target_key);
    if overlapping_watch_task_ids.is_empty() {
        return;
    }

    let deadline = Instant::now() + RUNTIME_DOWNSTREAM_SETTLE_WINDOW;
    let mut settle = state.runtime_chain_settle_until.write().await;
    for task_id in overlapping_watch_task_ids {
        settle
            .entry(task_id)
            .and_modify(|current| {
                if deadline > *current {
                    *current = deadline;
                }
            })
            .or_insert(deadline);
    }
}

async fn finish_runtime_producer(
    producer_id: &str,
    target_key: &str,
    success: bool,
    app: Option<&tauri::AppHandle>,
    state: &AppState,
) {
    if success {
        mark_downstream_watch_tasks_settle_for_target(target_key, state).await;
    } else {
        block_downstream_watch_tasks_for_target(
            target_key,
            app,
            state,
            "Downstream watch sync blocked because the preceding write did not complete successfully.",
        )
        .await;
    }

    {
        let mut producers = state.runtime_active_producers.write().await;
        producers.remove(producer_id);
    }

    state.runtime_dispatcher_wakeup.notify_waiters();
}

async fn enqueue_runtime_sync_task_internal(
    task_id: &str,
    state: &AppState,
) -> RuntimeSyncEnqueueResult {
    {
        let syncing = state.syncing_tasks.read().await;
        if syncing.contains(task_id) {
            drop(syncing);
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.insert(task_id.to_string());
            return RuntimeSyncEnqueueResult::DeferredWhileSyncing;
        }
    }

    let mut queued_set = state.queued_sync_tasks.write().await;
    if !queued_set.insert(task_id.to_string()) {
        return RuntimeSyncEnqueueResult::AlreadyQueued;
    }

    let mut queue = state.runtime_sync_queue.write().await;
    queue.push_back(task_id.to_string());
    state.runtime_dispatcher_wakeup.notify_waiters();

    RuntimeSyncEnqueueResult::Enqueued
}

async fn enqueue_runtime_sync_task(
    task_id: &str,
    app: &tauri::AppHandle,
    state: &AppState,
    reason: Option<String>,
) -> RuntimeSyncEnqueueResult {
    let enqueue_result = enqueue_runtime_sync_task_internal(task_id, state).await;
    if enqueue_result == RuntimeSyncEnqueueResult::Enqueued {
        emit_runtime_sync_queue_state(app, task_id, true, reason);
    }
    enqueue_result
}

#[allow(dead_code)]
async fn dequeue_runtime_sync_task(state: &AppState) -> Option<String> {
    let mut queued_set = state.queued_sync_tasks.write().await;
    let mut queue = state.runtime_sync_queue.write().await;
    let next = queue.pop_front();
    if let Some(task_id) = &next {
        queued_set.remove(task_id);
    }
    next
}

async fn take_runtime_pending_sync_task(task_id: &str, state: &AppState) -> bool {
    let mut pending = state.runtime_pending_sync_tasks.write().await;
    pending.remove(task_id)
}

async fn remove_runtime_sync_task_state(task_id: &str, state: &AppState) {
    {
        let mut pending = state.runtime_pending_sync_tasks.write().await;
        pending.remove(task_id);
    }

    {
        let mut settle = state.runtime_chain_settle_until.write().await;
        settle.remove(task_id);
    }

    let mut queued = state.queued_sync_tasks.write().await;
    let mut queue = state.runtime_sync_queue.write().await;
    queued.remove(task_id);
    queue.retain(|queued_task_id| queued_task_id != task_id);
}

fn select_runtime_dispatch_candidate(
    queue: &VecDeque<String>,
    queued_set: &HashSet<String>,
    syncing_tasks: &HashSet<String>,
    watch_upstreams: &HashMap<String, HashSet<String>>,
    source_keys: &HashMap<String, String>,
    active_producers: &HashMap<String, RuntimeActiveProducer>,
    settle_until: &HashMap<String, Instant>,
    now: Instant,
) -> RuntimeDispatchSelection {
    let mut next_deadline: Option<Instant> = None;

    for task_id in queue {
        let Some(source_key) = source_keys.get(task_id) else {
            continue;
        };

        let blocked_by_upstream =
            watch_upstreams
                .get(task_id)
                .into_iter()
                .flatten()
                .any(|upstream_id| {
                    syncing_tasks.contains(upstream_id) || queued_set.contains(upstream_id)
                });
        if blocked_by_upstream {
            continue;
        }

        let blocked_by_producer = active_producers.values().any(|producer| {
            let _ = &producer.producer_id;
            let _ = producer.kind;
            is_path_overlap(&producer.target_key, source_key)
        });
        if blocked_by_producer {
            continue;
        }

        if let Some(deadline) = settle_until.get(task_id) {
            if *deadline > now {
                next_deadline = match next_deadline {
                    Some(current) if current <= *deadline => Some(current),
                    _ => Some(*deadline),
                };
                continue;
            }
        }

        return RuntimeDispatchSelection {
            candidate_task_id: Some(task_id.clone()),
            next_deadline,
        };
    }

    RuntimeDispatchSelection {
        candidate_task_id: None,
        next_deadline,
    }
}

async fn dequeue_runtime_sync_task_by_id(task_id: &str, state: &AppState) -> bool {
    let removed = {
        let mut queued_set = state.queued_sync_tasks.write().await;
        queued_set.remove(task_id)
    };
    if !removed {
        return false;
    }

    let mut queue = state.runtime_sync_queue.write().await;
    queue.retain(|queued_task_id| queued_task_id != task_id);
    true
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
            let runtime_config = {
                let config = state.runtime_config.read().await;
                config.clone()
            };

            let validated_tasks = match build_validated_runtime_tasks(&runtime_config.tasks) {
                Ok(tasks) => tasks,
                Err(_) => break,
            };
            let watch_upstreams = build_runtime_watch_upstreams(&validated_tasks);
            let source_keys: HashMap<String, String> = validated_tasks
                .iter()
                .filter(|task| task.watch_mode)
                .map(|task| (task.id.clone(), task.source_key.clone()))
                .collect();
            let queue = {
                let queue = state.runtime_sync_queue.read().await;
                queue.clone()
            };
            let has_queued = !queue.is_empty();
            if !has_queued {
                break;
            }
            let queued_set = {
                let queued_set = state.queued_sync_tasks.read().await;
                queued_set.clone()
            };
            let syncing_tasks = {
                let syncing = state.syncing_tasks.read().await;
                syncing.clone()
            };
            let current_syncing = syncing_tasks.len();
            let active_producers = {
                let producers = state.runtime_active_producers.read().await;
                producers.clone()
            };
            let settle_until = {
                let settle = state.runtime_chain_settle_until.read().await;
                settle.clone()
            };

            if should_wait_for_runtime_slot(has_queued, current_syncing) {
                state.runtime_dispatcher_wakeup.notified().await;
                continue;
            }

            let selection = select_runtime_dispatch_candidate(
                &queue,
                &queued_set,
                &syncing_tasks,
                &watch_upstreams,
                &source_keys,
                &active_producers,
                &settle_until,
                Instant::now(),
            );

            let Some(task_id) = selection.candidate_task_id else {
                if let Some(deadline) = selection.next_deadline {
                    let sleep_for = deadline.saturating_duration_since(Instant::now());
                    tokio::select! {
                        _ = tokio::time::sleep(sleep_for) => {}
                        _ = state.runtime_dispatcher_wakeup.notified() => {}
                    }
                } else {
                    state.runtime_dispatcher_wakeup.notified().await;
                }
                continue;
            };

            if !dequeue_runtime_sync_task_by_id(&task_id, &state).await {
                continue;
            }

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
    let dry_running_tasks = {
        let running = state.dry_running_tasks.read().await;
        running.iter().cloned().collect()
    };

    RuntimeState {
        watching_tasks,
        syncing_tasks,
        queued_tasks,
        dry_running_tasks,
    }
}

async fn set_auto_unmount_session_disabled_internal(
    task_id: &str,
    disabled: bool,
    state: &AppState,
) {
    let mut disabled_tasks = state.auto_unmount_session_disabled_tasks.write().await;
    if disabled {
        disabled_tasks.insert(task_id.to_string());
    } else {
        disabled_tasks.remove(task_id);
    }
}

async fn is_auto_unmount_session_disabled_internal(task_id: &str, state: &AppState) -> bool {
    let disabled_tasks = state.auto_unmount_session_disabled_tasks.read().await;
    disabled_tasks.contains(task_id)
}

async fn prune_auto_unmount_session_disabled_tasks(
    valid_task_ids: &HashSet<String>,
    state: &AppState,
) {
    let mut disabled_tasks = state.auto_unmount_session_disabled_tasks.write().await;
    disabled_tasks.retain(|task_id| valid_task_ids.contains(task_id));
}

async fn try_acquire_task_operation(
    task_id: &str,
    kind: TaskOperationKind,
    state: &AppState,
) -> Result<(), String> {
    let mut active = state.active_task_operations.write().await;
    if let Some(existing) = active.get(task_id) {
        return Err(format!(
            "Task '{task_id}' is busy with another operation ({existing:?})"
        ));
    }
    active.insert(task_id.to_string(), kind);
    Ok(())
}

async fn release_task_operation(task_id: &str, state: &AppState) {
    let mut active = state.active_task_operations.write().await;
    active.remove(task_id);
}

async fn load_canonical_config(
    state: &AppState,
) -> Result<(AppSettings, Vec<SyncTaskRecord>, Vec<ExclusionSetRecord>), String> {
    let settings = state
        .config_store
        .load_settings()
        .map_err(config_store_error_to_string)?;
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let exclusion_sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    Ok((settings, tasks, exclusion_sets))
}

async fn stop_control_plane_listener(state: AppState) -> Result<(), String> {
    let handle = {
        let mut control_plane = state.control_plane_handle.lock().await;
        control_plane.take()
    };

    if let Some(handle) = handle {
        handle.shutdown.cancel();
    }

    Ok(())
}

async fn start_control_plane_listener(
    app: tauri::AppHandle,
    state: AppState,
) -> Result<(), String> {
    let already_running = {
        let control_plane = state.control_plane_handle.lock().await;
        control_plane.is_some()
    };
    if already_running {
        return Ok(());
    }

    let socket_path = control_plane::default_socket_path()?;
    let app_for_handler = app.clone();
    let state_for_handler = state.clone();
    let handle = control_plane::start_listener(socket_path, move |request| {
        let app = app_for_handler.clone();
        let state = state_for_handler.clone();
        async move { handle_control_plane_request(request, app, state).await }
    })
    .await?;

    let mut control_plane = state.control_plane_handle.lock().await;
    if control_plane.is_none() {
        *control_plane = Some(handle);
    } else {
        handle.shutdown.cancel();
    }
    Ok(())
}

async fn sync_control_plane_listener(
    app: tauri::AppHandle,
    state: AppState,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        start_control_plane_listener(app, state).await
    } else {
        stop_control_plane_listener(state).await
    }
}

async fn apply_canonical_config_to_runtime(
    app: tauri::AppHandle,
    state: AppState,
) -> Result<RuntimeState, String> {
    let _apply_guard = state.runtime_config_apply_lock.clone().lock_owned().await;
    let (settings, tasks, exclusion_sets) = load_canonical_config(&state).await?;

    validate_settings_record(&settings)?;
    validate_sync_task_records(&tasks)?;
    for set in &exclusion_sets {
        input_validation::validate_exclude_patterns(&set.patterns).map_err(|e| e.to_string())?;
    }

    let valid_task_ids: HashSet<String> = tasks.iter().map(|task| task.id.clone()).collect();
    let payload = RuntimeConfigPayload {
        tasks: tasks.iter().map(to_runtime_task_record).collect(),
        exclusion_sets: exclusion_sets
            .iter()
            .map(to_runtime_exclusion_set_record)
            .collect(),
        settings: to_runtime_settings_record(&settings),
    };

    {
        let mut config = state.runtime_config.write().await;
        *config = payload;
    }
    prune_auto_unmount_session_disabled_tasks(&valid_task_ids, &state).await;

    reconcile_runtime_watchers(app.clone(), state.clone()).await?;

    if state
        .runtime_initial_watch_bootstrapped
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        enqueue_initial_runtime_watch_syncs(app.clone(), state.clone()).await;
    }

    Ok(runtime_get_state_internal(&state).await)
}

fn next_mcp_job_id(kind: McpJobKind, seq: u64) -> String {
    let prefix = match kind {
        McpJobKind::Sync => "sync",
        McpJobKind::DryRun => "dry-run",
        McpJobKind::OrphanScan => "orphan-scan",
    };
    format!("mcp-{prefix}-{}-{seq}", unix_now_ms())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncOrigin {
    Manual,
    Watch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeAutoUnmountDecision {
    SkipDisabled,
    SkipDueConflicts,
    RequestConfirmation,
    UnmountNow,
}

fn decide_runtime_auto_unmount(
    auto_unmount: bool,
    has_pending_conflicts: bool,
    files_copied: u64,
) -> RuntimeAutoUnmountDecision {
    if !auto_unmount {
        return RuntimeAutoUnmountDecision::SkipDisabled;
    }
    if has_pending_conflicts {
        return RuntimeAutoUnmountDecision::SkipDueConflicts;
    }
    if files_copied == 0 {
        return RuntimeAutoUnmountDecision::RequestConfirmation;
    }
    RuntimeAutoUnmountDecision::UnmountNow
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
    external_cancel_token: Option<CancellationToken>,
    mcp_job_id: Option<String>,
) -> Result<SyncExecutionResult, String> {
    if !sync_slot_pre_acquired && !acquire_sync_slot(&task_id, &state).await {
        return Err("Task is already syncing".to_string());
    }
    try_acquire_task_operation(&task_id, TaskOperationKind::Sync, &state).await?;
    if sync_origin == SyncOrigin::Manual {
        emit_runtime_sync_state(&app, &task_id, true, None);
    }

    let sync_result = async {
        let source = resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        let target = resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        ensure_non_overlapping_paths(&source, &target)?;

        // Validate all inputs
        input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;
        let target_key = resolved_path_key(target.to_str().unwrap_or(""))?;
        let producer_id = runtime_sync_producer_id(&task_id, sync_origin);
        register_runtime_producer(
            producer_id.clone(),
            runtime_sync_origin_producer_kind(sync_origin),
            target_key.clone(),
            &state,
        )
        .await;
        let sync_result = async {
            let target_preflight = preflight_target_path(&target, true).await?;

            // 취소 토큰 생성 및 등록
            let cancel_token = CancellationToken::new();
            if let Some(external_cancel_token) = external_cancel_token {
                let forward_cancel = cancel_token.clone();
                tauri::async_runtime::spawn(async move {
                    external_cancel_token.cancelled().await;
                    forward_cancel.cancel();
                });
            }
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
            if target_preflight.kind == TargetPreflightKind::CreatedDirectory {
                state.log_manager.log_with_category(
                    "info",
                    &format!("Target directory created: {}", target_preflight.path),
                    Some(task_id.clone()),
                    LogCategory::Other,
                );
            }

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
            #[serde(rename_all = "camelCase")]
            struct ProgressEvent {
                task_id: String,
                message: String,
                current: u64,
                total: u64,
                processed_bytes: u64,
                total_bytes: u64,
                current_file_bytes_copied: u64,
                current_file_total_bytes: u64,
            }

            let progress_state = SyncProgressState::new();
            let log_manager = state.log_manager.clone();
            let task_id_for_log = task_id.clone();
            let app_for_log = app.clone(); // For log events
            let mcp_jobs = state.mcp_jobs.clone();
            let mcp_job_id_for_progress = mcp_job_id.clone();

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
                                    LogCategory::FileCopied => {
                                        let file_size = format_bytes(progress.current_file_total_bytes);
                                        format!("Copy: {} ({})", current, file_size)
                                    }
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
                            processed_bytes: progress.processed_bytes,
                            total_bytes: progress.total_bytes,
                            current_file_bytes_copied: progress.bytes_copied_current_file,
                            current_file_total_bytes: progress.current_file_total_bytes,
                        };
                        let _ = app_clone.emit("sync-progress", &event);
                        if let Some(job_id) = mcp_job_id_for_progress.as_deref() {
                            mcp_jobs.try_update_progress(
                                job_id,
                                McpJobProgress {
                                    message: Some(event.message.clone()),
                                    current: event.current,
                                    total: event.total,
                                    processed_bytes: event.processed_bytes,
                                    total_bytes: event.total_bytes,
                                    current_file_bytes_copied: event.current_file_bytes_copied,
                                    current_file_total_bytes: event.current_file_total_bytes,
                                },
                                unix_now_ms(),
                            );
                        }
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
                        target_preflight: Some(target_preflight.clone()),
                    })
                }
                Err(e) => {
                    let err_text = format!("{:#}", e);
                    if err_text.contains("cancelled by user") || err_text.contains("Operation cancelled by user") {
                        state.log_manager.log_with_category(
                            "warning",
                            "Sync cancelled by user",
                            Some(task_id.clone()),
                            LogCategory::SyncError,
                        );
                        Err("Operation cancelled by user".to_string())
                    } else {
                        let msg = format!("Sync failed: {err_text}");
                        state.log_manager.log_with_category(
                            "error",
                            &msg,
                            Some(task_id.clone()),
                            LogCategory::SyncError,
                        );
                        Err(err_text)
                    }
                }
            }
        }
        .await;

        finish_runtime_producer(
            &producer_id,
            &target_key,
            sync_result.is_ok(),
            Some(&app),
            &state,
        )
        .await;

        sync_result
    }
    .await;

    let completion_reason = sync_result.as_ref().err().cloned();
    release_task_operation(&task_id, &state).await;
    release_sync_slot(&task_id, &state).await;
    if sync_origin == SyncOrigin::Manual {
        emit_runtime_sync_state(&app, &task_id, false, completion_reason);
    }
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
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.insert(task.id.clone());
            return;
        }
        RuntimeSyncAcquireResult::CapacityReached => {
            let enqueue_result = enqueue_runtime_sync_task(
                &task.id,
                &app,
                &state,
                Some("Waiting for available sync slot".to_string()),
            )
            .await;

            if enqueue_result == RuntimeSyncEnqueueResult::Enqueued {
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
        None,
        None,
    )
    .await;

    if let Ok(exec_result) = &result {
        let auto_unmount_session_disabled =
            is_auto_unmount_session_disabled_internal(&task.id, &state).await;
        let effective_auto_unmount = task.auto_unmount && !auto_unmount_session_disabled;

        match decide_runtime_auto_unmount(
            effective_auto_unmount,
            exec_result.has_pending_conflicts,
            exec_result.sync_result.files_copied,
        ) {
            RuntimeAutoUnmountDecision::SkipDisabled => {
                if task.auto_unmount && auto_unmount_session_disabled {
                    state.log_manager.log_with_category(
                        "info",
                        "Auto unmount skipped for this session (user declined)",
                        Some(task.id.clone()),
                        LogCategory::Other,
                    );
                }
            }
            RuntimeAutoUnmountDecision::SkipDueConflicts => {
                state.log_manager.log_with_category(
                    "warning",
                    "Auto unmount skipped because conflict review is pending",
                    Some(task.id.clone()),
                    LogCategory::Other,
                );
            }
            RuntimeAutoUnmountDecision::RequestConfirmation => {
                state.log_manager.log_with_category(
                    "info",
                    "Auto unmount deferred: no files were copied, waiting for user confirmation",
                    Some(task.id.clone()),
                    LogCategory::Other,
                );
                emit_runtime_auto_unmount_request(
                    &app,
                    &task.id,
                    &task.name,
                    &task.source,
                    exec_result.sync_result.files_copied,
                    exec_result.sync_result.bytes_copied,
                    "zero-copy",
                );
            }
            RuntimeAutoUnmountDecision::UnmountNow => {
                if let Ok(source_path) = resolve_path_with_uuid(&task.source) {
                    if let Err(err) = DiskMonitor::unmount_volume(&source_path) {
                        state.log_manager.log(
                            "warning",
                            &format!("Auto unmount failed: {}", err),
                            Some(task.id.clone()),
                        );
                    }
                }
            }
        }
    }

    let reason = result.err();
    emit_runtime_sync_state(&app, &task.id, false, reason);

    let should_replay = take_runtime_pending_sync_task(&task.id, &state).await;
    if should_replay && is_runtime_watch_task_active(&task.id, &state).await {
        let replay_result = enqueue_runtime_sync_task(
            &task.id,
            &app,
            &state,
            Some("Replay once for watch events detected during sync".to_string()),
        )
        .await;
        if replay_result == RuntimeSyncEnqueueResult::Enqueued {
            schedule_runtime_sync_dispatcher(app.clone(), state.clone());
        }
    }

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
                    let enqueue_result = enqueue_runtime_sync_task(
                        &task_id_for_sync,
                        &app_for_sync,
                        &state_for_sync,
                        Some("Triggered by watch event".to_string()),
                    )
                    .await;

                    if enqueue_result == RuntimeSyncEnqueueResult::Enqueued {
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
                    remove_runtime_sync_task_state(task_id, &state).await;
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
        let enqueue_result = enqueue_runtime_sync_task(
            &task.id,
            &app,
            &state,
            Some("Initial sync after runtime initialization".to_string()),
        )
        .await;

        enqueued_any = enqueued_any || enqueue_result == RuntimeSyncEnqueueResult::Enqueued;
    }

    if enqueued_any {
        schedule_runtime_sync_dispatcher(app, state);
    }
}

#[tauri::command]
async fn get_app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app;
    let config_dir = default_config_dir().map_err(config_store_error_to_string)?;
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
    config_store::app_support_dir_for_app(&app)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(config_store_error_to_string)
}

#[tauri::command]
async fn get_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SettingsEnvelope, String> {
    let settings = current_settings_snapshot(&app, state.inner()).await?;
    Ok(SettingsEnvelope { settings })
}

#[tauri::command]
async fn set_launch_at_login(
    enabled: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SettingsEnvelope, String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("Failed to enable launch at login: {error}"))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| format!("Failed to disable launch at login: {error}"))?;
    }

    let settings = current_settings_snapshot(&app, state.inner()).await?;
    Ok(SettingsEnvelope { settings })
}

#[tauri::command]
async fn update_settings(
    updates: UpdateSettingsPayload,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SettingsEnvelope, String> {
    let mut settings = state
        .config_store
        .load_settings()
        .map_err(config_store_error_to_string)?;
    updates.apply_to(&mut settings);
    validate_settings_record(&settings)?;
    state
        .config_store
        .save_settings(&settings)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["settings"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    sync_control_plane_listener(app.clone(), state.inner().clone(), settings.mcp_enabled).await?;
    let settings = current_settings_snapshot(&app, state.inner()).await?;
    Ok(SettingsEnvelope { settings })
}

#[tauri::command]
async fn reset_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SettingsEnvelope, String> {
    app.autolaunch()
        .disable()
        .map_err(|error| format!("Failed to disable launch at login: {error}"))?;
    state
        .config_store
        .reset_settings()
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["settings"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    sync_control_plane_listener(app.clone(), state.inner().clone(), false).await?;
    let settings = current_settings_snapshot(&app, state.inner()).await?;
    Ok(SettingsEnvelope { settings })
}

#[tauri::command]
async fn list_exclusion_sets(
    state: tauri::State<'_, AppState>,
) -> Result<ExclusionSetsEnvelope, String> {
    let sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    Ok(ExclusionSetsEnvelope { sets })
}

#[tauri::command]
async fn create_exclusion_set(
    set: ExclusionSetRecord,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExclusionSetEnvelope, String> {
    input_validation::validate_task_id(&set.id).map_err(|e| e.to_string())?;
    input_validation::validate_exclude_patterns(&set.patterns).map_err(|e| e.to_string())?;

    let mut sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    if sets.iter().any(|candidate| candidate.id == set.id) {
        return Err(format!("Exclusion set already exists: {}", set.id));
    }
    sets.push(set.clone());
    validate_exclusion_sets(&sets).map_err(config_store_error_to_string)?;
    state
        .config_store
        .save_exclusion_sets(&sets)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["exclusionSets"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    Ok(ExclusionSetEnvelope { set })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExclusionSetUpdatePayload {
    name: Option<String>,
    patterns: Option<Vec<String>>,
}

#[tauri::command]
async fn update_exclusion_set(
    id: String,
    updates: ExclusionSetUpdatePayload,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExclusionSetEnvelope, String> {
    input_validation::validate_task_id(&id).map_err(|e| e.to_string())?;
    if let Some(patterns) = &updates.patterns {
        input_validation::validate_exclude_patterns(patterns).map_err(|e| e.to_string())?;
    }

    let mut sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    let Some(existing_index) = sets.iter().position(|set| set.id == id) else {
        return Err(format!("Exclusion set not found: {id}"));
    };
    let mut set = sets[existing_index].clone();
    if let Some(name) = updates.name {
        set.name = name;
    }
    if let Some(patterns) = updates.patterns {
        set.patterns = patterns;
    }
    sets[existing_index] = set.clone();
    validate_exclusion_sets(&sets).map_err(config_store_error_to_string)?;
    state
        .config_store
        .save_exclusion_sets(&sets)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["exclusionSets"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    Ok(ExclusionSetEnvelope { set })
}

#[tauri::command]
async fn delete_exclusion_set(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteResultEnvelope, String> {
    input_validation::validate_task_id(&id).map_err(|e| e.to_string())?;
    let mut sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    let before_len = sets.len();
    sets.retain(|set| set.id != id);
    let deleted = sets.len() != before_len;
    if deleted {
        state
            .config_store
            .save_exclusion_sets(&sets)
            .map_err(config_store_error_to_string)?;
        emit_config_store_changed(&app, &["exclusionSets"]);
        let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    }
    Ok(DeleteResultEnvelope { deleted })
}

#[tauri::command]
async fn reset_exclusion_sets(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExclusionSetsEnvelope, String> {
    let sets = default_exclusion_set_records();
    validate_exclusion_sets(&sets).map_err(config_store_error_to_string)?;
    state
        .config_store
        .save_exclusion_sets(&sets)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["exclusionSets"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;
    Ok(ExclusionSetsEnvelope { sets })
}

#[tauri::command]
async fn read_yaml_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_yaml_file(
    path: String,
    content: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())?;

    apply_config_write_side_effects(Path::new(&path), app, state.inner().clone()).await
}

#[tauri::command]
async fn read_config_store_file(
    scope: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let scope = ConfigStoreFileScope::parse(&scope)?;
    let path = scope.file_path(&state.config_store);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn repair_config_store_file(
    scope: String,
    content: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let scope = ConfigStoreFileScope::parse(&scope)?;
    validate_repaired_config_store_file(scope, &content)?;

    let path = scope.file_path(&state.config_store);
    state
        .config_store
        .write_raw_file_at_path(&path, content.as_bytes())
        .map_err(config_store_error_to_string)?;

    emit_config_store_changed(&app, &[scope.event_scope()]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.inner().clone()).await?;

    if scope == ConfigStoreFileScope::Settings {
        let settings = state
            .config_store
            .load_settings()
            .map_err(config_store_error_to_string)?;
        sync_control_plane_listener(app.clone(), state.inner().clone(), settings.mcp_enabled)
            .await?;
    }

    Ok(())
}

async fn sync_dry_run_internal(
    app: Option<AppHandle>,
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    checksum_mode: bool,
    exclude_patterns: Vec<String>,
    state: &AppState,
    external_cancel_token: Option<CancellationToken>,
    mcp_job_id: Option<String>,
) -> Result<DryRunResult, String> {
    try_acquire_task_operation(&task_id, TaskOperationKind::DryRun, state).await?;

    let result: Result<DryRunResult, String> = async {
        let source =
            resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        let target =
            resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        ensure_non_overlapping_paths(&source, &target)?;

        input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(source.to_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        input_validation::validate_path_argument(target.to_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;
        let target_preflight = preflight_target_path(&target, false).await?;

        {
            let mut running = state.dry_running_tasks.write().await;
            running.insert(task_id.clone());
        }
        if let Some(app_handle) = app.as_ref() {
            emit_runtime_dry_run_state(
                app_handle,
                &task_id,
                true,
                Some("Dry run started".to_string()),
            );
        }

        state
            .log_manager
            .log("info", "Dry run started", Some(task_id.clone()));
        if target_preflight.kind == TargetPreflightKind::WillCreateDirectory {
            state.log_manager.log(
                "warning",
                &format!(
                    "Target directory does not exist yet; dry run is previewing an empty target: {}",
                    target_preflight.path
                ),
                Some(task_id.clone()),
            );
        }

        let engine = SyncEngine::new(source, target);
        let options = SyncOptions {
            checksum_mode,
            preserve_permissions: true,
            preserve_times: true,
            verify_after_copy: false,
            exclude_patterns,
        };

        let cancel_token = CancellationToken::new();
        if let Some(external_cancel_token) = external_cancel_token {
            let forward_cancel = cancel_token.clone();
            tauri::async_runtime::spawn(async move {
                external_cancel_token.cancelled().await;
                forward_cancel.cancel();
            });
        }

        {
            let mut tokens = state.dry_run_cancel_tokens.write().await;
            tokens.insert(task_id.clone(), cancel_token.clone());
        }

        let live_state = DryRunLiveState::new();
        let progress_target_preflight = target_preflight.clone();
        let diff_target_preflight = target_preflight.clone();

        let progress_state = live_state.clone();
        let progress_app = app.clone();
        let progress_jobs = state.mcp_jobs.clone();
        let progress_job_id = mcp_job_id.clone();
        let progress_task_id = task_id.clone();
        let progress_emit = move |progress: DryRunProgress| {
            let now = Instant::now();
            let (maybe_progress, maybe_batch) = progress_state.record_progress(progress.clone(), now);

            if let Some((diffs, batch_progress)) = maybe_batch {
                if let Some(app_handle) = progress_app.as_ref() {
                    let event = DryRunDiffBatchEvent {
                        task_id: progress_task_id.clone(),
                        phase: batch_progress.phase,
                        message: batch_progress.message.clone(),
                        summary: batch_progress.summary.clone(),
                        diffs,
                        target_preflight: Some(progress_target_preflight.clone()),
                    };
                    emit_dry_run_diff_batch(app_handle, &event);
                }

                if let Some(job_id) = progress_job_id.as_deref() {
                    progress_jobs.try_update_progress(
                        job_id,
                        mcp_progress_from_dry_run(&batch_progress),
                        unix_now_ms(),
                    );
                }
            }

            if let Some(emitted_progress) = maybe_progress {
                if let Some(app_handle) = progress_app.as_ref() {
                    let event = dry_run_progress_event(&progress_task_id, &emitted_progress);
                    emit_dry_run_progress(app_handle, &event);
                }

                if let Some(job_id) = progress_job_id.as_deref() {
                    progress_jobs.try_update_progress(
                        job_id,
                        mcp_progress_from_dry_run(&emitted_progress),
                        unix_now_ms(),
                    );
                }
            }
        };

        let diff_state = live_state.clone();
        let diff_app = app.clone();
        let diff_jobs = state.mcp_jobs.clone();
        let diff_job_id = mcp_job_id.clone();
        let diff_task_id = task_id.clone();
        let diff_emit = move |diff: FileDiff, progress: DryRunProgress| {
            let now = Instant::now();
            if let Some((diffs, batch_progress)) = diff_state.record_diff(diff, progress, now) {
                if let Some(app_handle) = diff_app.as_ref() {
                    let event = DryRunDiffBatchEvent {
                        task_id: diff_task_id.clone(),
                        phase: batch_progress.phase,
                        message: batch_progress.message.clone(),
                        summary: batch_progress.summary.clone(),
                        diffs,
                        target_preflight: Some(diff_target_preflight.clone()),
                    };
                    emit_dry_run_diff_batch(app_handle, &event);
                }

                if let Some(job_id) = diff_job_id.as_deref() {
                    diff_jobs.try_update_progress(
                        job_id,
                        mcp_progress_from_dry_run(&batch_progress),
                        unix_now_ms(),
                    );
                }
            }
        };

        let result = engine
            .dry_run_with_progress(
                &options,
                cancel_token.clone(),
                progress_emit,
                diff_emit,
            )
            .await
            .map_err(|e| format!("{:#}", e));

        {
            let mut tokens = state.dry_run_cancel_tokens.write().await;
            tokens.remove(&task_id);
        }

        let result = match result {
            Ok(result) => result,
            Err(err) => {
                if let Some(final_progress) = live_state.latest_progress() {
                    if let Some((diffs, batch_progress)) =
                        live_state.flush_pending_diffs(final_progress.clone())
                    {
                        if let Some(app_handle) = app.as_ref() {
                            let event = DryRunDiffBatchEvent {
                                task_id: task_id.clone(),
                                phase: batch_progress.phase,
                                message: batch_progress.message.clone(),
                                summary: batch_progress.summary.clone(),
                                diffs,
                                target_preflight: Some(target_preflight.clone()),
                            };
                            emit_dry_run_diff_batch(app_handle, &event);
                        }

                        if let Some(job_id) = mcp_job_id.as_deref() {
                            state.mcp_jobs.try_update_progress(
                                job_id,
                                mcp_progress_from_dry_run(&batch_progress),
                                unix_now_ms(),
                            );
                        }
                    }

                    if let Some(app_handle) = app.as_ref() {
                        let event = dry_run_progress_event(&task_id, &final_progress);
                        emit_dry_run_progress(app_handle, &event);
                    }

                    if let Some(job_id) = mcp_job_id.as_deref() {
                        state.mcp_jobs.try_update_progress(
                            job_id,
                            mcp_progress_from_dry_run(&final_progress),
                            unix_now_ms(),
                        );
                    }
                }

                return Err(err);
            }
        };

        if let Some(final_progress) = live_state.latest_progress().or_else(|| {
            Some(DryRunProgress {
                phase: DryRunPhase::Comparing,
                message: "Dry run completed".to_string(),
                current: result.total_files as u64,
                total: result.total_files as u64,
                processed_bytes: result.bytes_to_copy,
                total_bytes: result.bytes_to_copy,
                summary: DryRunSummary {
                    total_files: result.total_files,
                    files_to_copy: result.files_to_copy,
                    files_modified: result.files_modified,
                    bytes_to_copy: result.bytes_to_copy,
                },
            })
        }) {
            if let Some((diffs, batch_progress)) = live_state.flush_pending_diffs(final_progress.clone()) {
                if let Some(app_handle) = app.as_ref() {
                    let event = DryRunDiffBatchEvent {
                        task_id: task_id.clone(),
                        phase: batch_progress.phase,
                        message: batch_progress.message.clone(),
                        summary: batch_progress.summary.clone(),
                        diffs,
                        target_preflight: Some(target_preflight.clone()),
                    };
                    emit_dry_run_diff_batch(app_handle, &event);
                }

                if let Some(job_id) = mcp_job_id.as_deref() {
                    state.mcp_jobs.try_update_progress(
                        job_id,
                        mcp_progress_from_dry_run(&batch_progress),
                        unix_now_ms(),
                    );
                }
            }

            if let Some(app_handle) = app.as_ref() {
                let event = dry_run_progress_event(&task_id, &final_progress);
                emit_dry_run_progress(app_handle, &event);
            }

            if let Some(job_id) = mcp_job_id.as_deref() {
                state
                    .mcp_jobs
                    .try_update_progress(job_id, mcp_progress_from_dry_run(&final_progress), unix_now_ms());
            }
        }

        Ok({
            let mut result = result;
            result.target_preflight = Some(target_preflight.clone());
            result
        })
    }
    .await;

    {
        let mut running = state.dry_running_tasks.write().await;
        running.remove(&task_id);
    }

    release_task_operation(&task_id, state).await;

    match result {
        Ok(result) => {
            let unit_system = state.runtime_config.read().await.settings.data_unit_system;
            let msg = format!(
                "Dry run completed.\nTo copy: {} files\nTotal size: {}",
                format_number(result.files_to_copy as u64),
                format_bytes_with_unit(result.bytes_to_copy, unit_system)
            );
            state
                .log_manager
                .log("success", &msg, Some(task_id.clone()));
            if let Some(app_handle) = app.as_ref() {
                emit_runtime_dry_run_state(
                    app_handle,
                    &task_id,
                    false,
                    Some("Dry run completed".to_string()),
                );
            }
            Ok(result)
        }
        Err(e) => {
            let err_text = format!("{:#}", e);
            if err_text.contains("cancelled by user") {
                state.log_manager.log(
                    "warning",
                    "Dry run cancelled by user",
                    Some(task_id.clone()),
                );
                if let Some(app_handle) = app.as_ref() {
                    emit_runtime_dry_run_state(
                        app_handle,
                        &task_id,
                        false,
                        Some("Dry run cancelled by user".to_string()),
                    );
                }
                Err("Dry run cancelled by user".to_string())
            } else {
                let msg = format!("Dry run failed: {err_text}");
                state.log_manager.log("error", &msg, Some(task_id.clone()));
                if let Some(app_handle) = app.as_ref() {
                    emit_runtime_dry_run_state(app_handle, &task_id, false, Some(msg.clone()));
                }
                Err(err_text)
            }
        }
    }
}

async fn find_orphan_files_internal(
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    exclude_patterns: Vec<String>,
    state: &AppState,
    external_cancel_token: Option<CancellationToken>,
) -> Result<Vec<OrphanFile>, String> {
    try_acquire_task_operation(&task_id, TaskOperationKind::OrphanScan, state).await?;

    let source =
        resolve_path_with_uuid(source.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    let target =
        resolve_path_with_uuid(target.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
    ensure_non_overlapping_paths(&source, &target)?;

    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(source.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(target.to_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    input_validation::validate_exclude_patterns(&exclude_patterns).map_err(|e| e.to_string())?;

    let engine = SyncEngine::new(source, target);
    let orphans = engine
        .find_orphan_files_with_cancel(&exclude_patterns, external_cancel_token)
        .await
        .map_err(|e| format!("{:#}", e));
    release_task_operation(&task_id, state).await;

    let orphans = orphans?;
    state.log_manager.log_with_category(
        "info",
        &format!("Orphan scan completed: {} candidates", orphans.len()),
        Some(task_id),
        LogCategory::Other,
    );

    Ok(orphans)
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
    let _ = app;
    let config_dir = default_config_dir().map_err(config_store_error_to_string)?;

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
    app: AppHandle,
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    checksum_mode: bool,
    exclude_patterns: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<DryRunResult, String> {
    sync_dry_run_internal(
        Some(app),
        task_id,
        source,
        target,
        checksum_mode,
        exclude_patterns,
        state.inner(),
        None,
        None,
    )
    .await
}

#[tauri::command]
async fn find_orphan_files(
    task_id: String,
    source: PathBuf,
    target: PathBuf,
    exclude_patterns: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<OrphanFile>, String> {
    find_orphan_files_internal(
        task_id,
        source,
        target,
        exclude_patterns,
        state.inner(),
        None,
    )
    .await
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

    let url =
        WebviewUrl::App(format!("index.html?view=conflict-review&sessionId={session_id}").into());
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
                let source_changed =
                    conflict_file_info_changed(&item_snapshot.source, &current_source);
                let target_changed =
                    conflict_file_info_changed(&item_snapshot.target, &current_target);
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

        let apply_result: Result<(ConflictItemStatus, Option<String>), String> = match request
            .action
        {
            ConflictResolutionAction::Skip => Ok((
                ConflictItemStatus::Skipped,
                Some("User chose to skip this conflict item.".to_string()),
            )),
            ConflictResolutionAction::ForceCopy => {
                let producer_id = runtime_conflict_producer_id(
                    &session_id,
                    &request.item_id,
                    RuntimeProducerKind::ConflictForceCopy,
                );
                let target_key = resolved_path_key(target_path.to_string_lossy().as_ref())?;
                register_runtime_producer(
                    producer_id.clone(),
                    RuntimeProducerKind::ConflictForceCopy,
                    target_key.clone(),
                    state.inner(),
                )
                .await;

                let apply_result = copy_file_preserve(&source_path, &target_path)
                    .await
                    .map(|_| {
                        (
                            ConflictItemStatus::ForceCopied,
                            Some("Copied source file to target (force overwrite).".to_string()),
                        )
                    });

                finish_runtime_producer(
                    &producer_id,
                    &target_key,
                    apply_result.is_ok(),
                    Some(&app),
                    state.inner(),
                )
                .await;

                apply_result
            }
            ConflictResolutionAction::RenameThenCopy => {
                let producer_id = runtime_conflict_producer_id(
                    &session_id,
                    &request.item_id,
                    RuntimeProducerKind::ConflictRenameThenCopy,
                );
                let target_key = resolved_path_key(target_path.to_string_lossy().as_ref())?;
                register_runtime_producer(
                    producer_id.clone(),
                    RuntimeProducerKind::ConflictRenameThenCopy,
                    target_key.clone(),
                    state.inner(),
                )
                .await;

                let apply_result = async {
                    let source_path = source_path.clone();
                    let target_path = target_path.clone();
                    let parent = match target_path.parent() {
                        Some(value) => value.to_path_buf(),
                        None => Err("Target file parent directory is invalid".to_string())?,
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
                    let timestamp =
                        safe_copy_timestamp_label(item_snapshot.source.modified_unix_ms);

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
                        None => {
                            Err("Failed to generate non-conflicting backup file name".to_string())?
                        }
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
                .await;

                finish_runtime_producer(
                    &producer_id,
                    &target_key,
                    apply_result.is_ok(),
                    Some(&app),
                    state.inner(),
                )
                .await;

                apply_result
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
    let resolved_path =
        resolve_path_with_uuid(path.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
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
        None,
        None,
    )
    .await?;

    Ok(result)
}

#[tauri::command]
async fn list_sync_tasks(state: tauri::State<'_, AppState>) -> Result<SyncTasksEnvelope, String> {
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    Ok(SyncTasksEnvelope { tasks })
}

#[tauri::command]
async fn find_sync_task_source_recommendations(
    state: tauri::State<'_, AppState>,
) -> Result<SyncTaskSourceRecommendationsEnvelope, String> {
    let recommendations = find_sync_task_source_recommendations_internal(state.inner()).await?;
    Ok(SyncTaskSourceRecommendationsEnvelope { recommendations })
}

#[tauri::command]
async fn get_sync_task(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncTaskEnvelope, String> {
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let task = tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("Sync task not found: {task_id}"))?;
    Ok(SyncTaskEnvelope { task })
}

#[tauri::command]
async fn create_sync_task(
    task: SyncTaskRecord,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SyncTaskEnvelope, String> {
    let task = create_sync_task_internal(task, app, state.inner()).await?;
    Ok(SyncTaskEnvelope { task })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncTaskUpdatePayload {
    name: Option<String>,
    source: Option<String>,
    target: Option<String>,
    checksum_mode: Option<bool>,
    verify_after_copy: Option<bool>,
    exclusion_sets: Option<Vec<String>>,
    watch_mode: Option<bool>,
    auto_unmount: Option<bool>,
    source_type: Option<config_store::SourceType>,
    source_uuid: Option<String>,
    source_uuid_type: Option<config_store::SourceUuidType>,
    source_sub_path: Option<String>,
    source_identity: Option<config_store::SourceIdentitySnapshot>,
}

#[tauri::command]
async fn update_sync_task(
    id: String,
    updates: SyncTaskUpdatePayload,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SyncTaskEnvelope, String> {
    let task = patch_sync_task_internal(
        config_store::UpdateSyncTaskRequest {
            task_id: id,
            name: updates.name,
            source: updates.source,
            target: updates.target,
            checksum_mode: updates.checksum_mode,
            verify_after_copy: updates.verify_after_copy,
            exclusion_sets: updates.exclusion_sets,
            watch_mode: updates.watch_mode,
            auto_unmount: updates.auto_unmount,
            source_type: updates.source_type,
            source_uuid: updates.source_uuid,
            source_uuid_type: updates.source_uuid_type,
            source_sub_path: updates.source_sub_path,
            source_identity: updates.source_identity,
        },
        app,
        state.inner(),
    )
    .await?;
    Ok(SyncTaskEnvelope { task })
}

#[tauri::command]
async fn delete_sync_task(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteResultEnvelope, String> {
    let deleted = delete_sync_task_internal(id, app, state.inner()).await?;
    Ok(DeleteResultEnvelope { deleted })
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum CancelOperationType {
    Sync,
    DryRun,
}

async fn cancel_operation_internal(
    task_id: &str,
    operation_type: CancelOperationType,
    state: &AppState,
) -> bool {
    let token = match operation_type {
        CancelOperationType::Sync => {
            let tokens = state.cancel_tokens.read().await;
            tokens.get(task_id).cloned()
        }
        CancelOperationType::DryRun => {
            let tokens = state.dry_run_cancel_tokens.read().await;
            tokens.get(task_id).cloned()
        }
    };

    if let Some(token) = token {
        token.cancel();
        let message = match operation_type {
            CancelOperationType::Sync => "Sync cancelled by user",
            CancelOperationType::DryRun => "Dry run cancelled by user",
        };
        state
            .log_manager
            .log("warning", message, Some(task_id.to_string()));
        true
    } else {
        false
    }
}

/// 실행 중인 동기화 작업을 취소합니다.
#[tauri::command]
async fn cancel_operation(
    task_id: String,
    operation_type: CancelOperationType,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(cancel_operation_internal(&task_id, operation_type, state.inner()).await)
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
    remove_runtime_sync_task_state(&task_id, state.inner()).await;

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
    let _apply_guard = state.runtime_config_apply_lock.clone().lock_owned().await;

    validate_runtime_tasks(&payload.tasks)?;
    let valid_task_ids: HashSet<String> =
        payload.tasks.iter().map(|task| task.id.clone()).collect();

    for set in &payload.exclusion_sets {
        input_validation::validate_exclude_patterns(&set.patterns).map_err(|e| e.to_string())?;
    }

    {
        let mut config = state.runtime_config.write().await;
        *config = payload;
    }
    prune_auto_unmount_session_disabled_tasks(&valid_task_ids, state.inner()).await;

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
async fn runtime_validate_tasks(
    tasks: Vec<RuntimeSyncTask>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<RuntimeTaskValidationResult, String> {
    if let Some(issue) = find_runtime_task_validation_issue(&tasks) {
        record_runtime_validation_issue(&issue, Some(&app), state.inner());
        return Ok(RuntimeTaskValidationResult {
            ok: false,
            issue: Some(issue),
        });
    }

    Ok(RuntimeTaskValidationResult {
        ok: true,
        issue: None,
    })
}

#[tauri::command]
async fn runtime_get_state(state: tauri::State<'_, AppState>) -> Result<RuntimeState, String> {
    Ok(runtime_get_state_internal(state.inner()).await)
}

#[tauri::command]
async fn set_auto_unmount_session_disabled(
    task_id: String,
    disabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    set_auto_unmount_session_disabled_internal(&task_id, disabled, state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn is_auto_unmount_session_disabled(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    Ok(is_auto_unmount_session_disabled_internal(&task_id, state.inner()).await)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdParams {
    task_id: String,
}

async fn load_task_context(
    task_id: &str,
    state: &AppState,
) -> Result<(SyncTaskRecord, Vec<String>), String> {
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let exclusion_sets = state
        .config_store
        .load_exclusion_sets()
        .map_err(config_store_error_to_string)?;
    let task = tasks
        .into_iter()
        .find(|candidate| candidate.id == task_id)
        .ok_or_else(|| format!("Sync task not found: {task_id}"))?;
    let runtime_task = to_runtime_task_record(&task);
    let runtime_sets: Vec<RuntimeExclusionSet> = exclusion_sets
        .iter()
        .map(to_runtime_exclusion_set_record)
        .collect();
    let exclude_patterns = resolve_runtime_exclude_patterns(&runtime_task, &runtime_sets);
    Ok((task, exclude_patterns))
}

async fn spawn_mcp_sync_job(
    task_id: String,
    app: tauri::AppHandle,
    state: AppState,
) -> Result<String, String> {
    let (task, exclude_patterns) = load_task_context(&task_id, &state).await?;
    let seq = state.mcp_job_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let job_id = next_mcp_job_id(McpJobKind::Sync, seq);
    let now = unix_now_ms();
    let job = McpJobRecord::new(job_id.clone(), McpJobKind::Sync, Some(task.id.clone()), now);
    state.mcp_jobs.insert_job(job).await;

    let cancel_token = CancellationToken::new();
    state
        .mcp_jobs
        .attach_cancel_token(&job_id, cancel_token.clone())
        .await;

    let app_for_job = app.clone();
    let state_for_job = state.clone();
    let job_id_for_job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        state_for_job
            .mcp_jobs
            .set_status(&job_id_for_job, McpJobStatus::Running, unix_now_ms())
            .await;
        let result = execute_sync_internal(
            task.id.clone(),
            task.name.clone(),
            PathBuf::from(task.source.clone()),
            PathBuf::from(task.target.clone()),
            task.checksum_mode,
            task.verify_after_copy,
            exclude_patterns,
            app_for_job,
            state_for_job.clone(),
            false,
            SyncOrigin::Manual,
            Some(cancel_token.clone()),
            Some(job_id_for_job.clone()),
        )
        .await;
        state_for_job
            .mcp_jobs
            .detach_cancel_token(&job_id_for_job)
            .await;

        match result {
            Ok(result) => {
                if let Ok(json) = serde_json::to_value(result) {
                    state_for_job
                        .mcp_jobs
                        .complete_job(&job_id_for_job, json, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(
                            &job_id_for_job,
                            "Failed to serialize sync result".to_string(),
                            unix_now_ms(),
                        )
                        .await;
                }
            }
            Err(error) => {
                if cancel_token.is_cancelled() {
                    state_for_job
                        .mcp_jobs
                        .set_status(&job_id_for_job, McpJobStatus::Cancelled, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(&job_id_for_job, error, unix_now_ms())
                        .await;
                }
            }
        }
    });

    Ok(job_id)
}

async fn spawn_mcp_dry_run_job(
    task_id: String,
    app: AppHandle,
    state: AppState,
) -> Result<String, String> {
    let (task, exclude_patterns) = load_task_context(&task_id, &state).await?;
    let seq = state.mcp_job_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let job_id = next_mcp_job_id(McpJobKind::DryRun, seq);
    state
        .mcp_jobs
        .insert_job(McpJobRecord::new(
            job_id.clone(),
            McpJobKind::DryRun,
            Some(task.id.clone()),
            unix_now_ms(),
        ))
        .await;

    let cancel_token = CancellationToken::new();
    state
        .mcp_jobs
        .attach_cancel_token(&job_id, cancel_token.clone())
        .await;

    let state_for_job = state.clone();
    let job_id_for_job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        state_for_job
            .mcp_jobs
            .set_status(&job_id_for_job, McpJobStatus::Running, unix_now_ms())
            .await;
        let result = sync_dry_run_internal(
            Some(app.clone()),
            task.id.clone(),
            PathBuf::from(task.source.clone()),
            PathBuf::from(task.target.clone()),
            task.checksum_mode,
            exclude_patterns,
            &state_for_job,
            Some(cancel_token.clone()),
            Some(job_id_for_job.clone()),
        )
        .await;
        state_for_job
            .mcp_jobs
            .detach_cancel_token(&job_id_for_job)
            .await;

        match result {
            Ok(result) => {
                if let Ok(json) = serde_json::to_value(result) {
                    state_for_job
                        .mcp_jobs
                        .complete_job(&job_id_for_job, json, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(
                            &job_id_for_job,
                            "Failed to serialize dry-run result".to_string(),
                            unix_now_ms(),
                        )
                        .await;
                }
            }
            Err(error) => {
                if cancel_token.is_cancelled() {
                    state_for_job
                        .mcp_jobs
                        .set_status(&job_id_for_job, McpJobStatus::Cancelled, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(&job_id_for_job, error, unix_now_ms())
                        .await;
                }
            }
        }
    });

    Ok(job_id)
}

async fn spawn_mcp_orphan_scan_job(task_id: String, state: AppState) -> Result<String, String> {
    let (task, exclude_patterns) = load_task_context(&task_id, &state).await?;
    let seq = state.mcp_job_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let job_id = next_mcp_job_id(McpJobKind::OrphanScan, seq);
    state
        .mcp_jobs
        .insert_job(McpJobRecord::new(
            job_id.clone(),
            McpJobKind::OrphanScan,
            Some(task.id.clone()),
            unix_now_ms(),
        ))
        .await;

    let cancel_token = CancellationToken::new();
    state
        .mcp_jobs
        .attach_cancel_token(&job_id, cancel_token.clone())
        .await;

    let state_for_job = state.clone();
    let job_id_for_job = job_id.clone();
    tauri::async_runtime::spawn(async move {
        state_for_job
            .mcp_jobs
            .set_status(&job_id_for_job, McpJobStatus::Running, unix_now_ms())
            .await;
        let result = find_orphan_files_internal(
            task.id.clone(),
            PathBuf::from(task.source.clone()),
            PathBuf::from(task.target.clone()),
            exclude_patterns,
            &state_for_job,
            Some(cancel_token.clone()),
        )
        .await;
        state_for_job
            .mcp_jobs
            .detach_cancel_token(&job_id_for_job)
            .await;

        match result {
            Ok(result) => {
                if let Ok(json) = serde_json::to_value(result) {
                    state_for_job
                        .mcp_jobs
                        .complete_job(&job_id_for_job, json, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(
                            &job_id_for_job,
                            "Failed to serialize orphan scan result".to_string(),
                            unix_now_ms(),
                        )
                        .await;
                }
            }
            Err(error) => {
                if cancel_token.is_cancelled() {
                    state_for_job
                        .mcp_jobs
                        .set_status(&job_id_for_job, McpJobStatus::Cancelled, unix_now_ms())
                        .await;
                } else {
                    state_for_job
                        .mcp_jobs
                        .fail_job(&job_id_for_job, error, unix_now_ms())
                        .await;
                }
            }
        }
    });

    Ok(job_id)
}

async fn handle_control_plane_request(
    request: ControlPlaneRequest,
    app: tauri::AppHandle,
    state: AppState,
) -> ControlPlaneResponse {
    let request_id = request.request_id.clone();
    let response = match request.method.as_str() {
        "syncwatcher_get_settings" => current_settings_snapshot(&app, &state)
            .await
            .map(|settings| serde_json::json!({ "settings": settings })),
        "syncwatcher_update_settings" => {
            let updates = serde_json::from_value::<McpSettingsPatch>(request.params.clone())
                .map_err(|error| format!("Invalid settings payload: {error}"));
            match updates {
                Ok(updates) => {
                    let updates: UpdateSettingsPayload = updates.into();
                    let mut settings = match state.config_store.load_settings() {
                        Ok(settings) => settings,
                        Err(error) => {
                            return ControlPlaneResponse::error(
                                request_id,
                                "load_failed",
                                config_store_error_to_string(error),
                            )
                        }
                    };
                    updates.apply_to(&mut settings);
                    match validate_settings_record(&settings) {
                        Ok(()) => match state.config_store.save_settings(&settings) {
                            Ok(()) => {
                                emit_config_store_changed(&app, &["settings"]);
                                let apply_result =
                                    apply_canonical_config_to_runtime(app.clone(), state.clone())
                                        .await;
                                if let Err(error) = apply_result {
                                    Err(error)
                                } else {
                                    let snapshot = match current_settings_snapshot(&app, &state)
                                        .await
                                    {
                                        Ok(settings) => serde_json::json!({ "settings": settings }),
                                        Err(error) => {
                                            return ControlPlaneResponse::error(
                                                request_id,
                                                "request_failed",
                                                error,
                                            );
                                        }
                                    };
                                    if !settings.mcp_enabled {
                                        if let Err(error) =
                                            stop_control_plane_listener(state.clone()).await
                                        {
                                            return ControlPlaneResponse::error(
                                                request_id,
                                                "request_failed",
                                                error,
                                            );
                                        }
                                    }
                                    Ok(snapshot)
                                }
                            }
                            Err(error) => Err(config_store_error_to_string(error)),
                        },
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "syncwatcher_list_sync_tasks" => state
            .config_store
            .load_tasks()
            .map_err(config_store_error_to_string)
            .map(|tasks| serde_json::json!({ "tasks": tasks })),
        "syncwatcher_get_sync_task" => {
            let params = serde_json::from_value::<TaskIdParams>(request.params.clone())
                .map_err(|error| format!("Invalid task id payload: {error}"));
            match params {
                Ok(params) => get_sync_task_internal_json(&params.task_id, &state).await,
                Err(error) => Err(error),
            }
        }
        "syncwatcher_create_sync_task" => {
            let task = serde_json::from_value::<NewSyncTaskRecord>(request.params.clone())
                .map_err(|error| format!("Invalid sync task payload: {error}"));
            match task {
                Ok(task) => {
                    let generated_id = format!(
                        "task-{}-{}",
                        unix_now_ms(),
                        state.mcp_job_seq.fetch_add(1, Ordering::SeqCst) + 1
                    );
                    let task = build_sync_task_record(generated_id, task)
                        .map_err(config_store_error_to_string);
                    match task {
                        Ok(task) => {
                            match create_sync_task_internal(task, app.clone(), &state).await {
                                Ok(task) => Ok(serde_json::json!({ "task": task })),
                                Err(error) => Err(error),
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "syncwatcher_update_sync_task" => {
            let update = serde_json::from_value::<UpdateSyncTaskRequest>(request.params.clone())
                .map_err(|error| format!("Invalid sync task payload: {error}"));
            match update {
                Ok(update) => match patch_sync_task_internal(update, app.clone(), &state).await {
                    Ok(task) => Ok(serde_json::json!({ "task": task })),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            }
        }
        "syncwatcher_delete_sync_task" => {
            let params = serde_json::from_value::<TaskIdParams>(request.params.clone())
                .map_err(|error| format!("Invalid task id payload: {error}"));
            match params {
                Ok(params) => {
                    match delete_sync_task_internal(params.task_id, app.clone(), &state).await {
                        Ok(deleted) => Ok(serde_json::json!({ "deleted": deleted })),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "syncwatcher_start_dry_run" => {
            let params = serde_json::from_value::<TaskIdParams>(request.params.clone())
                .map_err(|error| format!("Invalid task id payload: {error}"));
            match params {
                Ok(params) => spawn_mcp_dry_run_job(params.task_id, app.clone(), state.clone())
                    .await
                    .map(|job_id| serde_json::json!({ "jobId": job_id })),
                Err(error) => Err(error),
            }
        }
        "syncwatcher_start_sync" => {
            let params = serde_json::from_value::<TaskIdParams>(request.params.clone())
                .map_err(|error| format!("Invalid task id payload: {error}"));
            match params {
                Ok(params) => spawn_mcp_sync_job(params.task_id, app.clone(), state.clone())
                    .await
                    .map(|job_id| serde_json::json!({ "jobId": job_id })),
                Err(error) => Err(error),
            }
        }
        "syncwatcher_start_orphan_scan" => {
            let params = serde_json::from_value::<TaskIdParams>(request.params.clone())
                .map_err(|error| format!("Invalid task id payload: {error}"));
            match params {
                Ok(params) => spawn_mcp_orphan_scan_job(params.task_id, state.clone())
                    .await
                    .map(|job_id| serde_json::json!({ "jobId": job_id })),
                Err(error) => Err(error),
            }
        }
        "syncwatcher_get_job" => {
            let params = serde_json::from_value::<serde_json::Value>(request.params.clone())
                .map_err(|error| format!("Invalid job payload: {error}"));
            match params {
                Ok(params) => {
                    let job_id = params
                        .get("jobId")
                        .and_then(|value| value.as_str())
                        .ok_or_else(|| "jobId is required".to_string());
                    match job_id {
                        Ok(job_id) => state
                            .mcp_jobs
                            .get_job(job_id)
                            .await
                            .map(|job| serde_json::json!({ "job": job }))
                            .ok_or_else(|| format!("Job not found: {job_id}")),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "syncwatcher_cancel_job" => {
            let params = serde_json::from_value::<serde_json::Value>(request.params.clone())
                .map_err(|error| format!("Invalid job payload: {error}"));
            match params {
                Ok(params) => {
                    let job_id = params
                        .get("jobId")
                        .and_then(|value| value.as_str())
                        .ok_or_else(|| "jobId is required".to_string());
                    match job_id {
                        Ok(job_id) => state
                            .mcp_jobs
                            .cancel_job(job_id, unix_now_ms())
                            .await
                            .then_some(serde_json::json!({ "cancelled": true }))
                            .ok_or_else(|| format!("Job not found or not cancellable: {job_id}")),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "syncwatcher_get_runtime_state" => Ok(serde_json::json!({
            "runtimeState": runtime_get_state_internal(&state).await
        })),
        "syncwatcher_list_removable_volumes" => {
            get_removable_volumes().map(|volumes| serde_json::json!({ "volumes": volumes }))
        }
        _ => Err(format!(
            "Unsupported control-plane method: {}",
            request.method
        )),
    };

    match response {
        Ok(result) => ControlPlaneResponse::ok(request_id, result),
        Err(error) => ControlPlaneResponse::error(request_id, "request_failed", error),
    }
}

async fn get_sync_task_internal_json(
    task_id: &str,
    state: &AppState,
) -> Result<serde_json::Value, String> {
    input_validation::validate_task_id(task_id).map_err(|e| e.to_string())?;
    let tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let task = tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("Sync task not found: {task_id}"))?;
    Ok(serde_json::json!({ "task": task }))
}

async fn create_sync_task_internal(
    task: SyncTaskRecord,
    app: tauri::AppHandle,
    state: &AppState,
) -> Result<SyncTaskRecord, String> {
    let mut task = normalize_sync_task_record(task);
    let current_volumes = DiskMonitor::new()
        .list_volumes()
        .map_err(|error| format!("Failed to list mounted volumes: {error}"))?;
    refresh_uuid_source_identity(&mut task, &current_volumes);
    input_validation::validate_task_id(&task.id).map_err(|e| e.to_string())?;
    let mut tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    if tasks.iter().any(|existing| existing.id == task.id) {
        return Err(format!("Sync task already exists: {}", task.id));
    }
    tasks.push(task.clone());
    validate_sync_task_records(&tasks)?;
    state
        .config_store
        .save_tasks(&tasks)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["syncTasks"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.clone()).await?;
    Ok(task)
}

async fn patch_sync_task_internal(
    update: UpdateSyncTaskRequest,
    app: tauri::AppHandle,
    state: &AppState,
) -> Result<SyncTaskRecord, String> {
    input_validation::validate_task_id(&update.task_id).map_err(|e| e.to_string())?;
    let mut tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let Some(index) = tasks
        .iter()
        .position(|existing| existing.id == update.task_id)
    else {
        return Err(format!("Sync task not found: {}", update.task_id));
    };
    let mut task = apply_sync_task_update(tasks[index].clone(), &update)
        .map_err(config_store_error_to_string)?;
    let current_volumes = DiskMonitor::new()
        .list_volumes()
        .map_err(|error| format!("Failed to list mounted volumes: {error}"))?;
    refresh_uuid_source_identity(&mut task, &current_volumes);
    tasks[index] = task.clone();
    validate_sync_task_records(&tasks)?;
    state
        .config_store
        .save_tasks(&tasks)
        .map_err(config_store_error_to_string)?;
    emit_config_store_changed(&app, &["syncTasks"]);
    let _ = apply_canonical_config_to_runtime(app.clone(), state.clone()).await?;
    Ok(task)
}

async fn delete_sync_task_internal(
    task_id: String,
    app: tauri::AppHandle,
    state: &AppState,
) -> Result<bool, String> {
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    let mut tasks = state
        .config_store
        .load_tasks()
        .map_err(config_store_error_to_string)?;
    let before_len = tasks.len();
    tasks.retain(|task| task.id != task_id);
    let deleted = tasks.len() != before_len;
    if deleted {
        state
            .config_store
            .save_tasks(&tasks)
            .map_err(config_store_error_to_string)?;
        emit_config_store_changed(&app, &["syncTasks"]);
        let _ = apply_canonical_config_to_runtime(app.clone(), state.clone()).await?;
    }
    Ok(deleted)
}

#[derive(
    Debug, Copy, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema, Default,
)]
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
async fn quit_app(
    app: tauri::AppHandle,
    exit_control: tauri::State<'_, AppExitControl>,
) -> Result<(), String> {
    exit_control.allow_force_exit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

pub(crate) fn has_autostart_arg<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new(AUTOSTART_ARG))
}

fn is_autostart_launch() -> bool {
    has_autostart_arg(std::env::args_os())
}

pub(crate) fn decide_autostart_launch(
    argv_present: bool,
    autolaunch_enabled: Result<bool, String>,
) -> AutostartLaunchDecision {
    if !argv_present {
        return AutostartLaunchDecision {
            argv_present,
            autolaunch_enabled: None,
            hidden_start_accepted: false,
            reject_reason: None,
            status_error: None,
        };
    }

    match autolaunch_enabled {
        Ok(true) => AutostartLaunchDecision {
            argv_present,
            autolaunch_enabled: Some(true),
            hidden_start_accepted: true,
            reject_reason: None,
            status_error: None,
        },
        Ok(false) => AutostartLaunchDecision {
            argv_present,
            autolaunch_enabled: Some(false),
            hidden_start_accepted: false,
            reject_reason: Some("launch_at_login_disabled"),
            status_error: None,
        },
        Err(error) => AutostartLaunchDecision {
            argv_present,
            autolaunch_enabled: None,
            hidden_start_accepted: false,
            reject_reason: Some("launch_at_login_status_unavailable"),
            status_error: Some(error),
        },
    }
}

fn log_autostart_launch_provenance(decision: &AutostartLaunchDecision) {
    let autolaunch_enabled = decision
        .autolaunch_enabled
        .map(|enabled| enabled.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let reject_reason = decision.reject_reason.unwrap_or("none");

    if let Some(error) = &decision.status_error {
        eprintln!(
            "[Autostart] argv_present={} autolaunch_enabled={} hidden_start={} reject_reason={} status_error={}",
            decision.argv_present,
            autolaunch_enabled,
            decision.hidden_start_status(),
            reject_reason,
            error
        );
    } else {
        eprintln!(
            "[Autostart] argv_present={} autolaunch_enabled={} hidden_start={} reject_reason={}",
            decision.argv_present,
            autolaunch_enabled,
            decision.hidden_start_status(),
            reject_reason
        );
    }
}

fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[App] Main window not found");
        return;
    };

    #[cfg(target_os = "macos")]
    {
        if let Err(err) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            eprintln!("[App] Failed to set activation policy: {}", err);
        }
    }

    if let Err(err) = window.show() {
        eprintln!("[App] Failed to show main window: {}", err);
    }
    if let Err(err) = window.unminimize() {
        eprintln!("[App] Failed to unminimize main window: {}", err);
    }
    if let Err(err) = window.set_focus() {
        eprintln!("[App] Failed to focus main window: {}", err);
    }
}

fn build_app_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("SyncWatcher"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();

    let app_menu = SubmenuBuilder::new(app, "SyncWatcher")
        .about(Some(about_metadata))
        .separator()
        .text(APP_CHECK_FOR_UPDATES_MENU_ID, "Check for Updates…")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()
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
    let managed_config_store = Arc::new(ConfigStore::from_config_dir(
        default_config_dir().expect("failed to resolve SyncWatcher config directory"),
    ));
    let autostart_args = vec![AUTOSTART_ARG];

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(autostart_args),
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_menu_event(|app, event| {
            eprintln!("[App] Menu event: {}", event.id.as_ref());
            let menu_id = event.id.as_ref().to_ascii_lowercase();
            if event.id.as_ref() == APP_CHECK_FOR_UPDATES_MENU_ID {
                let _ = app.emit(APP_CHECK_FOR_UPDATES_EVENT, ());
                return;
            }
            let looks_like_quit = menu_id == "quit"
                || menu_id.ends_with("-quit")
                || menu_id.ends_with("_quit")
                || menu_id.ends_with(".quit")
                || menu_id.ends_with(":quit");

            if looks_like_quit && !menu_id.starts_with("tray_") && !menu_id.starts_with("tray-") {
                eprintln!("[App] Menu event mapped to cmd-quit");
                emit_close_requested(app, CloseRequestSource::CmdQuit);
            }
        })
        .setup(move |app| {
            app.set_menu(build_app_menu(app)?)?;

            let autostart_arg_present = is_autostart_launch();
            let autostart_enabled = if autostart_arg_present {
                app.autolaunch()
                    .is_enabled()
                    .map_err(|error| error.to_string())
            } else {
                Ok(false)
            };
            let autostart_decision =
                decide_autostart_launch(autostart_arg_present, autostart_enabled);
            let should_hide_on_startup = autostart_decision.hidden_start_accepted;
            log_autostart_launch_provenance(&autostart_decision);

            if should_hide_on_startup {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.hide();
                }

                #[cfg(target_os = "macos")]
                {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }

            // 윈도우 위치 조정
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _ = adjust_window_if_mostly_offscreen(&main_window);
                    if !should_hide_on_startup {
                        match main_window.is_visible() {
                            Ok(true) => {}
                            Ok(false) | Err(_) => restore_main_window(&app_handle),
                        }
                    }
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
                            restore_main_window(app);
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
                            restore_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // main window close intercept
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        eprintln!("[App] Window close requested");
                        api.prevent_close();
                        emit_close_requested(&app_handle, CloseRequestSource::WindowClose);
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
                        let next_tick =
                            volume_watch_next_tick_delay(&emit_state, now, debounce_duration);

                        if let Some(delay) = next_tick {
                            if delay.is_zero() {
                                if handle_volume_watch_tick(&mut emit_state, now, debounce_duration)
                                {
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

            let runtime_init_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = runtime_init_app.state::<AppState>();
                if let Err(error) = apply_canonical_config_to_runtime(
                    runtime_init_app.clone(),
                    state.inner().clone(),
                )
                .await
                {
                    eprintln!("[ConfigStore] Failed to apply canonical runtime config: {error}");
                    return;
                }

                match state.config_store.load_settings() {
                    Ok(settings) => {
                        if let Err(error) = sync_control_plane_listener(
                            runtime_init_app.clone(),
                            state.inner().clone(),
                            settings.mcp_enabled,
                        )
                        .await
                        {
                            eprintln!(
                                "[ConfigStore] Failed to sync control plane listener: {error}"
                            );
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "[ConfigStore] Failed to load settings for control plane sync: {}",
                            config_store_error_to_string(error)
                        );
                    }
                }
            });

            Ok(())
        })
        .manage(AppState {
            config_store: managed_config_store,
            log_manager: managed_log_manager,
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            dry_run_cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            dry_running_tasks: Arc::new(RwLock::new(HashSet::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
            runtime_config: Arc::new(RwLock::new(RuntimeConfigPayload::default())),
            syncing_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_sync_queue: Arc::new(RwLock::new(VecDeque::new())),
            queued_sync_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_pending_sync_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_dispatcher_running: Arc::new(Mutex::new(false)),
            runtime_dispatcher_wakeup: Arc::new(Notify::new()),
            runtime_sync_slot_released: Arc::new(Notify::new()),
            runtime_chain_settle_until: Arc::new(RwLock::new(HashMap::new())),
            runtime_active_producers: Arc::new(RwLock::new(HashMap::new())),
            runtime_initial_watch_bootstrapped: Arc::new(AtomicBool::new(false)),
            runtime_config_apply_lock: Arc::new(Mutex::new(())),
            runtime_watch_sources: Arc::new(RwLock::new(HashMap::new())),
            auto_unmount_session_disabled_tasks: Arc::new(RwLock::new(HashSet::new())),
            conflict_review_sessions: Arc::new(RwLock::new(HashMap::new())),
            conflict_review_seq: Arc::new(AtomicU64::new(0)),
            active_task_operations: Arc::new(RwLock::new(HashMap::new())),
            control_plane_handle: Arc::new(Mutex::new(None)),
            mcp_jobs: Arc::new(McpJobRegistry::new()),
            mcp_job_seq: Arc::new(AtomicU64::new(0)),
        })
        .manage(AppExitControl::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            get_settings,
            set_launch_at_login,
            update_settings,
            reset_settings,
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
            find_sync_task_source_recommendations,
            get_sync_task,
            create_sync_task,
            update_sync_task,
            delete_sync_task,
            list_exclusion_sets,
            create_exclusion_set,
            update_exclusion_set,
            delete_exclusion_set,
            reset_exclusion_sets,
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
            set_auto_unmount_session_disabled,
            is_auto_unmount_session_disabled,
            get_app_config_dir,
            join_paths,
            read_yaml_file,
            write_yaml_file,
            read_config_store_file,
            repair_config_store_file,
            ensure_directory_exists,
            file_exists,
            open_in_editor,
            add_log,
            get_system_logs,
            get_task_logs,
            generate_licenses_report,
            license_validation::activate_license_key,
            license_validation::deactivate_license_key,
            license_validation::validate_license_key,
            license_validation::get_license_status,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            let allow_force_exit = app_handle
                .state::<AppExitControl>()
                .allow_force_exit
                .swap(false, Ordering::SeqCst);

            if allow_force_exit {
                return;
            }

            eprintln!(
                "[App] ExitRequested intercepted by frontend close flow (code={:?})",
                code
            );
            api.prevent_exit();
            emit_close_requested(app_handle, CloseRequestSource::CmdQuit);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                eprintln!("[App] Reopen event restoring hidden main window");
                restore_main_window(app_handle);
            }
        }
        _ => {}
    });
}
