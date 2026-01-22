use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub task_id: Option<String>,
}

pub struct LogManager {
    system_logs: Arc<Mutex<Vec<LogEntry>>>,
    max_lines: usize,
}

impl LogManager {
    pub fn new(max_lines: usize) -> Self {
        Self {
            system_logs: Arc::new(Mutex::new(Vec::new())),
            max_lines,
        }
    }

    pub fn log(&self, level: &str, message: &str, task_id: Option<String>) {
        let entry = LogEntry {
            id: chrono::Utc::now().to_rfc3339().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339().to_string(),
            level: level.to_string(),
            message: message.to_string(),
            task_id,
        };

        let mut logs = self.system_logs.lock().unwrap();
        logs.push(entry);

        let len = logs.len();
        if len > self.max_lines {
            logs.drain(0..(len - self.max_lines));
        }
    }

    pub fn get_logs(&self, task_id: Option<String>) -> Vec<LogEntry> {
        let logs = self.system_logs.lock().unwrap();
        match task_id {
            Some(id) => logs.iter().filter(|l| l.task_id.as_ref() == Some(&id)).cloned().collect(),
            None => logs.clone(),
        }
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
