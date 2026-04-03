use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::apple_bridge;
use crate::config_store::{self, ConfigStoreError, SyncTaskRecord};
use crate::distribution::{channel_policy, detect_distribution_channel, DistributionChannel};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapturedPathAccess {
    pub path: String,
    pub bookmark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportStatus {
    pub available: bool,
    pub imported: bool,
    pub message: Option<String>,
}

#[derive(Clone, Default)]
pub struct SecurityScopedAccessManager {
    active_paths_by_bookmark: Arc<Mutex<HashMap<String, String>>>,
}

impl SecurityScopedAccessManager {
    pub fn activate_bookmark(&self, bookmark: &str) -> Result<String, String> {
        if bookmark.trim().is_empty() {
            return Err("Security-scoped bookmark is empty".to_string());
        }

        if let Some(existing) = self
            .active_paths_by_bookmark
            .lock()
            .map_err(|_| "Security-scoped access state lock poisoned".to_string())?
            .get(bookmark)
            .cloned()
        {
            return Ok(existing);
        }

        let resolved = apple_bridge::resolve_security_scoped_bookmark(bookmark)?;
        if resolved.stale {
            return Err(format!(
                "Folder access needs to be granted again for '{}'. Re-select the folder in SyncWatcher.",
                resolved.path
            ));
        }

        self.active_paths_by_bookmark
            .lock()
            .map_err(|_| "Security-scoped access state lock poisoned".to_string())?
            .insert(bookmark.to_string(), resolved.path.clone());
        Ok(resolved.path)
    }
}

pub fn capture_path_access(app: &AppHandle, path: String) -> Result<CapturedPathAccess, String> {
    let policy = channel_policy(detect_distribution_channel(Some(app)));
    if !policy.requires_security_scoped_bookmarks {
        return Ok(CapturedPathAccess {
            path,
            bookmark: None,
        });
    }

    let captured = apple_bridge::create_security_scoped_bookmark(&path)?;
    Ok(CapturedPathAccess {
        path: captured.path,
        bookmark: Some(captured.bookmark),
    })
}

pub fn activate_sync_task_path_access(
    task: &SyncTaskRecord,
    manager: &SecurityScopedAccessManager,
) -> Result<(), String> {
    if let Some(source_bookmark) = task.source_bookmark.as_deref() {
        let _ = manager.activate_bookmark(source_bookmark)?;
    }
    if let Some(target_bookmark) = task.target_bookmark.as_deref() {
        let _ = manager.activate_bookmark(target_bookmark)?;
    }
    Ok(())
}

pub fn activate_settings_path_access(
    settings: &config_store::StoredSettings,
    manager: &SecurityScopedAccessManager,
) -> Result<(), String> {
    if let Some(bookmark) = settings.state_location_bookmark.as_deref() {
        let _ = manager.activate_bookmark(bookmark)?;
    }
    Ok(())
}

fn legacy_config_dir_for_current_channel(
    app: &AppHandle,
) -> Result<Option<PathBuf>, ConfigStoreError> {
    let current_identifier = app.config().identifier.as_str();
    if current_identifier == config_store::APP_IDENTIFIER {
        return Ok(None);
    }

    let current_dir = config_store::app_support_dir_for_app(app)?;
    let legacy_dir = current_dir
        .parent()
        .map(|parent| parent.join(config_store::APP_IDENTIFIER))
        .unwrap_or_else(|| PathBuf::from(config_store::APP_IDENTIFIER));
    Ok(Some(legacy_dir))
}

pub fn legacy_import_available(app: &AppHandle) -> bool {
    if detect_distribution_channel(Some(app)) != DistributionChannel::AppStore {
        return false;
    }

    let Ok(Some(legacy_dir)) = legacy_config_dir_for_current_channel(app) else {
        return false;
    };
    let legacy_config_dir = legacy_dir.join("config");
    let has_legacy_files = [
        legacy_config_dir.join(config_store::SETTINGS_FILE_NAME),
        legacy_config_dir.join(config_store::TASKS_FILE_NAME),
        legacy_config_dir.join(config_store::EXCLUSION_SETS_FILE_NAME),
    ]
    .into_iter()
    .any(|path| path.exists());

    let Ok(current_config_dir) = config_store::config_dir_for_app(app) else {
        return false;
    };
    let current_has_files = [
        current_config_dir.join(config_store::SETTINGS_FILE_NAME),
        current_config_dir.join(config_store::TASKS_FILE_NAME),
        current_config_dir.join(config_store::EXCLUSION_SETS_FILE_NAME),
    ]
    .into_iter()
    .any(|path| path.exists());

    has_legacy_files && !current_has_files
}

pub fn import_legacy_channel_data(app: &AppHandle) -> Result<LegacyImportStatus, String> {
    let Some(legacy_dir) =
        legacy_config_dir_for_current_channel(app).map_err(config_store_error_to_string)?
    else {
        return Ok(LegacyImportStatus {
            available: false,
            imported: false,
            message: Some("Legacy import is not needed for this build.".to_string()),
        });
    };

    let legacy_config_dir = legacy_dir.join("config");
    if !legacy_config_dir.exists() {
        return Ok(LegacyImportStatus {
            available: false,
            imported: false,
            message: Some("No GitHub DMG configuration was found to import.".to_string()),
        });
    }

    let current_config_dir =
        config_store::config_dir_for_app(app).map_err(config_store_error_to_string)?;
    std::fs::create_dir_all(&current_config_dir)
        .map_err(|error| format!("Failed to create current config dir: {error}"))?;

    let file_names = [
        config_store::SETTINGS_FILE_NAME,
        config_store::TASKS_FILE_NAME,
        config_store::EXCLUSION_SETS_FILE_NAME,
    ];
    let mut imported_any = false;

    for file_name in file_names {
        let source = legacy_config_dir.join(file_name);
        if !source.exists() {
            continue;
        }
        let target = current_config_dir.join(file_name);
        std::fs::copy(&source, &target)
            .map_err(|error| format!("Failed to import '{}': {error}", file_name))?;
        imported_any = true;
    }

    Ok(LegacyImportStatus {
        available: imported_any,
        imported: imported_any,
        message: if imported_any {
            Some(
                "Imported settings and task data from the GitHub DMG build. Re-select folders once in the Mac App Store build to refresh sandbox access."
                    .to_string(),
            )
        } else {
            Some("No GitHub DMG configuration was found to import.".to_string())
        },
    })
}

fn config_store_error_to_string(error: ConfigStoreError) -> String {
    error.to_tauri_error_string()
}

#[allow(dead_code)]
fn _ensure_path_is_used(path: &Path) -> &Path {
    path
}
