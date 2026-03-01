#[cfg(test)]
mod integration_tests {
    use crate::logging::LogManager;
    use crate::watcher::WatcherManager;
    use crate::{
        cancel_operation_internal, CancelOperationType,
        compute_volume_mount_diff, format_bytes_with_unit, get_app_version,
        decide_runtime_auto_unmount, RuntimeAutoUnmountDecision,
        enqueue_runtime_sync_task_internal, dequeue_runtime_sync_task,
        handle_volume_watch_event, handle_volume_watch_tick,
        is_runtime_watch_task_active, join_paths, progress_phase_to_log_category,
        ensure_non_overlapping_paths, normalize_uuid_sub_path,
        parse_uuid_source_path,
        remove_runtime_sync_task_state, take_runtime_pending_sync_task,
        resolve_runtime_exclude_patterns,
        runtime_desired_watch_sources, runtime_find_watch_task, runtime_get_state_internal,
        set_auto_unmount_session_disabled_internal, is_auto_unmount_session_disabled_internal,
        prune_auto_unmount_session_disabled_tasks,
        validate_runtime_tasks, AppState, DataUnitSystem, RuntimeExclusionSet,
        RuntimeSyncEnqueueResult, RuntimeSyncTask,
        volume_watch_next_tick_delay,
        VolumeEmitDebounceState,
    };
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::{Mutex, Notify, RwLock};
    use tokio_util::sync::CancellationToken;

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

    fn build_app_state() -> AppState {
        AppState {
            log_manager: Arc::new(LogManager::new(100)),
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            dry_run_cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
            runtime_config: Arc::new(RwLock::new(Default::default())),
            syncing_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_sync_queue: Arc::new(RwLock::new(VecDeque::new())),
            queued_sync_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_pending_sync_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_dispatcher_running: Arc::new(Mutex::new(false)),
            runtime_sync_slot_released: Arc::new(Notify::new()),
            runtime_initial_watch_bootstrapped: Arc::new(AtomicBool::new(false)),
            runtime_config_apply_lock: Arc::new(Mutex::new(())),
            runtime_watch_sources: Arc::new(RwLock::new(HashMap::new())),
            auto_unmount_session_disabled_tasks: Arc::new(RwLock::new(HashSet::new())),
            conflict_review_sessions: Arc::new(RwLock::new(HashMap::new())),
            conflict_review_seq: Arc::new(AtomicU64::new(0)),
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
                patterns: vec!["dist".to_string(), "build".to_string(), "coverage".to_string()],
            },
            RuntimeExclusionSet {
                id: "set-b".to_string(),
                name: "Set B".to_string(),
                patterns: vec!["build".to_string(), "coverage".to_string(), ".cache".to_string()],
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
            assert_eq!(queue.iter().cloned().collect::<Vec<_>>(), vec!["task-2".to_string()]);
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

        let cancelled = cancel_operation_internal("task-1", CancelOperationType::Sync, &state).await;
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
    fn test_validate_runtime_tasks_rejects_watch_loop_risk() {
        let tasks = vec![
            build_runtime_task_with_paths("a", "/src/a", "/loop/target", true),
            build_runtime_task_with_paths("b", "/loop/target/inbound", "/dst/b", true),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result.err().unwrap_or_default().contains("Watch loop risk"));
    }

    #[test]
    fn test_validate_runtime_tasks_rejects_non_watch_target_overlapping_watch_source() {
        let tasks = vec![
            build_runtime_task_with_paths("watch-a", "/media/incoming", "/backup/watch-a", true),
            build_runtime_task_with_paths(
                "manual-b",
                "/src/manual",
                "/media/incoming/export",
                false,
            ),
        ];

        let result = validate_runtime_tasks(&tasks);
        assert!(result.is_err());
        assert!(result.err().unwrap_or_default().contains("Watch loop risk"));
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
        let tasks = vec![build_runtime_task_with_paths("normalize", &source, &target, false)];

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
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("overlap"));
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
