use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Default maximum number of log lines to keep in memory
pub const DEFAULT_MAX_LOG_LINES: usize = 10000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub task_id: Option<String>,
    #[serde(default)]
    pub category: LogCategory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum LogCategory {
    SyncStarted,
    SyncCompleted,
    SyncError,
    WatchStarted,
    WatchStopped,
    VolumeMounted,
    VolumeUnmounted,
    FileCopied,
    FileDeleted,
    #[default]
    Other,
}

impl LogCategory {
    pub fn is_activity_visible(&self) -> bool {
        matches!(
            self,
            LogCategory::SyncStarted
                | LogCategory::SyncCompleted
                | LogCategory::SyncError
                | LogCategory::WatchStarted
                | LogCategory::WatchStopped
                | LogCategory::VolumeMounted
                | LogCategory::VolumeUnmounted
        )
    }

    pub fn is_task_visible(&self) -> bool {
        matches!(
            self,
            LogCategory::SyncStarted
                | LogCategory::SyncCompleted
                | LogCategory::SyncError
                | LogCategory::WatchStarted
                | LogCategory::WatchStopped
                | LogCategory::FileCopied
                | LogCategory::FileDeleted
        )
    }
}

/// Event emitted when a new log entry is added
#[derive(Debug, Clone, Serialize)]
pub struct LogEvent {
    pub task_id: Option<String>,
    pub entry: LogEntry,
}

/// Batch event for multiple logs
#[derive(Debug, Clone, Serialize)]
pub struct LogBatchEvent {
    pub task_id: Option<String>,
    pub entries: Vec<LogEntry>,
}

pub struct LogManager {
    system_logs: Arc<Mutex<VecDeque<LogEntry>>>,
    max_lines: usize,
}

impl LogManager {
    pub fn new(max_lines: usize) -> Self {
        Self {
            system_logs: Arc::new(Mutex::new(VecDeque::with_capacity(max_lines))),
            max_lines,
        }
    }

    fn build_entry(
        level: &str,
        message: &str,
        task_id: Option<String>,
        category: LogCategory,
    ) -> LogEntry {
        let now = chrono::Utc::now().to_rfc3339();
        LogEntry {
            id: now.clone(),
            timestamp: now,
            level: level.to_string(),
            message: message.to_string(),
            task_id,
            category,
        }
    }

    fn append_entries(&self, entries: &[LogEntry]) {
        let mut logs = self.system_logs.lock().unwrap();
        for entry in entries {
            logs.push_back(entry.clone());
        }

        while logs.len() > self.max_lines {
            logs.pop_front();
        }
    }

    pub fn log_with_category_and_event(
        &self,
        level: &str,
        message: &str,
        task_id: Option<String>,
        category: LogCategory,
        app: Option<&tauri::AppHandle>,
    ) {
        let entry = Self::build_entry(level, message, task_id.clone(), category);
        self.append_entries(std::slice::from_ref(&entry));

        if let Some(app) = app {
            let _ = app.emit(
                "new-log-task",
                &LogEvent {
                    task_id: task_id.clone(),
                    entry,
                },
            );
        }
    }

    pub fn log_with_event(
        &self,
        level: &str,
        message: &str,
        task_id: Option<String>,
        app: Option<&tauri::AppHandle>,
    ) {
        self.log_with_category_and_event(level, message, task_id, LogCategory::Other, app);
    }

    pub fn log_with_category(
        &self,
        level: &str,
        message: &str,
        task_id: Option<String>,
        category: LogCategory,
    ) {
        self.log_with_category_and_event(level, message, task_id, category, None);
    }

    /// Add multiple logs at once and optionally emit a batch event
    pub fn log_batch_entries(
        &self,
        entries: Vec<LogEntry>,
        task_id: Option<String>,
        app: Option<&tauri::AppHandle>,
    ) {
        if entries.is_empty() {
            return;
        }
        self.append_entries(&entries);

        if let Some(app) = app {
            let _ = app.emit("new-logs-batch", &LogBatchEvent { task_id, entries });
        }
    }

    pub fn log_batch_with_category(
        &self,
        mut entries: Vec<LogEntry>,
        task_id: Option<String>,
        category: LogCategory,
        app: Option<&tauri::AppHandle>,
    ) {
        for entry in &mut entries {
            entry.category = category.clone();
        }
        self.log_batch_entries(entries, task_id, app);
    }

    /// Backward-compatible API: defaults all batch entries to Other category.
    pub fn log_batch(
        &self,
        entries: Vec<LogEntry>,
        task_id: Option<String>,
        app: Option<&tauri::AppHandle>,
    ) {
        self.log_batch_with_category(entries, task_id, LogCategory::Other, app);
    }

    pub fn log(&self, level: &str, message: &str, task_id: Option<String>) {
        self.log_with_category(level, message, task_id, LogCategory::Other);
    }

    pub fn get_logs(&self, task_id: Option<String>) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        match task_id {
            Some(id) => logs
                .iter()
                .filter(|l| l.task_id.as_ref() == Some(&id))
                .cloned()
                .collect(),
            None => logs.iter().cloned().collect(),
        }
    }

    pub fn get_activity_logs(&self) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        logs.iter()
            .filter(|entry| entry.category.is_activity_visible())
            .cloned()
            .collect()
    }

    pub fn get_task_logs_filtered(&self, task_id: &str) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        logs.iter()
            .filter(|entry| entry.task_id.as_deref() == Some(task_id))
            .filter(|entry| entry.category.is_task_visible())
            .cloned()
            .collect()
    }

    /// Get logs with pagination for better performance with large log sets
    pub fn get_logs_paginated(
        &self,
        task_id: Option<String>,
        offset: usize,
        limit: usize,
    ) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        // Since we can't efficiently index filter iterator on VecDeque without collecting,
        // and we need to filter by task_id first:
        let filtered: Vec<_> = match task_id {
            Some(id) => logs
                .iter()
                .filter(|l| l.task_id.as_ref() == Some(&id))
                .collect(),
            None => logs.iter().collect(),
        };

        let start = offset.min(filtered.len());
        let end = (offset + limit).min(filtered.len());

        filtered[start..end]
            .iter()
            .map(|&entry| entry.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_manager_new() {
        let manager = LogManager::new(100);
        // Just verify it doesn't panic
        assert_eq!(manager.system_logs.lock().unwrap().len(), 0);
    }

    #[test]
    fn test_log_manager_log() {
        let manager = LogManager::new(10);

        manager.log("info", "test message", None);
        assert_eq!(manager.system_logs.lock().unwrap().len(), 1);

        manager.log("warning", "another message", Some("task1".to_string()));
        assert_eq!(manager.system_logs.lock().unwrap().len(), 2);
    }

    #[test]
    fn test_log_manager_rotation() {
        let manager = LogManager::new(3);

        // Add more logs than max_lines
        for i in 0..5 {
            manager.log("info", &format!("message {}", i), None);
        }

        let logs = manager.system_logs.lock().unwrap();
        assert_eq!(logs.len(), 3); // Should rotate to max_lines
    }

    #[test]
    fn test_log_manager_get_logs() {
        let manager = LogManager::new(10);

        manager.log("info", "message1", None);
        manager.log("info", "message2", Some("task1".to_string()));
        manager.log("warning", "message3", Some("task1".to_string()));

        // Get all logs
        let all_logs = manager.get_logs(None);
        assert_eq!(all_logs.len(), 3);

        // Get logs by task
        let task_logs = manager.get_logs(Some("task1".to_string()));
        assert_eq!(task_logs.len(), 2);

        // Get logs for non-existent task
        let empty_logs = manager.get_logs(Some("nonexistent".to_string()));
        assert_eq!(empty_logs.len(), 0);
    }

    #[test]
    fn test_log_manager_pagination() {
        let manager = LogManager::new(100);

        // Add 20 logs
        for i in 0..20 {
            manager.log("info", &format!("message {}", i), None);
        }

        // Get first 10
        let page1 = manager.get_logs_paginated(None, 0, 10);
        assert_eq!(page1.len(), 10);

        // Get next 10
        let page2 = manager.get_logs_paginated(None, 10, 10);
        assert_eq!(page2.len(), 10);

        // Offset beyond available
        let page3 = manager.get_logs_paginated(None, 20, 10);
        assert_eq!(page3.len(), 0);
    }

    #[test]
    fn test_default_max_log_lines() {
        assert_eq!(DEFAULT_MAX_LOG_LINES, 10000);
    }

    #[test]
    fn test_activity_logs_only_include_activity_categories() {
        let manager = LogManager::new(10);

        manager.log_with_category(
            "info",
            "sync-start",
            Some("task1".to_string()),
            LogCategory::SyncStarted,
        );
        manager.log_with_category(
            "success",
            "sync-end",
            Some("task1".to_string()),
            LogCategory::SyncCompleted,
        );
        manager.log_with_category(
            "info",
            "copied-file",
            Some("task1".to_string()),
            LogCategory::FileCopied,
        );
        manager.log_with_category(
            "warning",
            "misc",
            Some("task1".to_string()),
            LogCategory::Other,
        );

        let activity_logs = manager.get_activity_logs();
        assert_eq!(activity_logs.len(), 2);
        assert!(activity_logs
            .iter()
            .all(|entry| entry.category.is_activity_visible()));
    }

    #[test]
    fn test_task_logs_include_task_categories_and_task_id_only() {
        let manager = LogManager::new(20);

        manager.log_with_category(
            "info",
            "watch-start",
            Some("task1".to_string()),
            LogCategory::WatchStarted,
        );
        manager.log_with_category(
            "info",
            "copy-a",
            Some("task1".to_string()),
            LogCategory::FileCopied,
        );
        manager.log_with_category(
            "info",
            "delete-a",
            Some("task1".to_string()),
            LogCategory::FileDeleted,
        );
        manager.log_with_category(
            "warning",
            "cancelled",
            Some("task1".to_string()),
            LogCategory::Other,
        );
        manager.log_with_category(
            "info",
            "copy-b",
            Some("task2".to_string()),
            LogCategory::FileCopied,
        );
        manager.log_with_category("info", "mounted", None, LogCategory::VolumeMounted);

        let task_logs = manager.get_task_logs_filtered("task1");
        assert_eq!(task_logs.len(), 3);
        assert!(task_logs
            .iter()
            .all(|entry| entry.task_id.as_deref() == Some("task1")));
        assert!(task_logs
            .iter()
            .all(|entry| entry.category.is_task_visible()));
    }

    #[test]
    fn test_log_category_visibility_whitelist_is_exact() {
        let categories = [
            LogCategory::SyncStarted,
            LogCategory::SyncCompleted,
            LogCategory::SyncError,
            LogCategory::WatchStarted,
            LogCategory::WatchStopped,
            LogCategory::VolumeMounted,
            LogCategory::VolumeUnmounted,
            LogCategory::FileCopied,
            LogCategory::FileDeleted,
            LogCategory::Other,
        ];

        let activity_visible: Vec<LogCategory> = categories
            .iter()
            .filter(|category| category.is_activity_visible())
            .cloned()
            .collect();
        let task_visible: Vec<LogCategory> = categories
            .iter()
            .filter(|category| category.is_task_visible())
            .cloned()
            .collect();

        assert_eq!(
            activity_visible,
            vec![
                LogCategory::SyncStarted,
                LogCategory::SyncCompleted,
                LogCategory::SyncError,
                LogCategory::WatchStarted,
                LogCategory::WatchStopped,
                LogCategory::VolumeMounted,
                LogCategory::VolumeUnmounted,
            ]
        );

        assert_eq!(
            task_visible,
            vec![
                LogCategory::SyncStarted,
                LogCategory::SyncCompleted,
                LogCategory::SyncError,
                LogCategory::WatchStarted,
                LogCategory::WatchStopped,
                LogCategory::FileCopied,
                LogCategory::FileDeleted,
            ]
        );
    }
}

#[tauri::command]
pub async fn add_log(
    level: String,
    message: String,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.log_manager.log(&level, &message, task_id);
    Ok(())
}

#[tauri::command]
pub fn get_system_logs(state: tauri::State<'_, AppState>) -> Vec<LogEntry> {
    state.log_manager.get_activity_logs()
}

#[tauri::command]
pub fn get_task_logs(task_id: String, state: tauri::State<'_, AppState>) -> Vec<LogEntry> {
    state.log_manager.get_task_logs_filtered(&task_id)
}
