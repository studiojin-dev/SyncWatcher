#[cfg(test)]
mod integration_tests {
    use crate::config_store::{
        apply_sync_task_update, launch_at_login_status_or_default, ConfigStore,
        SourceIdentitySnapshot, SourceType, SourceUuidType, SyncTaskRecord, UpdateSyncTaskRequest,
    };
    use crate::logging::LogManager;
    use crate::mcp_jobs::McpJobRegistry;
    use crate::recurring::RecurringScheduleHistoryStore;
    use crate::sync_engine::types::{
        DryRunPhase, DryRunProgress, DryRunSummary, FileDiff, FileDiffKind, TargetPreflightKind,
    };
    use crate::system_integration::VolumeInfo;
    use crate::watcher::WatcherManager;
    use crate::{
        build_runtime_watch_upstreams, build_validated_runtime_tasks,
        can_enqueue_runtime_watch_bootstrap_task, cancel_operation_internal,
        classify_missing_target_path, compute_volume_mount_diff, decide_autostart_launch,
        decide_runtime_auto_unmount, dequeue_runtime_sync_task, enqueue_runtime_sync_task_internal,
        enqueue_runtime_watch_bootstrap_tasks, ensure_non_overlapping_paths,
        find_orphan_files_internal, find_runtime_orphan_target_conflict_issue,
        find_runtime_task_validation_issue, find_runtime_watch_cycle,
        find_task_source_recommendation, finish_runtime_producer, format_bytes_with_unit,
        get_app_version, handle_volume_watch_event, handle_volume_watch_tick, has_autostart_arg,
        is_auto_unmount_session_disabled_internal, is_runtime_watch_task_active, join_paths,
        mark_downstream_watch_tasks_settle_for_target, normalize_uuid_sub_path,
        parse_uuid_source_path, preflight_target_path, progress_phase_to_log_category,
        prune_auto_unmount_session_disabled_tasks, record_runtime_validation_issue,
        refresh_uuid_source_identity, remove_runtime_sync_task_state,
        resolve_runtime_exclude_patterns, runtime_desired_watch_sources, runtime_find_watch_task,
        runtime_get_state_internal, runtime_validation_issue_log_message,
        runtime_watch_bootstrap_task_ids, runtime_watch_task_needs_restart,
        select_runtime_dispatch_candidate, set_auto_unmount_session_disabled_internal,
        sync_dry_run_internal, take_runtime_pending_sync_task, validate_runtime_tasks,
        volume_watch_next_tick_delay, AppState, CancelOperationType, DataUnitSystem,
        DryRunLiveState, RuntimeActiveProducer, RuntimeAutoUnmountDecision, RuntimeExclusionSet,
        RuntimeProducerKind, RuntimeSyncEnqueueResult, RuntimeSyncTask, RuntimeTaskValidationCode,
        RuntimeTaskValidationIssue, VolumeEmitDebounceState,
    };
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Arc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tokio::sync::{Mutex, Notify, RwLock};
    use tokio_util::sync::CancellationToken;

    fn temp_config_dir() -> PathBuf {
        let seq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("syncwatcher-lib-tests-{seq}"))
    }

    fn build_runtime_task(id: &str, source: &str, watch_mode: bool) -> RuntimeSyncTask {
        RuntimeSyncTask {
            id: id.to_string(),
            name: format!("task-{id}"),
            source: source.to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            watch_mode,
            auto_unmount: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
        }
    }

    fn build_runtime_task_with_paths(
        id: &str,
        source: &str,
        target: &str,
        watch_mode: bool,
    ) -> RuntimeSyncTask {
        RuntimeSyncTask {
            id: id.to_string(),
            name: format!("task-{id}"),
            source: source.to_string(),
            target: target.to_string(),
            checksum_mode: false,
            watch_mode,
            auto_unmount: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
        }
    }

    fn build_dry_run_progress(
        phase: DryRunPhase,
        message: &str,
        current: u64,
        total: u64,
        total_files: usize,
        files_to_copy: usize,
        files_modified: usize,
        bytes_to_copy: u64,
    ) -> DryRunProgress {
        DryRunProgress {
            phase,
            message: message.to_string(),
            current,
            total,
            processed_bytes: bytes_to_copy,
            total_bytes: bytes_to_copy,
            summary: DryRunSummary {
                total_files,
                files_to_copy,
                files_modified,
                bytes_to_copy,
            },
        }
    }

    fn build_uuid_task(
        id: &str,
        source_uuid_type: SourceUuidType,
        source_uuid: &str,
        source_sub_path: &str,
        source_identity: Option<SourceIdentitySnapshot>,
    ) -> SyncTaskRecord {
        let token = match source_uuid_type {
            SourceUuidType::Disk => "DISK_UUID",
            SourceUuidType::Volume => "VOLUME_UUID",
        };
        SyncTaskRecord {
            id: id.to_string(),
            name: format!("task-{id}"),
            source: format!(
                "[{token}:{source_uuid}]{}",
                normalize_uuid_sub_path(source_sub_path).unwrap()
            ),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
            watch_mode: false,
            auto_unmount: false,
            source_type: Some(SourceType::Uuid),
            source_uuid: Some(source_uuid.to_string()),
            source_uuid_type: Some(source_uuid_type),
            source_sub_path: Some(normalize_uuid_sub_path(source_sub_path).unwrap()),
            source_identity,
            recurring_schedules: Vec::new(),
        }
    }

    fn build_volume(name: &str, mount_point: &str) -> VolumeInfo {
        VolumeInfo {
            name: name.to_string(),
            path: PathBuf::from(mount_point),
            mount_point: PathBuf::from(mount_point),
            total_bytes: Some(256),
            available_bytes: Some(128),
            is_network: false,
            is_removable: true,
            volume_uuid: None,
            disk_uuid: None,
            device_serial: None,
            media_uuid: None,
            device_guid: None,
            transport_serial: None,
            bus_protocol: None,
            filesystem_name: None,
        }
    }

    fn build_app_state() -> AppState {
        AppState {
            config_store: Arc::new(ConfigStore::from_config_dir(temp_config_dir())),
            log_manager: Arc::new(LogManager::new(100)),
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            dry_run_cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            dry_running_tasks: Arc::new(RwLock::new(HashSet::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
            runtime_config: Arc::new(RwLock::new(Default::default())),
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
            recurring_schedule_history_store: Arc::new(RecurringScheduleHistoryStore::new(
                temp_config_dir(),
            )),
            recurring_scheduler_wakeup: Arc::new(Notify::new()),
        }
    }

    #[tokio::test]
    async fn test_is_runtime_watch_task_active_requires_manager_and_source_tracking() {
        let state = build_app_state();

        {
            let mut sources = state.runtime_watch_sources.write().await;
            sources.insert("task-1".to_string(), "/tmp/source".to_string());
        }

        assert!(!is_runtime_watch_task_active("task-1", &state).await);
    }

    #[test]
    fn test_get_app_version_command() {
        // Test that get_app_version returns the version from Cargo.toml
        let version = get_app_version();

        // Version should be in format "x.y.z"
        assert!(version.contains('.'));

        // Version should not be empty
        assert!(!version.is_empty());

        // Verify version can be parsed as a valid semantic version
        let major: u32 = version.split('.').next().unwrap().parse().unwrap_or(0);
        assert!(major < 100); // Reasonable upper bound for major version
    }

    #[test]
    fn test_join_paths_command() {
        // Test path joining logic - using tokio runtime for async
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(join_paths("/base".to_string(), "subdir".to_string()));

        assert!(result.is_ok());
        let joined = result.unwrap();

        assert!(joined.contains("subdir"));
        assert!(!joined.contains(".."));
    }

    #[test]
    fn test_join_paths_handles_basic_cases() {
        // Test that basic path joining works
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(join_paths("test".to_string(), "file.txt".to_string()));

        assert!(result.is_ok());
        let joined = result.unwrap();
        assert!(joined.ends_with("file.txt"));
    }

    #[test]
    fn test_app_state_initialization() {
        // Test that AppState can be created
        let state = build_app_state();

        // Verify log_manager is accessible by checking logs count
        let logs = state.log_manager.get_logs(None);
        assert_eq!(logs.len(), 0);
    }

    #[test]
    fn test_has_autostart_arg_detects_flag() {
        assert!(has_autostart_arg(["syncwatcher", "--autostart"]));
        assert!(!has_autostart_arg(["syncwatcher", "--verbose"]));
    }

    #[test]
    fn test_decide_autostart_launch_without_arg_keeps_normal_launch() {
        let decision = decide_autostart_launch(false, Ok(true));

        assert!(!decision.argv_present);
        assert_eq!(decision.autolaunch_enabled, None);
        assert!(!decision.hidden_start_accepted);
        assert_eq!(decision.reject_reason, None);
        assert_eq!(decision.status_error, None);
    }

    #[test]
    fn test_decide_autostart_launch_accepts_only_when_enabled() {
        let decision = decide_autostart_launch(true, Ok(true));

        assert!(decision.argv_present);
        assert_eq!(decision.autolaunch_enabled, Some(true));
        assert!(decision.hidden_start_accepted);
        assert_eq!(decision.reject_reason, None);
        assert_eq!(decision.status_error, None);
    }

    #[test]
    fn test_decide_autostart_launch_rejects_disabled_login_item() {
        let decision = decide_autostart_launch(true, Ok(false));

        assert!(decision.argv_present);
        assert_eq!(decision.autolaunch_enabled, Some(false));
        assert!(!decision.hidden_start_accepted);
        assert_eq!(decision.reject_reason, Some("launch_at_login_disabled"));
        assert_eq!(decision.status_error, None);
    }

    #[test]
    fn test_decide_autostart_launch_rejects_status_errors() {
        let decision = decide_autostart_launch(true, Err("failed".to_string()));

        assert!(decision.argv_present);
        assert_eq!(decision.autolaunch_enabled, None);
        assert!(!decision.hidden_start_accepted);
        assert_eq!(
            decision.reject_reason,
            Some("launch_at_login_status_unavailable")
        );
        assert_eq!(decision.status_error.as_deref(), Some("failed"));
    }

    #[test]
    fn test_launch_at_login_status_or_default_falls_back_to_false() {
        assert!(launch_at_login_status_or_default(Ok(true)));
        assert!(!launch_at_login_status_or_default(
            Err("failed".to_string())
        ));
    }

    #[test]
    fn test_runtime_desired_watch_sources_uses_watch_mode_only() {
        let tasks = vec![
            build_runtime_task("a", "/src/a", true),
            build_runtime_task("b", "/src/b", false),
            build_runtime_task("c", "/src/c", true),
        ];

        let desired = runtime_desired_watch_sources(&tasks);
        assert_eq!(desired.len(), 2);
        assert_eq!(desired.get("a"), Some(&"/src/a".to_string()));
        assert_eq!(desired.get("c"), Some(&"/src/c".to_string()));
        assert!(!desired.contains_key("b"));
    }

    #[test]
    fn test_runtime_watch_bootstrap_task_ids_use_watch_mode_only() {
        let tasks = vec![
            build_runtime_task("a", "/src/a", true),
            build_runtime_task("b", "/src/b", false),
            build_runtime_task(
                "uuid-watch",
                "[VOLUME_UUID:07497716-6027-3FE9-B418-6BEA262C7D2F]/",
                true,
            ),
        ];

        assert_eq!(
            runtime_watch_bootstrap_task_ids(&tasks),
            vec!["a".to_string(), "uuid-watch".to_string(),]
        );
    }

    #[test]
    fn test_runtime_watch_task_needs_restart_when_new_stopped_or_source_changed() {
        let managed_sources =
            HashMap::from([("task-1".to_string(), "/Volumes/old/source".to_string())]);
        let watching_now = HashSet::from(["task-1".to_string()]);

        assert!(!runtime_watch_task_needs_restart(
            "task-1",
            "/Volumes/old/source",
            &managed_sources,
            &watching_now,
        ));
        assert!(runtime_watch_task_needs_restart(
            "task-2",
            "/Volumes/new/source",
            &managed_sources,
            &watching_now,
        ));
        assert!(runtime_watch_task_needs_restart(
            "task-1",
            "/Volumes/new/source",
            &managed_sources,
            &watching_now,
        ));
        assert!(runtime_watch_task_needs_restart(
            "task-1",
            "/Volumes/old/source",
            &managed_sources,
            &HashSet::new(),
        ));
    }

    #[test]
    fn test_can_enqueue_runtime_watch_bootstrap_task_blocks_syncing_queued_and_pending() {
        let syncing = HashSet::from(["syncing".to_string()]);
        let queued = HashSet::from(["queued".to_string()]);
        let pending = HashSet::from(["pending".to_string()]);

        assert!(!can_enqueue_runtime_watch_bootstrap_task(
            "syncing", &syncing, &queued, &pending
        ));
        assert!(!can_enqueue_runtime_watch_bootstrap_task(
            "queued", &syncing, &queued, &pending
        ));
        assert!(!can_enqueue_runtime_watch_bootstrap_task(
            "pending", &syncing, &queued, &pending
        ));
        assert!(can_enqueue_runtime_watch_bootstrap_task(
            "eligible", &syncing, &queued, &pending
        ));
    }

    #[tokio::test]
    async fn test_enqueue_runtime_watch_bootstrap_tasks_enqueues_only_eligible_tasks() {
        let state = build_app_state();
        {
            let mut syncing = state.syncing_tasks.write().await;
            syncing.insert("syncing".to_string());
        }
        {
            let mut queued = state.queued_sync_tasks.write().await;
            queued.insert("queued".to_string());
        }
        {
            let mut queue = state.runtime_sync_queue.write().await;
            queue.push_back("queued".to_string());
        }
        {
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.insert("pending".to_string());
        }

        let task_ids = vec![
            "eligible".to_string(),
            "syncing".to_string(),
            "queued".to_string(),
            "pending".to_string(),
        ];

        let enqueued = enqueue_runtime_watch_bootstrap_tasks(&task_ids, &state).await;
        assert_eq!(enqueued, vec!["eligible".to_string()]);

        let queue = state.runtime_sync_queue.read().await;
        assert_eq!(
            queue.iter().cloned().collect::<Vec<_>>(),
            vec!["queued".to_string(), "eligible".to_string()]
        );
        drop(queue);

        let queued = state.queued_sync_tasks.read().await;
        assert!(queued.contains("eligible"));
        assert!(queued.contains("queued"));
        assert!(!queued.contains("syncing"));
        assert!(!queued.contains("pending"));
    }

    #[test]
    fn test_resolve_runtime_exclude_patterns_deduplicates_preserving_order() {
        let task = RuntimeSyncTask {
            id: "task-1".to_string(),
            name: "task-1".to_string(),
            source: "/tmp/source".to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            watch_mode: true,
            auto_unmount: false,
            verify_after_copy: true,
            exclusion_sets: vec!["set-a".to_string(), "set-b".to_string()],
        };

        let sets = vec![
            RuntimeExclusionSet {
                id: "set-a".to_string(),
                name: "Set A".to_string(),
                patterns: vec![
                    "dist".to_string(),
                    "build".to_string(),
                    "coverage".to_string(),
                ],
            },
            RuntimeExclusionSet {
                id: "set-b".to_string(),
                name: "Set B".to_string(),
                patterns: vec![
                    "build".to_string(),
                    "coverage".to_string(),
                    ".cache".to_string(),
                ],
            },
        ];

        let resolved = resolve_runtime_exclude_patterns(&task, &sets);
        assert_eq!(
            resolved,
            vec![
                "dist".to_string(),
                "build".to_string(),
                "coverage".to_string(),
                ".cache".to_string()
            ]
        );
    }

    #[test]
    fn test_runtime_find_watch_task_filters_non_watch_tasks() {
        let tasks = vec![
            build_runtime_task("watch-off", "/src/off", false),
            build_runtime_task("watch-on", "/src/on", true),
        ];

        assert!(runtime_find_watch_task(&tasks, "watch-off").is_none());
        assert!(runtime_find_watch_task(&tasks, "watch-on").is_some());
        assert!(runtime_find_watch_task(&tasks, "missing").is_none());
    }

    #[test]
    fn test_runtime_get_state_internal_returns_syncing_tasks() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let state = build_app_state();

        rt.block_on(async {
            {
                let mut syncing = state.syncing_tasks.write().await;
                syncing.insert("task-1".to_string());
                syncing.insert("task-2".to_string());
            }

            let runtime_state = runtime_get_state_internal(&state).await;
            let syncing: HashSet<String> = runtime_state.syncing_tasks.into_iter().collect();

            assert!(runtime_state.watching_tasks.is_empty());
            assert!(syncing.contains("task-1"));
            assert!(syncing.contains("task-2"));
            assert_eq!(syncing.len(), 2);
        });
    }

    #[test]
    fn test_enqueue_runtime_sync_task_internal_defers_while_syncing() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let state = build_app_state();

        rt.block_on(async {
            {
                let mut syncing = state.syncing_tasks.write().await;
                syncing.insert("task-1".to_string());
            }

            let result = enqueue_runtime_sync_task_internal("task-1", &state).await;
            assert_eq!(result, RuntimeSyncEnqueueResult::DeferredWhileSyncing);

            let pending = state.runtime_pending_sync_tasks.read().await;
            assert!(pending.contains("task-1"));
            drop(pending);

            let queued = state.queued_sync_tasks.read().await;
            assert!(!queued.contains("task-1"));
            drop(queued);

            let queue = state.runtime_sync_queue.read().await;
            assert!(queue.is_empty());
        });
    }

    #[test]
    fn test_take_runtime_pending_sync_task_returns_true_once() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let state = build_app_state();

        rt.block_on(async {
            {
                let mut pending = state.runtime_pending_sync_tasks.write().await;
                pending.insert("task-1".to_string());
            }

            assert!(take_runtime_pending_sync_task("task-1", &state).await);
            assert!(!take_runtime_pending_sync_task("task-1", &state).await);
        });
    }

    #[test]
    fn test_dequeue_runtime_sync_task_keeps_queue_set_consistent() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let state = build_app_state();

        rt.block_on(async {
            {
                let mut queued = state.queued_sync_tasks.write().await;
                queued.insert("task-1".to_string());
            }
            {
                let mut queue = state.runtime_sync_queue.write().await;
                queue.push_back("task-1".to_string());
            }

            let next = dequeue_runtime_sync_task(&state).await;
            assert_eq!(next.as_deref(), Some("task-1"));

            let queued = state.queued_sync_tasks.read().await;
            assert!(!queued.contains("task-1"));
            drop(queued);

            let queue = state.runtime_sync_queue.read().await;
            assert!(queue.is_empty());
        });
    }

    #[test]
    fn test_remove_runtime_sync_task_state_clears_pending_queue_and_set() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let state = build_app_state();

        rt.block_on(async {
            {
                let mut pending = state.runtime_pending_sync_tasks.write().await;
                pending.insert("task-1".to_string());
            }
            {
                let mut queued = state.queued_sync_tasks.write().await;
                queued.insert("task-1".to_string());
            }
            {
                let mut queue = state.runtime_sync_queue.write().await;
                queue.push_back("task-1".to_string());
                queue.push_back("task-2".to_string());
            }

            remove_runtime_sync_task_state("task-1", &state).await;

            let pending = state.runtime_pending_sync_tasks.read().await;
            assert!(!pending.contains("task-1"));
            drop(pending);

            let queued = state.queued_sync_tasks.read().await;
            assert!(!queued.contains("task-1"));
            drop(queued);

            let queue = state.runtime_sync_queue.read().await;
            assert_eq!(
                queue.iter().cloned().collect::<Vec<_>>(),
                vec!["task-2".to_string()]
            );
        });
    }

    #[tokio::test]
    async fn test_cancel_operation_internal_cancels_dry_run_token() {
        let state = build_app_state();
        let token = CancellationToken::new();

        {
            let mut tokens = state.dry_run_cancel_tokens.write().await;
            tokens.insert("task-1".to_string(), token.clone());
        }

        let cancelled =
            cancel_operation_internal("task-1", CancelOperationType::DryRun, &state).await;
        assert!(cancelled);
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn test_cancel_operation_internal_cancels_sync_token() {
        let state = build_app_state();
        let token = CancellationToken::new();

        {
            let mut tokens = state.cancel_tokens.write().await;
            tokens.insert("task-1".to_string(), token.clone());
        }

        let cancelled =
            cancel_operation_internal("task-1", CancelOperationType::Sync, &state).await;
        assert!(cancelled);
        assert!(token.is_cancelled());
    }

    #[test]
    fn test_validate_runtime_tasks_allows_distinct_sources_and_targets() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/a", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/b", false),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_duplicate_targets() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/shared", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/shared", false),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Target path conflict"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_target_subdirectory_conflict() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/root", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/root/child", false),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Target path conflict"));
    }

    #[test]
    fn test_orphan_target_conflict_helper_returns_duplicate_target_for_selected_task() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/shared", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/shared", false),
        ];

        let issue = find_runtime_orphan_target_conflict_issue("b", &tasks)
            .expect("helper should not error")
            .expect("selected task should be blocked");

        assert_eq!(issue.code, RuntimeTaskValidationCode::DuplicateTarget);
        assert_eq!(issue.task_id.as_deref(), Some("b"));
        assert_eq!(issue.conflicting_task_ids, vec!["a".to_string()]);
    }

    #[test]
    fn test_orphan_target_conflict_helper_returns_nested_target_for_selected_task() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/root", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/root/child", false),
        ];

        let issue = find_runtime_orphan_target_conflict_issue("b", &tasks)
            .expect("helper should not error")
            .expect("selected task should be blocked");

        assert_eq!(issue.code, RuntimeTaskValidationCode::TargetSubdirConflict);
        assert_eq!(issue.task_id.as_deref(), Some("b"));
        assert_eq!(issue.conflicting_task_ids, vec!["a".to_string()]);
    }

    #[test]
    fn test_orphan_target_conflict_helper_ignores_unrelated_task_conflicts() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/root", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/root/child", false),
            build_runtime_task_with_paths("c", "/src/c", "/dst/isolated", false),
        ];

        let issue = find_runtime_orphan_target_conflict_issue("c", &tasks)
            .expect("helper should not error");

        assert!(issue.is_none());
    }

    #[tokio::test]
    async fn test_find_orphan_files_internal_rejects_selected_task_target_conflict() {
        let state = build_app_state();
        state
            .config_store
            .save_tasks(&[
                SyncTaskRecord {
                    id: "task-a".to_string(),
                    name: "Task A".to_string(),
                    source: "/src/a".to_string(),
                    target: "/dst/shared".to_string(),
                    checksum_mode: false,
                    verify_after_copy: true,
                    exclusion_sets: Vec::new(),
                    watch_mode: false,
                    auto_unmount: false,
                    source_type: Some(SourceType::Path),
                    source_uuid: None,
                    source_uuid_type: None,
                    source_sub_path: None,
                    source_identity: None,
                    recurring_schedules: Vec::new(),
                },
                SyncTaskRecord {
                    id: "task-b".to_string(),
                    name: "Task B".to_string(),
                    source: "/src/b".to_string(),
                    target: "/dst/shared".to_string(),
                    checksum_mode: false,
                    verify_after_copy: true,
                    exclusion_sets: Vec::new(),
                    watch_mode: false,
                    auto_unmount: false,
                    source_type: Some(SourceType::Path),
                    source_uuid: None,
                    source_uuid_type: None,
                    source_sub_path: None,
                    source_identity: None,
                    recurring_schedules: Vec::new(),
                },
            ])
            .expect("tasks should save");

        let result = find_orphan_files_internal(
            "task-b".to_string(),
            PathBuf::from("/src/b"),
            PathBuf::from("/dst/shared"),
            Vec::new(),
            &state,
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Orphan scan blocked"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_same_task_source_target_overlap() {
        let tasks = vec![build_runtime_task_with_paths(
            "a",
            "/data/source",
            "/data/source/sub",
            false,
        )];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("overlapping source/target"));
    }

    #[test]
    fn test_validate_runtime_tasks_allows_one_way_watch_chain() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/sdcard", "/camera/a7cr", true),
            build_runtime_task_with_paths("b", "/camera", "/nas/camera", true),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_watch_cycle() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/watch/a", "/watch/b/import", true),
            build_runtime_task_with_paths("b", "/watch/b", "/watch/a/export", true),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Watch cycle detected"));
    }

    #[test]
    fn test_validate_runtime_tasks_allows_manual_target_inside_watched_source() {
        let tasks = vec![
            build_runtime_task_with_paths("watch-a", "/media/incoming", "/backup/watch-a", true),
            build_runtime_task_with_paths(
                "manual-b",
                "/src/manual",
                "/media/incoming/export",
                false,
            ),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_validate_runtime_tasks_allows_new_uuid_tokens() {
        let tasks = vec![
            build_runtime_task_with_paths("disk", "[DISK_UUID:disk-a]/DCIM", "/dst/disk", false),
            build_runtime_task_with_paths(
                "volume",
                "[VOLUME_UUID:volume-a]/DCIM",
                "/dst/volume",
                false,
            ),
            build_runtime_task_with_paths("legacy", "[UUID:legacy-a]/DCIM", "/dst/legacy", false),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_parse_uuid_source_path_handles_token_variants() {
        let disk = parse_uuid_source_path("[DISK_UUID:disk-a]/DCIM/100");
        assert!(disk.is_some());
        let disk = disk.unwrap();
        assert_eq!(disk.uuid, "disk-a");
        assert_eq!(disk.sub_path, "/DCIM/100");

        let volume = parse_uuid_source_path("[VOLUME_UUID:volume-a]/MOV");
        assert!(volume.is_some());
        let volume = volume.unwrap();
        assert_eq!(volume.uuid, "volume-a");
        assert_eq!(volume.sub_path, "/MOV");

        let legacy = parse_uuid_source_path("[UUID:legacy-a]/RAW");
        assert!(legacy.is_some());
        let legacy = legacy.unwrap();
        assert_eq!(legacy.uuid, "legacy-a");
        assert_eq!(legacy.sub_path, "/RAW");
    }

    #[test]
    fn test_parse_uuid_source_path_edge_cases() {
        let empty_uuid = parse_uuid_source_path("[DISK_UUID:]/DCIM");
        assert!(empty_uuid.is_some());
        let empty_uuid = empty_uuid.unwrap();
        assert_eq!(empty_uuid.uuid, "");
        assert_eq!(empty_uuid.sub_path, "/DCIM");

        assert!(parse_uuid_source_path("[DISK_UUID:abc/without-bracket").is_none());
        assert!(parse_uuid_source_path("[CUSTOM_UUID:abc]/DCIM").is_none());
    }

    #[test]
    fn test_find_runtime_task_validation_issue_returns_source_target_overlap_metadata() {
        let tasks = vec![build_runtime_task_with_paths(
            "a",
            "/data/source",
            "/data/source/sub",
            false,
        )];

        let issue = find_runtime_task_validation_issue(&tasks).expect("expected issue");
        assert_eq!(issue.code, RuntimeTaskValidationCode::SourceTargetOverlap);
        assert_eq!(issue.task_id.as_deref(), Some("a"));
        assert_eq!(issue.task_name.as_deref(), Some("task-a"));
        assert_eq!(issue.source.as_deref(), Some("/data/source"));
        assert_eq!(issue.target.as_deref(), Some("/data/source/sub"));
        assert!(issue.conflicting_task_ids.is_empty());
    }

    #[test]
    fn test_find_runtime_task_validation_issue_distinguishes_duplicate_target_and_subdir_conflict()
    {
        let duplicate_target_tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/shared", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/shared", false),
        ];
        let duplicate_issue =
            find_runtime_task_validation_issue(&duplicate_target_tasks).expect("duplicate issue");
        assert_eq!(
            duplicate_issue.code,
            RuntimeTaskValidationCode::DuplicateTarget
        );
        assert_eq!(duplicate_issue.task_id.as_deref(), Some("a"));
        assert_eq!(duplicate_issue.conflicting_task_ids, vec!["b".to_string()]);

        let nested_target_tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/dst/root", false),
            build_runtime_task_with_paths("b", "/src/b", "/dst/root/child", false),
        ];
        let nested_issue =
            find_runtime_task_validation_issue(&nested_target_tasks).expect("nested issue");
        assert_eq!(
            nested_issue.code,
            RuntimeTaskValidationCode::TargetSubdirConflict
        );
        assert_eq!(nested_issue.task_id.as_deref(), Some("a"));
        assert_eq!(nested_issue.conflicting_task_ids, vec!["b".to_string()]);
    }

    #[test]
    fn test_find_runtime_watch_cycle_detects_longer_cycle() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/watch/a", "/watch/b/in", true),
            build_runtime_task_with_paths("b", "/watch/b", "/watch/c/in", true),
            build_runtime_task_with_paths("c", "/watch/c", "/watch/a/in", true),
        ];

        let validated = build_validated_runtime_tasks(&tasks).unwrap();
        let cycle = find_runtime_watch_cycle(&validated);
        assert!(cycle.is_some());
    }

    #[tokio::test]
    async fn test_mark_downstream_watch_tasks_settle_for_manual_target_overlap() {
        let state = build_app_state();
        {
            let mut runtime_config = state.runtime_config.write().await;
            runtime_config.tasks = vec![
                build_runtime_task_with_paths(
                    "watch-a",
                    "/media/incoming",
                    "/backup/watch-a",
                    true,
                ),
                build_runtime_task_with_paths(
                    "manual-b",
                    "/src/manual",
                    "/media/incoming/export",
                    false,
                ),
            ];
        }

        mark_downstream_watch_tasks_settle_for_target("/media/incoming/export", &state).await;

        let settle = state.runtime_chain_settle_until.read().await;
        assert!(settle.get("watch-a").is_some());
    }

    #[tokio::test]
    async fn test_finish_runtime_producer_failure_blocks_downstream_before_removal() {
        let state = build_app_state();

        {
            let mut runtime_config = state.runtime_config.write().await;
            runtime_config.tasks = vec![
                build_runtime_task_with_paths(
                    "watch-a",
                    "/media/incoming",
                    "/backup/watch-a",
                    true,
                ),
                build_runtime_task_with_paths(
                    "manual-b",
                    "/src/manual",
                    "/media/incoming/export",
                    false,
                ),
            ];
        }

        {
            let mut queued = state.queued_sync_tasks.write().await;
            queued.insert("watch-a".to_string());
        }
        {
            let mut queue = state.runtime_sync_queue.write().await;
            queue.push_back("watch-a".to_string());
        }
        {
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.insert("watch-a".to_string());
        }
        {
            let mut producers = state.runtime_active_producers.write().await;
            producers.insert(
                "sync:manual:task-b".to_string(),
                RuntimeActiveProducer {
                    producer_id: "sync:manual:task-b".to_string(),
                    kind: RuntimeProducerKind::ManualSync,
                    target_key: "/media/incoming/export".to_string(),
                },
            );
        }

        finish_runtime_producer(
            "sync:manual:task-b",
            "/media/incoming/export",
            false,
            None,
            &state,
        )
        .await;

        let queued = state.queued_sync_tasks.read().await;
        assert!(!queued.contains("watch-a"));
        drop(queued);

        let queue = state.runtime_sync_queue.read().await;
        assert!(!queue.iter().any(|task_id| task_id == "watch-a"));
        drop(queue);

        let pending = state.runtime_pending_sync_tasks.read().await;
        assert!(!pending.contains("watch-a"));
        drop(pending);

        let settle = state.runtime_chain_settle_until.read().await;
        assert!(settle.get("watch-a").is_none());
        drop(settle);

        let producers = state.runtime_active_producers.read().await;
        assert!(!producers.contains_key("sync:manual:task-b"));
    }

    #[tokio::test]
    async fn test_finish_runtime_producer_success_marks_settle_before_removal() {
        let state = build_app_state();

        {
            let mut runtime_config = state.runtime_config.write().await;
            runtime_config.tasks = vec![
                build_runtime_task_with_paths(
                    "watch-a",
                    "/media/incoming",
                    "/backup/watch-a",
                    true,
                ),
                build_runtime_task_with_paths(
                    "manual-b",
                    "/src/manual",
                    "/media/incoming/export",
                    false,
                ),
            ];
        }

        {
            let mut queued = state.queued_sync_tasks.write().await;
            queued.insert("watch-a".to_string());
        }
        {
            let mut queue = state.runtime_sync_queue.write().await;
            queue.push_back("watch-a".to_string());
        }
        {
            let mut pending = state.runtime_pending_sync_tasks.write().await;
            pending.insert("watch-a".to_string());
        }
        {
            let mut producers = state.runtime_active_producers.write().await;
            producers.insert(
                "sync:manual:task-b".to_string(),
                RuntimeActiveProducer {
                    producer_id: "sync:manual:task-b".to_string(),
                    kind: RuntimeProducerKind::ManualSync,
                    target_key: "/media/incoming/export".to_string(),
                },
            );
        }

        finish_runtime_producer(
            "sync:manual:task-b",
            "/media/incoming/export",
            true,
            None,
            &state,
        )
        .await;

        let queued = state.queued_sync_tasks.read().await;
        assert!(queued.contains("watch-a"));
        drop(queued);

        let queue = state.runtime_sync_queue.read().await;
        assert!(queue.iter().any(|task_id| task_id == "watch-a"));
        drop(queue);

        let pending = state.runtime_pending_sync_tasks.read().await;
        assert!(pending.contains("watch-a"));
        drop(pending);

        let settle = state.runtime_chain_settle_until.read().await;
        assert!(settle.get("watch-a").is_some());
        drop(settle);

        let producers = state.runtime_active_producers.read().await;
        assert!(!producers.contains_key("sync:manual:task-b"));
    }

    #[test]
    fn test_validate_runtime_tasks_allows_manual_target_inside_watch_source() {
        let tasks = vec![
            build_runtime_task_with_paths("watch-a", "/media/incoming", "/backup/watch-a", true),
            build_runtime_task_with_paths(
                "manual-b",
                "/src/manual",
                "/media/incoming/export",
                false,
            ),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_two_node_watch_cycle() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/loop/target", true),
            build_runtime_task_with_paths("b", "/loop/target/inbound", "/src/a/return", true),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Watch cycle detected"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_longer_watch_cycle() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/chain/b", true),
            build_runtime_task_with_paths("b", "/chain/b/in", "/chain/c", true),
            build_runtime_task_with_paths("c", "/chain/c/in", "/src/a/back", true),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Watch cycle detected"));
    }

    #[test]
    fn test_find_runtime_task_validation_issue_returns_watch_cycle_metadata() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/chain/b", true),
            build_runtime_task_with_paths("b", "/chain/b/in", "/chain/c", true),
            build_runtime_task_with_paths("c", "/chain/c/in", "/src/a/back", true),
        ];

        let issue = find_runtime_task_validation_issue(&tasks).expect("cycle issue");
        assert_eq!(issue.code, RuntimeTaskValidationCode::WatchCycle);
        let mut involved_ids = issue.conflicting_task_ids.clone();
        if let Some(task_id) = issue.task_id.clone() {
            involved_ids.push(task_id);
        }
        involved_ids.sort();
        assert_eq!(
            involved_ids,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn test_validate_runtime_tasks_allows_case_insensitive_parent_child_watch_chain() {
        let tasks = vec![
            build_runtime_task_with_paths(
                "photo-save",
                "[VOLUME_UUID:07497716-6027-3FE9-B418-6BEA262C702F1]/",
                "/VoLumes/EV0990/Camera/a7cr",
                true,
            ),
            build_runtime_task_with_paths(
                "camera-nas",
                "/Volumes/ev0990/camera",
                "/Volumes/kimjeongjin/camera",
                true,
            ),
        ];

        assert!(validate_runtime_tasks(&tasks).is_ok());
    }

    #[test]
    fn test_select_runtime_dispatch_candidate_blocks_active_manual_producer() {
        let queue = VecDeque::from([String::from("watch-a")]);
        let queued_set = HashSet::from([String::from("watch-a")]);
        let syncing = HashSet::new();
        let watch_upstreams = HashMap::new();
        let source_keys =
            HashMap::from([(String::from("watch-a"), String::from("/media/incoming"))]);
        let active_producers = HashMap::from([(
            String::from("sync:manual:task-b"),
            RuntimeActiveProducer {
                producer_id: String::from("sync:manual:task-b"),
                kind: RuntimeProducerKind::ManualSync,
                target_key: String::from("/media/incoming/export"),
            },
        )]);
        let settle_until = HashMap::new();

        let selection = select_runtime_dispatch_candidate(
            &queue,
            &queued_set,
            &syncing,
            &watch_upstreams,
            &source_keys,
            &active_producers,
            &settle_until,
            Instant::now(),
        );

        assert!(selection.candidate_task_id.is_none());
        assert!(selection.next_deadline.is_none());
    }

    #[test]
    fn test_select_runtime_dispatch_candidate_blocks_active_conflict_producer() {
        let queue = VecDeque::from([String::from("watch-a")]);
        let queued_set = HashSet::from([String::from("watch-a")]);
        let syncing = HashSet::new();
        let watch_upstreams = HashMap::new();
        let source_keys =
            HashMap::from([(String::from("watch-a"), String::from("/media/incoming"))]);
        let active_producers = HashMap::from([(
            String::from("conflict:force-copy:session-1:item-1"),
            RuntimeActiveProducer {
                producer_id: String::from("conflict:force-copy:session-1:item-1"),
                kind: RuntimeProducerKind::ConflictForceCopy,
                target_key: String::from("/media/incoming/export/file.jpg"),
            },
        )]);

        let selection = select_runtime_dispatch_candidate(
            &queue,
            &queued_set,
            &syncing,
            &watch_upstreams,
            &source_keys,
            &active_producers,
            &HashMap::new(),
            Instant::now(),
        );

        assert!(selection.candidate_task_id.is_none());
    }

    #[test]
    fn test_select_runtime_dispatch_candidate_waits_for_settle_then_runs() {
        let queue = VecDeque::from([String::from("watch-a"), String::from("watch-b")]);
        let queued_set = HashSet::from([String::from("watch-a"), String::from("watch-b")]);
        let syncing = HashSet::new();
        let watch_upstreams = HashMap::new();
        let source_keys = HashMap::from([
            (String::from("watch-a"), String::from("/media/incoming")),
            (String::from("watch-b"), String::from("/other/source")),
        ]);
        let active_producers = HashMap::new();
        let future_deadline = Instant::now() + Duration::from_millis(200);
        let settle_until = HashMap::from([(String::from("watch-a"), future_deadline)]);

        let selection = select_runtime_dispatch_candidate(
            &queue,
            &queued_set,
            &syncing,
            &watch_upstreams,
            &source_keys,
            &active_producers,
            &settle_until,
            Instant::now(),
        );

        assert_eq!(selection.candidate_task_id.as_deref(), Some("watch-b"));
        assert_eq!(selection.next_deadline, Some(future_deadline));

        let selection_after = select_runtime_dispatch_candidate(
            &VecDeque::from([String::from("watch-a")]),
            &HashSet::from([String::from("watch-a")]),
            &HashSet::new(),
            &HashMap::new(),
            &HashMap::from([(String::from("watch-a"), String::from("/media/incoming"))]),
            &HashMap::new(),
            &HashMap::from([(
                String::from("watch-a"),
                Instant::now() - Duration::from_millis(1),
            )]),
            Instant::now(),
        );

        assert_eq!(
            selection_after.candidate_task_id.as_deref(),
            Some("watch-a")
        );
    }

    #[test]
    fn test_select_runtime_dispatch_candidate_blocks_queued_watch_upstream() {
        let tasks = vec![
            build_runtime_task_with_paths("watch-a", "/sdcard", "/camera/a7cr", true),
            build_runtime_task_with_paths("watch-b", "/camera", "/nas/camera", true),
        ];
        let validated = build_validated_runtime_tasks(&tasks).unwrap();
        let upstreams = build_runtime_watch_upstreams(&validated);
        let queue = VecDeque::from([String::from("watch-b"), String::from("watch-a")]);
        let queued_set = HashSet::from([String::from("watch-b"), String::from("watch-a")]);
        let syncing = HashSet::new();
        let source_keys = HashMap::from([
            (String::from("watch-a"), String::from("/sdcard")),
            (String::from("watch-b"), String::from("/camera")),
        ]);

        let selection = select_runtime_dispatch_candidate(
            &queue,
            &queued_set,
            &syncing,
            &upstreams,
            &source_keys,
            &HashMap::new(),
            &HashMap::new(),
            Instant::now(),
        );

        assert_eq!(selection.candidate_task_id.as_deref(), Some("watch-a"));
    }

    #[test]
    fn test_source_recommendation_matches_by_device_serial() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-1".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.disk_uuid = Some("disk-new".to_string());
        candidate.device_serial = Some("SERIAL-1".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert_eq!(recommendation.proposed_uuid, "disk-new");
        assert_eq!(recommendation.proposed_uuid_type, "disk");
        assert_eq!(recommendation.confidence_label, "high");
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "device serial matched"));
    }

    #[test]
    fn test_source_recommendation_matches_by_device_guid() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/",
            Some(SourceIdentitySnapshot {
                device_guid: Some("GUID-1".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.disk_uuid = Some("disk-new".to_string());
        candidate.device_guid = Some("GUID-1".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "device GUID matched"));
    }

    #[test]
    fn test_source_recommendation_matches_by_media_uuid() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/",
            Some(SourceIdentitySnapshot {
                media_uuid: Some("MEDIA-1".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.disk_uuid = Some("disk-new".to_string());
        candidate.media_uuid = Some("MEDIA-1".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "media UUID matched"));
    }

    #[test]
    fn test_source_recommendation_resolves_stale_volume_uuid_via_device_serial() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Volume,
            "old-volume",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-1".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.volume_uuid = Some("volume-new".to_string());
        candidate.device_serial = Some("SERIAL-1".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert_eq!(recommendation.proposed_uuid, "volume-new");
        assert_eq!(recommendation.proposed_uuid_type, "volume");
    }

    #[test]
    fn test_source_recommendation_preserves_parsed_sub_path_when_field_missing() {
        let mut task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-1".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        task.source_sub_path = None;
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.disk_uuid = Some("disk-new".to_string());
        candidate.device_serial = Some("SERIAL-1".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert_eq!(recommendation.suggested_source, "[DISK_UUID:disk-new]/DCIM");
    }

    #[test]
    fn test_source_recommendation_does_not_match_transport_serial_alone() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/",
            Some(SourceIdentitySnapshot {
                transport_serial: Some("USB-BRIDGE".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Card A", "/Volumes/CardA");
        candidate.disk_uuid = Some("disk-new".to_string());
        candidate.transport_serial = Some("USB-BRIDGE".to_string());

        assert!(find_task_source_recommendation(&task, &[candidate]).is_none());
    }

    #[test]
    fn test_source_recommendation_continues_past_ambiguous_device_serial() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-1".to_string()),
                media_uuid: Some("MEDIA-UNIQUE".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut first = build_volume("Card A", "/Volumes/CardA");
        first.disk_uuid = Some("disk-a".to_string());
        first.device_serial = Some("SERIAL-1".to_string());
        first.media_uuid = Some("MEDIA-UNIQUE".to_string());

        let mut second = build_volume("Card B", "/Volumes/CardB");
        second.disk_uuid = Some("disk-b".to_string());
        second.device_serial = Some("SERIAL-1".to_string());
        second.media_uuid = Some("MEDIA-OTHER".to_string());

        let recommendation = find_task_source_recommendation(&task, &[first, second]).unwrap();
        assert_eq!(recommendation.proposed_uuid, "disk-a");
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "media UUID matched"));
    }

    #[test]
    fn test_source_recommendation_uses_unique_composite_fallback() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                total_bytes: Some(512),
                filesystem_name: Some("ExFAT".to_string()),
                volume_name: Some("Untitled".to_string()),
                transport_serial: Some("USB-BRIDGE".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut candidate = build_volume("Untitled", "/Volumes/Untitled");
        candidate.total_bytes = Some(512);
        candidate.filesystem_name = Some("ExFAT".to_string());
        candidate.transport_serial = Some("USB-BRIDGE".to_string());
        candidate.disk_uuid = Some("disk-new".to_string());

        let recommendation = find_task_source_recommendation(&task, &[candidate]).unwrap();
        assert_eq!(recommendation.confidence_label, "medium");
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "capacity matched (512 bytes)"));
        assert!(recommendation
            .evidence
            .iter()
            .any(|item| item == "transport serial matched"));
    }

    #[test]
    fn test_source_recommendation_skips_ambiguous_composite_matches() {
        let task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "missing-disk",
            "/",
            Some(SourceIdentitySnapshot {
                total_bytes: Some(512),
                filesystem_name: Some("ExFAT".to_string()),
                volume_name: Some("Untitled".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let mut first = build_volume("Untitled", "/Volumes/CardA");
        first.total_bytes = Some(512);
        first.filesystem_name = Some("ExFAT".to_string());
        first.disk_uuid = Some("disk-a".to_string());

        let mut second = build_volume("Untitled", "/Volumes/CardB");
        second.total_bytes = Some(512);
        second.filesystem_name = Some("ExFAT".to_string());
        second.disk_uuid = Some("disk-b".to_string());

        assert!(find_task_source_recommendation(&task, &[first, second]).is_none());
    }

    #[test]
    fn test_accepting_recommendation_rewrites_uuid_fields_and_refreshes_identity() {
        let original_task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "old-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-OLD".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let update = UpdateSyncTaskRequest {
            task_id: original_task.id.clone(),
            source: Some("[VOLUME_UUID:new-volume]/DCIM".to_string()),
            source_uuid: Some("new-volume".to_string()),
            source_uuid_type: Some(SourceUuidType::Volume),
            source_sub_path: Some("/DCIM".to_string()),
            ..UpdateSyncTaskRequest::default()
        };
        let mut updated_task = apply_sync_task_update(original_task, &update).unwrap();

        let mut volume = build_volume("Card A", "/Volumes/CardA");
        volume.volume_uuid = Some("new-volume".to_string());
        volume.disk_uuid = Some("disk-current".to_string());
        volume.device_serial = Some("SERIAL-NEW".to_string());
        volume.filesystem_name = Some("ExFAT".to_string());
        volume.total_bytes = Some(1024);

        refresh_uuid_source_identity(&mut updated_task, &[volume]);

        assert_eq!(updated_task.source_uuid.as_deref(), Some("new-volume"));
        assert_eq!(updated_task.source_uuid_type, Some(SourceUuidType::Volume));
        let identity = updated_task.source_identity.unwrap();
        assert_eq!(
            identity.last_seen_volume_uuid.as_deref(),
            Some("new-volume")
        );
        assert_eq!(
            identity.last_seen_disk_uuid.as_deref(),
            Some("disk-current")
        );
        assert_eq!(identity.device_serial.as_deref(), Some("SERIAL-NEW"));
    }

    #[test]
    fn test_retargeting_uuid_source_clears_stale_identity_when_new_media_missing() {
        let original_task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "old-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-OLD".to_string()),
                last_seen_disk_uuid: Some("old-disk".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let update = UpdateSyncTaskRequest {
            task_id: original_task.id.clone(),
            source: Some("[VOLUME_UUID:new-volume]/DCIM".to_string()),
            source_uuid: Some("new-volume".to_string()),
            source_uuid_type: Some(SourceUuidType::Volume),
            source_sub_path: Some("/DCIM".to_string()),
            ..UpdateSyncTaskRequest::default()
        };
        let mut updated_task = apply_sync_task_update(original_task, &update).unwrap();

        assert!(updated_task.source_identity.is_none());

        refresh_uuid_source_identity(&mut updated_task, &[]);
        assert!(updated_task.source_identity.is_none());
    }

    #[test]
    fn test_non_source_updates_preserve_existing_uuid_identity() {
        let original_task = build_uuid_task(
            "task-1",
            SourceUuidType::Disk,
            "old-disk",
            "/DCIM",
            Some(SourceIdentitySnapshot {
                device_serial: Some("SERIAL-OLD".to_string()),
                last_seen_disk_uuid: Some("old-disk".to_string()),
                ..SourceIdentitySnapshot::default()
            }),
        );
        let update = UpdateSyncTaskRequest {
            task_id: original_task.id.clone(),
            name: Some("Renamed task".to_string()),
            ..UpdateSyncTaskRequest::default()
        };
        let mut updated_task = apply_sync_task_update(original_task, &update).unwrap();

        refresh_uuid_source_identity(&mut updated_task, &[]);

        let identity = updated_task.source_identity.unwrap();
        assert_eq!(identity.device_serial.as_deref(), Some("SERIAL-OLD"));
        assert_eq!(identity.last_seen_disk_uuid.as_deref(), Some("old-disk"));
    }

    #[test]
    fn test_normalize_uuid_sub_path_normalizes_common_cases() {
        assert_eq!(normalize_uuid_sub_path("").unwrap(), "/");
        assert_eq!(normalize_uuid_sub_path("DCIM").unwrap(), "/DCIM");
        assert_eq!(
            normalize_uuid_sub_path("//DCIM//100MSDCF//").unwrap(),
            "/DCIM/100MSDCF"
        );
    }

    #[test]
    fn test_normalize_uuid_sub_path_rejects_parent_traversal() {
        let result = normalize_uuid_sub_path("/DCIM/../secret");
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("escapes the mounted volume root"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_malformed_uuid_token() {
        let tasks = vec![build_runtime_task_with_paths(
            "invalid",
            "[VOLUME_UUID:broken-token",
            "/dst/invalid",
            false,
        )];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Invalid UUID source token format"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_uuid_subpath_escape() {
        let tasks = vec![build_runtime_task_with_paths(
            "escape",
            "[VOLUME_UUID:uuid-a]/../../outside",
            "/dst/escape",
            false,
        )];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("escapes the mounted volume root"));
    }

    #[test]
    fn test_validate_runtime_tasks_normalizes_unmounted_uuid_tokens_before_overlap_check() {
        let test_uuid = "NOT_A_REAL_UUID_FOR_TEST_ONLY";
        let source = format!("[DISK_UUID:{test_uuid}]DCIM");
        let target = format!("[DISK_UUID:{test_uuid}]/DCIM");
        let tasks = vec![build_runtime_task_with_paths(
            "normalize",
            &source,
            &target,
            false,
        )];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("overlapping source/target paths"));
    }

    #[test]
    fn test_ensure_non_overlapping_paths_rejects_nested_target() {
        let result = ensure_non_overlapping_paths(
            Path::new("/Volumes/CARD"),
            Path::new("/Volumes/CARD/DCIM"),
        );

        assert!(result.is_err());
        assert!(result.err().unwrap_or_default().contains("overlap"));
    }

    #[test]
    fn test_classify_missing_target_path_allows_missing_subdir_on_mounted_volume() {
        let mounted = HashSet::from(["/volumes/evo990".to_string()]);

        let result = classify_missing_target_path(Path::new("/Volumes/EVO990/repo"), &mounted)
            .expect("mounted volume root should allow creating subdir");

        assert_eq!(result, TargetPreflightKind::WillCreateDirectory);
    }

    #[test]
    fn test_classify_missing_target_path_rejects_unmounted_volume_target() {
        let mounted = HashSet::from(["/volumes/evo990".to_string()]);

        let result = classify_missing_target_path(Path::new("/Volumes/kimjeongjin/repo"), &mounted);

        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Target volume is not mounted"));
    }

    #[test]
    fn test_classify_missing_target_path_is_case_insensitive_for_volumes_prefix() {
        let mounted = HashSet::from(["/volumes/evo990".to_string()]);

        let result = classify_missing_target_path(Path::new("/volumes/EVO990/repo"), &mounted)
            .expect("lowercase /volumes prefix should still be recognized");

        assert_eq!(result, TargetPreflightKind::WillCreateDirectory);
    }

    #[test]
    fn test_classify_missing_target_path_allows_missing_general_directory() {
        let mounted = HashSet::from(["/volumes/evo990".to_string()]);

        let result =
            classify_missing_target_path(Path::new("/Users/test/new-backup-dir"), &mounted)
                .expect("general missing directory should be creatable");

        assert_eq!(result, TargetPreflightKind::WillCreateDirectory);
    }

    #[tokio::test]
    async fn test_preflight_target_path_creates_missing_directory_for_sync() {
        let base = temp_config_dir();
        let target = base.join("nested/backup");

        let result = preflight_target_path(&target, true)
            .await
            .expect("sync preflight should create missing directory");

        assert_eq!(result.kind, TargetPreflightKind::CreatedDirectory);
        assert!(target.is_dir());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn test_sync_dry_run_internal_cleans_up_cancel_token_on_error() {
        let state = build_app_state();
        let base = temp_config_dir();
        let target = base.join("target");
        std::fs::create_dir_all(&target).expect("target directory should be created");

        let result = sync_dry_run_internal(
            None,
            "task-1".to_string(),
            base.join("missing-source"),
            target,
            false,
            Vec::new(),
            &state,
            None,
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(state.dry_run_cancel_tokens.read().await.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn test_runtime_get_state_includes_dry_running_tasks() {
        let state = build_app_state();

        {
            let mut running = state.dry_running_tasks.write().await;
            running.insert("task-1".to_string());
        }

        let runtime = runtime_get_state_internal(&state).await;

        assert_eq!(runtime.dry_running_tasks, vec!["task-1".to_string()]);
    }

    #[test]
    fn test_dry_run_live_state_throttles_progress_and_flushes_timed_batches() {
        let live = DryRunLiveState::new();
        let base = Instant::now();
        let scan_progress =
            build_dry_run_progress(DryRunPhase::ScanningSource, "scanning", 1, 0, 1, 0, 0, 0);

        let (first_progress, first_batch) = live.record_progress(scan_progress.clone(), base);
        assert_eq!(
            first_progress
                .as_ref()
                .map(|progress| progress.message.as_str()),
            Some("scanning")
        );
        assert!(first_batch.is_none());

        let (second_progress, second_batch) =
            live.record_progress(scan_progress.clone(), base + Duration::from_millis(50));
        assert!(second_progress.is_none());
        assert!(second_batch.is_none());

        let compare_progress =
            build_dry_run_progress(DryRunPhase::Comparing, "compare", 2, 3, 3, 2, 1, 4096);
        let diff_a = FileDiff {
            path: PathBuf::from("b.txt"),
            kind: FileDiffKind::New,
            source_size: Some(1024),
            target_size: None,
            checksum_source: None,
            checksum_target: None,
        };
        let diff_b = FileDiff {
            path: PathBuf::from("a.txt"),
            kind: FileDiffKind::Modified,
            source_size: Some(2048),
            target_size: Some(1024),
            checksum_source: None,
            checksum_target: None,
        };

        assert!(live
            .record_diff(
                diff_a,
                compare_progress.clone(),
                base + Duration::from_millis(120)
            )
            .is_none());
        assert!(live
            .record_diff(
                diff_b,
                compare_progress.clone(),
                base + Duration::from_millis(180)
            )
            .is_none());

        let (third_progress, timed_batch) =
            live.record_progress(compare_progress.clone(), base + Duration::from_millis(320));
        assert!(third_progress.is_some());
        let (diffs, batch_progress) = timed_batch.expect("timed batch should flush");
        assert_eq!(diffs.len(), 2);
        assert_eq!(batch_progress.phase, DryRunPhase::Comparing);
        assert_eq!(batch_progress.message, "compare");
    }

    #[test]
    fn test_dry_run_live_state_flushes_on_batch_size_limit() {
        let live = DryRunLiveState::new();
        let progress =
            build_dry_run_progress(DryRunPhase::Comparing, "compare", 50, 50, 50, 50, 0, 1024);

        let mut batch = None;
        for index in 0..50 {
            let diff = FileDiff {
                path: PathBuf::from(format!("file-{index}.txt")),
                kind: FileDiffKind::New,
                source_size: Some(1),
                target_size: None,
                checksum_source: None,
                checksum_target: None,
            };
            batch = live.record_diff(diff, progress.clone(), Instant::now());
        }

        let (diffs, batch_progress) = batch.expect("batch size flush should trigger");
        assert_eq!(diffs.len(), 50);
        assert_eq!(batch_progress.phase, DryRunPhase::Comparing);
    }

    #[tokio::test]
    async fn test_sync_dry_run_internal_returns_sorted_diff_order() {
        let state = build_app_state();
        let base = temp_config_dir();
        let source = base.join("source");
        let target = base.join("target");
        std::fs::create_dir_all(&source).expect("source directory should be created");
        std::fs::create_dir_all(&target).expect("target directory should be created");

        std::fs::write(source.join("b.txt"), b"bbb").expect("should write b.txt");
        std::fs::write(source.join("a.txt"), b"aaa").expect("should write a.txt");

        let result = sync_dry_run_internal(
            None,
            "task-1".to_string(),
            source.clone(),
            target.clone(),
            false,
            Vec::new(),
            &state,
            None,
            None,
        )
        .await
        .expect("dry run should succeed");

        let paths: Vec<String> = result
            .diffs
            .iter()
            .map(|diff| diff.path.to_string_lossy().to_string())
            .collect();

        assert_eq!(paths, vec!["a.txt".to_string(), "b.txt".to_string()]);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_decide_runtime_auto_unmount_requests_confirmation_when_zero_copy() {
        let decision = decide_runtime_auto_unmount(true, false, 0);
        assert_eq!(decision, RuntimeAutoUnmountDecision::RequestConfirmation);
    }

    #[test]
    fn test_decide_runtime_auto_unmount_unmounts_when_files_copied() {
        let decision = decide_runtime_auto_unmount(true, false, 2);
        assert_eq!(decision, RuntimeAutoUnmountDecision::UnmountNow);
    }

    #[tokio::test]
    async fn test_auto_unmount_session_disabled_internal_toggle() {
        let state = build_app_state();

        assert!(!is_auto_unmount_session_disabled_internal("task-1", &state).await);

        set_auto_unmount_session_disabled_internal("task-1", true, &state).await;
        assert!(is_auto_unmount_session_disabled_internal("task-1", &state).await);

        set_auto_unmount_session_disabled_internal("task-1", false, &state).await;
        assert!(!is_auto_unmount_session_disabled_internal("task-1", &state).await);
    }

    #[tokio::test]
    async fn test_prune_auto_unmount_session_disabled_tasks_removes_orphans() {
        let state = build_app_state();

        set_auto_unmount_session_disabled_internal("keep-task", true, &state).await;
        set_auto_unmount_session_disabled_internal("removed-task", true, &state).await;

        let valid_task_ids = HashSet::from(["keep-task".to_string()]);
        prune_auto_unmount_session_disabled_tasks(&valid_task_ids, &state).await;

        assert!(is_auto_unmount_session_disabled_internal("keep-task", &state).await);
        assert!(!is_auto_unmount_session_disabled_internal("removed-task", &state).await);
    }

    #[test]
    fn test_progress_phase_to_log_category_mapping() {
        use crate::logging::LogCategory;
        use crate::sync_engine::types::SyncPhase;

        assert_eq!(
            progress_phase_to_log_category(&SyncPhase::Copying),
            Some(LogCategory::FileCopied)
        );
        assert_eq!(progress_phase_to_log_category(&SyncPhase::Scanning), None);
        assert_eq!(progress_phase_to_log_category(&SyncPhase::Verifying), None);
    }

    #[test]
    fn test_compute_volume_mount_diff() {
        let previous: HashSet<String> =
            ["/Volumes/USB_OLD".to_string(), "/Volumes/SD1".to_string()]
                .into_iter()
                .collect();
        let current: HashSet<String> = ["/Volumes/SD1".to_string(), "/Volumes/USB_NEW".to_string()]
            .into_iter()
            .collect();

        let (mounted, unmounted) = compute_volume_mount_diff(&previous, &current);

        assert_eq!(mounted, vec!["/Volumes/USB_NEW".to_string()]);
        assert_eq!(unmounted, vec!["/Volumes/USB_OLD".to_string()]);
    }

    #[test]
    fn test_volume_emit_debounce_immediate_and_trailing() {
        let debounce = Duration::from_millis(500);
        let base = Instant::now();
        let mut state = VolumeEmitDebounceState::new();

        // First event emits immediately.
        assert!(handle_volume_watch_event(&mut state, base, debounce));

        // Burst event inside debounce window does not emit immediately.
        assert!(!handle_volume_watch_event(
            &mut state,
            base + Duration::from_millis(100),
            debounce
        ));

        // Tick before debounce window ends should not emit.
        assert!(!handle_volume_watch_tick(
            &mut state,
            base + Duration::from_millis(450),
            debounce
        ));

        // Tick after debounce window ends emits one trailing refresh.
        assert!(handle_volume_watch_tick(
            &mut state,
            base + Duration::from_millis(650),
            debounce
        ));

        // No pending event means no extra emit.
        assert!(!handle_volume_watch_tick(
            &mut state,
            base + Duration::from_millis(900),
            debounce
        ));
    }

    #[test]
    fn test_volume_watch_next_tick_delay_only_when_trailing_pending() {
        let debounce = Duration::from_millis(500);
        let now = Instant::now();
        let mut state = VolumeEmitDebounceState::new();

        assert_eq!(volume_watch_next_tick_delay(&state, now, debounce), None);

        state.trailing_pending = true;
        state.last_emit_at = Some(now - Duration::from_millis(200));
        assert_eq!(
            volume_watch_next_tick_delay(&state, now, debounce),
            Some(Duration::from_millis(300))
        );

        state.last_emit_at = Some(now - Duration::from_millis(800));
        assert_eq!(
            volume_watch_next_tick_delay(&state, now, debounce),
            Some(Duration::from_millis(0))
        );
    }

    #[test]
    fn test_format_bytes_with_unit_systems() {
        assert_eq!(
            format_bytes_with_unit(1024, DataUnitSystem::Binary),
            "1.00 KiB"
        );
        assert_eq!(
            format_bytes_with_unit(1_073_741_824, DataUnitSystem::Binary),
            "1.00 GiB"
        );
        assert_eq!(
            format_bytes_with_unit(1000, DataUnitSystem::Decimal),
            "1.00 KB"
        );
        assert_eq!(
            format_bytes_with_unit(1_000_000_000, DataUnitSystem::Decimal),
            "1.00 GB"
        );
    }

    #[test]
    fn test_log_manager_functionality() {
        // Test LogManager directly without Tauri State
        let log_manager = LogManager::new(100);

        // Add a log
        log_manager.log("info", "Test message", None);

        // Verify log was added
        let logs = log_manager.get_logs(None);
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].message, "Test message");
    }

    #[test]
    fn test_get_system_logs_via_manager() {
        let log_manager = LogManager::new(100);

        // Add some test logs
        log_manager.log("info", "Message 1", None);
        log_manager.log("warning", "Message 2", None);

        // Test get_logs
        let logs = log_manager.get_logs(None);

        assert_eq!(logs.len(), 2);
    }

    #[test]
    fn test_get_task_logs_via_manager() {
        let log_manager = LogManager::new(100);

        // Add logs for different tasks
        log_manager.log("info", "Task 1 message", Some("task1".to_string()));
        log_manager.log("info", "Task 2 message", Some("task2".to_string()));
        log_manager.log("info", "No task message", None);

        // Test get_logs with filter
        let task1_logs = log_manager.get_logs(Some("task1".to_string()));
        let task2_logs = log_manager.get_logs(Some("task2".to_string()));

        assert_eq!(task1_logs.len(), 1);
        assert_eq!(task2_logs.len(), 1);
        assert_eq!(task1_logs[0].task_id, Some("task1".to_string()));
    }

    #[test]
    fn test_record_runtime_validation_issue_writes_global_and_task_logs() {
        let state = build_app_state();
        let issue = RuntimeTaskValidationIssue {
            code: RuntimeTaskValidationCode::DuplicateTarget,
            task_id: Some("task-a".to_string()),
            task_name: Some("Task A".to_string()),
            conflicting_task_ids: vec!["task-b".to_string()],
            conflicting_task_names: vec!["Task B".to_string()],
            source: None,
            target: Some("/dst/shared".to_string()),
        };

        record_runtime_validation_issue(&issue, None, &state);

        let all_logs = state.log_manager.get_logs(None);
        assert_eq!(all_logs.len(), 3);
        assert_eq!(
            all_logs
                .iter()
                .filter(|entry| entry.category == crate::logging::LogCategory::ValidationError)
                .count(),
            3
        );

        let task_a_logs = state.log_manager.get_logs(Some("task-a".to_string()));
        let task_b_logs = state.log_manager.get_logs(Some("task-b".to_string()));
        assert_eq!(task_a_logs.len(), 1);
        assert_eq!(task_b_logs.len(), 1);
        let activity_logs = state.log_manager.get_activity_logs();
        assert_eq!(activity_logs.len(), 1);
        assert_eq!(
            activity_logs[0].category,
            crate::logging::LogCategory::ValidationError
        );
        assert_eq!(activity_logs[0].task_id, None);
    }

    #[test]
    fn test_runtime_validation_issue_log_message_includes_all_watch_cycle_participants() {
        let issue = RuntimeTaskValidationIssue {
            code: RuntimeTaskValidationCode::WatchCycle,
            task_id: Some("task-a".to_string()),
            task_name: Some("Task A".to_string()),
            conflicting_task_ids: vec!["task-b".to_string(), "task-c".to_string()],
            conflicting_task_names: vec!["Task B".to_string()],
            source: None,
            target: None,
        };

        let message = runtime_validation_issue_log_message(&issue);
        assert!(message.contains("'Task A'"));
        assert!(message.contains("'Task B'"));
        assert!(message.contains("'task-c'"));
    }

    #[test]
    fn test_log_manager_thread_safety() {
        // Test that LogManager is thread-safe
        let log_manager = LogManager::new(100);
        let log_manager_arc = Arc::new(log_manager);

        // Spawn multiple threads that log simultaneously
        let handles: Vec<_> = (0..10)
            .map(|i| {
                let lm = Arc::clone(&log_manager_arc) as Arc<LogManager>;
                std::thread::spawn(move || {
                    lm.log(
                        "info",
                        &format!("Thread {}", i),
                        Some(format!("thread_{}", i)),
                    );
                })
            })
            .collect();

        // Wait for all threads
        for handle in handles {
            handle.join().unwrap();
        }

        // Verify all logs were added
        let logs = log_manager_arc.get_logs(None);
        assert_eq!(logs.len(), 10);
    }

    #[test]
    fn test_log_manager_max_lines() {
        // Test that LogManager respects max lines limit
        let log_manager = LogManager::new(5);

        // Add more logs than max_lines
        for i in 0..10 {
            log_manager.log("info", &format!("Message {}", i), None);
        }

        // Should only have max_lines logs
        let logs = log_manager.get_logs(None);
        assert_eq!(logs.len(), 5);

        // Should have the most recent logs
        assert_eq!(logs[0].message, "Message 5");
        assert_eq!(logs[4].message, "Message 9");
    }
}
