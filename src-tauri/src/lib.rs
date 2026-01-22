pub mod sync_engine;
pub mod system_integration;

use std::path::PathBuf;

use sync_engine::{SyncEngine, SyncOptions, DryRunResult};
use system_integration::{DiskMonitor};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
        verify_after_copy: false, // Dry run doesn't copy, so this doesn't matter, but required for struct
    };

    engine.dry_run(&options)
        .await
        .map_err(|e| e.to_string())
}

use tauri::{Emitter, Window}; // Add Window and Emitter traits

#[tauri::command]
fn list_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.list_volumes()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_sync(
    window: Window,
    source: PathBuf,
    target: PathBuf,
    delete_missing: bool,
    checksum_mode: bool,
    verify_after_copy: bool,
) -> Result<sync_engine::types::SyncResult, String> {
    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        delete_missing,
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy,
    };

    engine.sync_files(&options, move |progress| {
        let _ = window.emit("sync-progress", progress);
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            sync_dry_run,
            sync_dry_run,
            list_volumes,
            start_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
