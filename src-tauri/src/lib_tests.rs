#[cfg(test)]
mod integration_tests {
    use crate::logging::LogManager;
    use crate::watcher::WatcherManager;
    use crate::{
        compute_volume_mount_diff, get_app_version, join_paths, progress_phase_to_log_category,
        runtime_delete_missing_for_watch_sync, runtime_desired_watch_sources,
        runtime_find_watch_task, runtime_get_state_internal, AppState, RuntimeSyncTask,
    };
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn build_runtime_task(
        id: &str,
        source: &str,
        watch_mode: bool,
        delete_missing: bool,
    ) -> RuntimeSyncTask {
        RuntimeSyncTask {
            id: id.to_string(),
            name: format!("task-{id}"),
            source: source.to_string(),
            target: "/tmp/target".to_string(),
            delete_missing,
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
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
            runtime_config: Arc::new(RwLock::new(Default::default())),
            syncing_tasks: Arc::new(RwLock::new(HashSet::new())),
            runtime_watch_sources: Arc::new(RwLock::new(HashMap::new())),
        }
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
            build_runtime_task("a", "/src/a", true, false),
            build_runtime_task("b", "/src/b", false, false),
            build_runtime_task("c", "/src/c", true, true),
        ];

        let desired = runtime_desired_watch_sources(&tasks);
        assert_eq!(desired.len(), 2);
        assert_eq!(desired.get("a"), Some(&"/src/a".to_string()));
        assert_eq!(desired.get("c"), Some(&"/src/c".to_string()));
        assert!(!desired.contains_key("b"));
    }

    #[test]
    fn test_runtime_find_watch_task_filters_non_watch_tasks() {
        let tasks = vec![
            build_runtime_task("watch-off", "/src/off", false, false),
            build_runtime_task("watch-on", "/src/on", true, false),
        ];

        assert!(runtime_find_watch_task(&tasks, "watch-off").is_none());
        assert!(runtime_find_watch_task(&tasks, "watch-on").is_some());
        assert!(runtime_find_watch_task(&tasks, "missing").is_none());
    }

    #[test]
    fn test_runtime_delete_missing_for_watch_sync_preserves_task_setting() {
        let delete_on = build_runtime_task("on", "/src/on", true, true);
        let delete_off = build_runtime_task("off", "/src/off", true, false);

        assert!(runtime_delete_missing_for_watch_sync(&delete_on));
        assert!(!runtime_delete_missing_for_watch_sync(&delete_off));
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
    fn test_progress_phase_to_log_category_mapping() {
        use crate::logging::LogCategory;
        use crate::sync_engine::types::SyncPhase;

        assert_eq!(
            progress_phase_to_log_category(&SyncPhase::Copying),
            Some(LogCategory::FileCopied)
        );
        assert_eq!(
            progress_phase_to_log_category(&SyncPhase::Deleting),
            Some(LogCategory::FileDeleted)
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
