use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use crate::AppState;

/// Default maximum number of log lines to keep in memory
pub const DEFAULT_MAX_LOG_LINES: usize = 10000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub task_id: Option<String>,
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

    pub fn log_with_event(&self, level: &str, message: &str, task_id: Option<String>, app: Option<&tauri::AppHandle>) {
        let now = chrono::Utc::now().to_rfc3339();
        let entry = LogEntry {
            id: now.clone(),
            timestamp: now,
            level: level.to_string(),
            message: message.to_string(),
            task_id: task_id.clone(),
        };

        let mut logs = self.system_logs.lock().unwrap();
        logs.push_back(entry.clone()); // Add to end

        // Remove from front if full
        while logs.len() > self.max_lines {
            logs.pop_front();
        }

        // Emit event to frontend if app handle is provided
        if let Some(app) = app {
            let _ = app.emit("new-log-task", &LogEvent {
                task_id: task_id.clone(),
                entry,
            });
        }
    }

    /// Add multiple logs at once and optionally emit a batch event
    pub fn log_batch(&self, entries: Vec<LogEntry>, task_id: Option<String>, app: Option<&tauri::AppHandle>) {
        if entries.is_empty() { return; }

        let mut logs = self.system_logs.lock().unwrap();
        
        for entry in &entries {
            logs.push_back(entry.clone());
        }

        while logs.len() > self.max_lines {
            logs.pop_front();
        }

        if let Some(app) = app {
            let _ = app.emit("new-logs-batch", &LogBatchEvent {
                task_id,
                entries,
            });
        }
    }

    pub fn log(&self, level: &str, message: &str, task_id: Option<String>) {
        self.log_with_event(level, message, task_id, None);
    }

    pub fn get_logs(&self, task_id: Option<String>) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        match task_id {
            Some(id) => logs.iter().filter(|l| l.task_id.as_ref() == Some(&id)).cloned().collect(),
            None => logs.iter().cloned().collect(),
        }
    }

    /// Get logs with pagination for better performance with large log sets
    pub fn get_logs_paginated(&self, task_id: Option<String>, offset: usize, limit: usize) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        // Since we can't efficiently index filter iterator on VecDeque without collecting,
        // and we need to filter by task_id first:
        let filtered: Vec<_> = match task_id {
            Some(id) => logs.iter().filter(|l| l.task_id.as_ref() == Some(&id)).collect(),
            None => logs.iter().collect(),
        };

        let start = offset.min(filtered.len());
        let end = (offset + limit).min(filtered.len());

        filtered[start..end].iter().map(|&entry| entry.clone()).collect()
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
}

#[tauri::command]
pub async fn add_log(level: String, message: String, task_id: Option<String>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.log_manager.log(&level, &message, task_id);
    Ok(())
}

#[tauri::command]
pub fn get_system_logs(state: tauri::State<'_, AppState>) -> Vec<LogEntry> {
    state.log_manager.get_logs(None)
}

#[tauri::command]
pub fn get_task_logs(task_id: String, state: tauri::State<'_, AppState>) -> Vec<LogEntry> {
    state.log_manager.get_logs(Some(task_id))
}
