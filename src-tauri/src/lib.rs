pub mod sync_engine;
pub mod system_integration;
pub mod logging;
pub mod license;
pub mod path_validation;
pub mod watcher;
pub mod input_validation;

#[cfg(test)]
mod lib_tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use tauri::{Emitter, Manager};

use sync_engine::{types::SyncResult, DryRunResult, SyncEngine, SyncOptions};
use system_integration::{DiskMonitor};

use logging::LogManager;
use logging::{add_log, get_system_logs, get_task_logs, DEFAULT_MAX_LOG_LINES};
use license::generate_licenses_report;

use watcher::{WatcherManager, WatchEvent};

/// Consolidated state for sync progress tracking to prevent race conditions
#[derive(Clone)]
struct SyncProgressState {
    inner: Arc<Mutex<SyncProgressStateInner>>,
}

    // Consolidated progress state (prevents race conditions and deadlocks)
    struct SyncProgressStateInner {
        last_emit_time: Instant,
        last_file: String,
        log_buffer: Vec<logging::LogEntry>,
        last_log_emit_time: Instant,
    }

    impl SyncProgressStateInner {
        fn new() -> Self {
            Self {
                last_emit_time: Instant::now(),
                last_file: String::new(),
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

        fn should_update_file(&self, current_file: &str) -> bool {
            let state = self.inner.try_lock();
            if let Ok(mut state) = state {
                if state.last_file != current_file {
                    state.last_file = current_file.to_string();
                    true
                } else {
                    false
                }
            } else {
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
                false
            }
        }

        fn add_log(&self, entry: logging::LogEntry) -> Option<Vec<logging::LogEntry>> {
            let state = self.inner.try_lock();
            if let Ok(mut state) = state {
                state.log_buffer.push(entry);
                
                // Flush if buffer full or time elapsed (200ms)
                if state.log_buffer.len() >= 50 || state.last_log_emit_time.elapsed() >= Duration::from_millis(200) {
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

    let progress_state = SyncProgressState::new();
    let log_manager = state.log_manager.clone();
    let task_id_for_log = task_id.clone();
    let app_for_log = app.clone(); // For log events

    let result = tokio::select! {
        res = engine.sync_files(&options, move |progress| {
             // 1. Detailed Logging: Batching
            if let Some(current) = &progress.current_file {
                if progress_state.should_update_file(current) {
                    let now = chrono::Utc::now().to_rfc3339();
                    let entry = logging::LogEntry {
                        id: now.clone(),
                        timestamp: now,
                        level: "info".to_string(),
                        message: format!("Syncing: {}", current),
                        task_id: Some(task_id_for_log.clone()),
                    };
                    
                    if let Some(batch) = progress_state.add_log(entry) {
                         log_manager.log_batch(batch, Some(task_id_for_log.clone()), Some(&app_for_log));
                    }
                }
            }

             // 2. UI Throttling: 100ms
            let should_emit = progress_state.should_emit_progress();

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
                log_manager.log_batch(batch, Some(task_id.clone()), Some(&app));
            }
            res
        },
        _ = cancel_token.cancelled() => {
             // Flush logs on cancel too
            if let Some(batch) = progress_state.flush_logs() {
                log_manager.log_batch(batch, Some(task_id.clone()), Some(&app));
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
             let msg = format!(
                "Sync completed.\nCopied: {} files\nDeleted: {} files\nData transferred: {}",
                format_number(res.files_copied), 
                format_number(res.files_deleted), 
                format_bytes(res.bytes_copied)
            );
            state.log_manager.log("success", &msg, Some(task_id));
        }
        Err(e) => {
            let msg = format!("Sync failed: {:#}", e);
            state.log_manager.log("error", &msg, Some(task_id));
        }
    }

    result.map_err(|e| format!("{:#}", e))
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
        state.log_manager.log("warning", "Operation cancelled by user", Some(task_id));
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
    // Validate inputs
    input_validation::validate_task_id(&task_id).map_err(|e| e.to_string())?;
    input_validation::validate_path_argument(source_path.to_str().unwrap_or("")).map_err(|e| e.to_string())?;

    let task_id_clone = task_id.clone();
    let app_clone = app.clone();
    
    let mut manager = state.watcher_manager.write().await;
    manager.start_watching(task_id.clone(), source_path.clone(), move |event| {
        // 변경 감지 시 프론트엔드에 이벤트 전송
        let watch_event = WatchEvent::from_notify_event(task_id_clone.clone(), &event);
        let _ = app_clone.emit("watch-event", &watch_event);
    }).map_err(|e| format!("감시 시작 실패: {}", e))?;
    
    state.log_manager.log(
        "info", 
        &format!("Watch started: {}", source_path.display()), 
        Some(task_id)
    );
    
    Ok(())
}

/// 파일 시스템 감시를 중지합니다.
#[tauri::command]
async fn stop_watch(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut manager = state.watcher_manager.write().await;
    manager.stop_watching(&task_id)
        .map_err(|e| format!("감시 중지 실패: {}", e))?;
    
    state.log_manager.log("info", "Watch stopped", Some(task_id));
    Ok(())
}

/// 현재 감시 중인 Task 목록을 반환합니다.
#[tauri::command]
async fn get_watching_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let manager = state.watcher_manager.read().await;
    Ok(manager.get_watching_tasks())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncTask {
    pub id: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub enabled: bool,
}

pub fn format_bytes(bytes: u64) -> String {
    const UNIT: u64 = 1024;
    if bytes < UNIT {
        return format!("{} B", format_number(bytes));
    }
    let exp = (bytes as f64).ln() / (UNIT as f64).ln();
    let pre = "KMGTPE".chars().nth(exp as usize - 1).unwrap_or('?');
    format!("{:.2} {}B", bytes as f64 / UNIT.pow(exp as u32) as f64, pre)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            log_manager: Arc::new(LogManager::new(DEFAULT_MAX_LOG_LINES)),
            cancel_tokens: Arc::new(RwLock::new(HashMap::new())),
            watcher_manager: Arc::new(RwLock::new(WatcherManager::new())),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            sync_dry_run,
            list_volumes,
            get_removable_volumes,
            unmount_volume,
            start_sync,
            list_sync_tasks,
            cancel_operation,
            send_notification,
            start_watch,
            stop_watch,
            get_watching_tasks,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

