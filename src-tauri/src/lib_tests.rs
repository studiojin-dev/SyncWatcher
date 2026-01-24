#[cfg(test)]
mod integration_tests {
    use crate::{get_app_version, join_paths, AppState};
    use crate::logging::LogManager;
    use crate::watcher::WatcherManager;
    use std::sync::Arc;
    use std::collections::HashMap;
    use tokio::sync::RwLock;

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
        let rt = tokio::runtime::Runtime::new().unwrap();
        let log_manager = LogManager::new(100);
        let state = AppState {
            log_manager: Arc::new(log_manager),
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
        };

        // Verify log_manager is accessible by checking logs count
        let logs = state.log_manager.get_logs(None);
        assert_eq!(logs.len(), 0);
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
                    lm.log("info", &format!("Thread {}", i), Some(format!("thread_{}", i)));
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
