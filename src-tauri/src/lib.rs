pub mod sync_engine;
pub mod system_integration;

use std::path::PathBuf;
use tauri::Emitter;

use sync_engine::{SyncEngine, SyncOptions, DryRunResult, types::SyncResult};
use system_integration::{DiskMonitor};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[tauri::command]
async fn sync_dry_run(
    source: PathBuf,
    target: PathBuf,
    delete_missing: bool,
    checksum_mode: bool,
) -> Result<DryRunResult, String> {
    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        delete_missing,
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy: false,
    };

    engine.dry_run(&options)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.list_volumes()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_sync(
    source: PathBuf,
    target: PathBuf,
    delete_missing: bool,
    checksum_mode: bool,
    verify_after_copy: bool,
    app: tauri::AppHandle,
) -> Result<SyncResult, String> {
    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        delete_missing,
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy,
    };

    engine.sync_files(&options, |progress| {
        let _ = app.emit("sync-progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sync_tasks() -> Result<Vec<SyncTask>, String> {
    Ok(vec![])
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncTask {
    pub id: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub enabled: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            sync_dry_run,
            list_volumes,
            start_sync,
            list_sync_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
