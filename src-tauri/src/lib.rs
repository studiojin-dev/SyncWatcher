pub mod sync_engine;
pub mod system_integration;
pub mod logging;
pub mod license;
pub mod path_validation;

#[cfg(test)]
mod lib_tests;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

use sync_engine::{types::SyncResult, DryRunResult, SyncEngine, SyncOptions};
use system_integration::{DiskMonitor};

use logging::LogManager;
use logging::{add_log, get_system_logs, get_task_logs, DEFAULT_MAX_LOG_LINES};
use license::generate_licenses_report;

pub struct AppState {
    pub log_manager: Arc<LogManager>,
}

#[tauri::command]
async fn get_app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let config_dir = app_data.join("config");
    tokio::fs::create_dir_all(&config_dir)
        .await
        .map_err(|e| e.to_string())?;
    Ok(config_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn join_paths(path1: String, path2: String) -> Result<String, String> {
    use std::path::Path;
    let p1 = Path::new(&path1);
    let p2 = Path::new(&path2);
    p1.join(p2)
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
#[allow(dead_code)]
async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path().app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_yaml_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_yaml_file(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_directory_exists(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
async fn open_in_editor(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    // Path validation for security
    let path_obj = Path::new(&path);

    // Only allow absolute paths
    if !path_obj.is_absolute() {
        return Err("Only absolute paths are allowed".to_string());
    }

    // Canonicalize the path to resolve symlinks and .. components
    let canonical = path_obj
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    // Get the config directory for validation
    let app_data = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let config_dir = app_data.join("config");

    // Ensure config directory exists for comparison
    let config_canonical = config_dir
        .canonicalize()
        .unwrap_or(config_dir);

    // Verify the path is within the config directory
    let canonical_str = canonical.to_string_lossy();
    let config_str = config_canonical.to_string_lossy();

    if !canonical_str.as_ref().starts_with(config_str.as_ref()) {
        return Err(format!("Access denied: Path outside config directory\nAllowed: {config_str}\nRequested: {canonical_str}"));
    }

    // Try to open with default system editor
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-t")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open first, fall back to common editors
        let editors = vec!["xdg-open", "gedit", "kate", "code", "vim"];
        let mut opened = false;

        for editor in editors {
            if std::process::Command::new(editor)
                .arg(&canonical)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err("No suitable editor found".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad.exe")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn sync_dry_run(
    source: PathBuf,
    target: PathBuf,
    delete_missing: bool,
    checksum_mode: bool,
    exclude_patterns: Vec<String>,
) -> Result<DryRunResult, String> {
    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        delete_missing,
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy: false,
        exclude_patterns,
    };

    engine.dry_run(&options).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn list_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.list_volumes().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_removable_volumes() -> Result<Vec<system_integration::VolumeInfo>, String> {
    let monitor = DiskMonitor::new();
    monitor.get_removable_volumes().map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_sync(
    source: PathBuf,
    target: PathBuf,
    delete_missing: bool,
    checksum_mode: bool,
    verify_after_copy: bool,
    exclude_patterns: Vec<String>,
    app: tauri::AppHandle,
) -> Result<SyncResult, String> {
    let engine = SyncEngine::new(source, target);
    let options = SyncOptions {
        delete_missing,
        checksum_mode,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy,
        exclude_patterns,
    };

    engine
        .sync_files(&options, |progress| {
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            log_manager: Arc::new(LogManager::new(DEFAULT_MAX_LOG_LINES)),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            sync_dry_run,
            list_volumes,
            get_removable_volumes,
            start_sync,
            list_sync_tasks,
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
