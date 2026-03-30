use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt as _;
use tempfile::NamedTempFile;

use crate::input_validation;
use crate::license_validation;
use crate::recurring::{
    normalize_recurring_schedules, validate_guided_preset_compatible_schedules,
    RecurringScheduleRecord,
};
use crate::DataUnitSystem;

pub const APP_IDENTIFIER: &str = "dev.studiojin.syncwatcher";
pub const SETTINGS_FILE_NAME: &str = "settings.yaml";
pub const TASKS_FILE_NAME: &str = "tasks.yaml";
pub const EXCLUSION_SETS_FILE_NAME: &str = "exclusion_sets.yaml";
pub const CONTROL_PLANE_SOCKET_FILE_NAME: &str = "syncwatcher-mcp.sock";

const APP_SUPPORT_DIR_OVERRIDE_ENV: &str = "SYNCWATCHER_APP_SUPPORT_DIR";
const DEFAULT_MAX_LOG_LINES: u32 = 10_000;
const SYSTEM_DEFAULTS_SET_ID: &str = "system-defaults";
const GIT_SET_ID: &str = "git";
const PROGRAM_SET_ID: &str = "program";
const LEGACY_PROGRAM_SET_IDS: [&str; 10] = [
    "nodejs",
    "python",
    "rust",
    "jvm-build",
    "dotnet",
    "ruby-rails",
    "php-laravel",
    "dart-flutter",
    "swift-xcode",
    "infra-terraform",
];

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    #[default]
    Quit,
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    Path,
    Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceUuidType {
    Disk,
    Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettings {
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default = "default_data_unit_system")]
    pub data_unit_system: DataUnitSystem,
    #[serde(default = "default_notifications")]
    pub notifications: bool,
    #[serde(default)]
    pub state_location: String,
    #[serde(default = "default_max_log_lines")]
    pub max_log_lines: u32,
    #[serde(default)]
    pub close_action: CloseAction,
    #[serde(default)]
    pub mcp_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub language: String,
    pub theme: ThemeMode,
    pub data_unit_system: DataUnitSystem,
    pub notifications: bool,
    pub state_location: String,
    pub max_log_lines: u32,
    pub close_action: CloseAction,
    pub is_registered: bool,
    pub launch_at_login: bool,
    pub mcp_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub language: Option<String>,
    pub theme: Option<ThemeMode>,
    pub data_unit_system: Option<DataUnitSystem>,
    pub notifications: Option<bool>,
    pub state_location: Option<String>,
    pub max_log_lines: Option<u32>,
    pub close_action: Option<CloseAction>,
    pub mcp_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpSettingsPatch {
    pub language: Option<String>,
    pub theme: Option<ThemeMode>,
    pub data_unit_system: Option<DataUnitSystem>,
    pub notifications: Option<bool>,
    pub close_action: Option<CloseAction>,
    pub mcp_enabled: Option<bool>,
}

impl SettingsPatch {
    pub fn apply_to(&self, settings: &mut StoredSettings) {
        if let Some(language) = self.language.clone() {
            settings.language = language;
        }
        if let Some(theme) = self.theme.clone() {
            settings.theme = theme;
        }
        if let Some(data_unit_system) = self.data_unit_system {
            settings.data_unit_system = data_unit_system;
        }
        if let Some(notifications) = self.notifications {
            settings.notifications = notifications;
        }
        if let Some(state_location) = self.state_location.clone() {
            settings.state_location = state_location;
        }
        if let Some(max_log_lines) = self.max_log_lines {
            settings.max_log_lines = max_log_lines;
        }
        if let Some(close_action) = self.close_action.clone() {
            settings.close_action = close_action;
        }
        if let Some(mcp_enabled) = self.mcp_enabled {
            settings.mcp_enabled = mcp_enabled;
        }
    }
}

impl From<McpSettingsPatch> for SettingsPatch {
    fn from(value: McpSettingsPatch) -> Self {
        Self {
            language: value.language,
            theme: value.theme,
            data_unit_system: value.data_unit_system,
            notifications: value.notifications,
            state_location: None,
            max_log_lines: None,
            close_action: value.close_action,
            mcp_enabled: value.mcp_enabled,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncTaskRecord {
    pub id: String,
    pub name: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub checksum_mode: bool,
    #[serde(default = "default_verify_after_copy")]
    pub verify_after_copy: bool,
    #[serde(default)]
    pub exclusion_sets: Vec<String>,
    #[serde(default)]
    pub watch_mode: bool,
    #[serde(default)]
    pub auto_unmount: bool,
    #[serde(default)]
    pub source_type: Option<SourceType>,
    #[serde(default)]
    pub source_uuid: Option<String>,
    #[serde(default)]
    pub source_uuid_type: Option<SourceUuidType>,
    #[serde(default)]
    pub source_sub_path: Option<String>,
    #[serde(default)]
    pub source_identity: Option<SourceIdentitySnapshot>,
    #[serde(default)]
    pub recurring_schedules: Vec<RecurringScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceIdentitySnapshot {
    #[serde(default)]
    pub device_serial: Option<String>,
    #[serde(default)]
    pub media_uuid: Option<String>,
    #[serde(default)]
    pub device_guid: Option<String>,
    #[serde(default)]
    pub transport_serial: Option<String>,
    #[serde(default)]
    pub bus_protocol: Option<String>,
    #[serde(default)]
    pub filesystem_name: Option<String>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub volume_name: Option<String>,
    #[serde(default)]
    pub last_seen_disk_uuid: Option<String>,
    #[serde(default)]
    pub last_seen_volume_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSyncTaskRequest {
    pub name: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub checksum_mode: bool,
    #[serde(default = "default_verify_after_copy")]
    pub verify_after_copy: bool,
    #[serde(default)]
    pub exclusion_sets: Vec<String>,
    #[serde(default)]
    pub watch_mode: bool,
    #[serde(default)]
    pub auto_unmount: bool,
    #[serde(default)]
    pub source_type: Option<SourceType>,
    #[serde(default)]
    pub source_uuid: Option<String>,
    #[serde(default)]
    pub source_uuid_type: Option<SourceUuidType>,
    #[serde(default)]
    pub source_sub_path: Option<String>,
    #[serde(default)]
    pub source_identity: Option<SourceIdentitySnapshot>,
    #[serde(default)]
    pub recurring_schedules: Vec<RecurringScheduleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSyncTaskRequest {
    pub task_id: String,
    pub name: Option<String>,
    pub source: Option<String>,
    pub target: Option<String>,
    pub checksum_mode: Option<bool>,
    pub verify_after_copy: Option<bool>,
    pub exclusion_sets: Option<Vec<String>>,
    pub watch_mode: Option<bool>,
    pub auto_unmount: Option<bool>,
    pub source_type: Option<SourceType>,
    pub source_uuid: Option<String>,
    pub source_uuid_type: Option<SourceUuidType>,
    pub source_sub_path: Option<String>,
    pub source_identity: Option<SourceIdentitySnapshot>,
    pub recurring_schedules: Option<Vec<RecurringScheduleRecord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionSetRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStoreChangedEvent {
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsEnvelope {
    pub settings: SettingsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncTaskEnvelope {
    pub task: SyncTaskRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncTasksEnvelope {
    pub tasks: Vec<SyncTaskRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionSetEnvelope {
    pub set: ExclusionSetRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionSetsEnvelope {
    pub sets: Vec<ExclusionSetRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResultEnvelope {
    pub deleted: bool,
}

pub type AppSettings = StoredSettings;
pub type ThemeSetting = ThemeMode;
pub type CloseActionSetting = CloseAction;
pub type UpdateSettingsPayload = SettingsPatch;
pub type NewSyncTaskRecord = CreateSyncTaskRequest;
pub type SyncTaskSourceType = SourceType;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "type")]
pub enum ConfigStoreError {
    ParseError {
        message: String,
        file_path: String,
        raw_content: String,
        line: Option<usize>,
        column: Option<usize>,
    },
    IoError {
        message: String,
        file_path: Option<String>,
    },
    ValidationError {
        message: String,
    },
    NotFound {
        message: String,
    },
}

impl ConfigStoreError {
    pub fn message(&self) -> &str {
        match self {
            Self::ParseError { message, .. }
            | Self::IoError { message, .. }
            | Self::ValidationError { message }
            | Self::NotFound { message } => message,
        }
    }

    pub fn to_tauri_error_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message().to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigSnapshot {
    pub settings: SettingsSnapshot,
    pub tasks: Vec<SyncTaskRecord>,
    pub exclusion_sets: Vec<ExclusionSetRecord>,
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    config_dir: PathBuf,
}

impl ConfigStore {
    pub fn from_app(app: &tauri::AppHandle) -> Result<Self, ConfigStoreError> {
        Ok(Self {
            config_dir: config_dir_for_app(app)?,
        })
    }

    pub fn from_config_dir(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn settings_file_path(&self) -> PathBuf {
        self.config_dir.join(SETTINGS_FILE_NAME)
    }

    pub fn tasks_file_path(&self) -> PathBuf {
        self.config_dir.join(TASKS_FILE_NAME)
    }

    pub fn exclusion_sets_file_path(&self) -> PathBuf {
        self.config_dir.join(EXCLUSION_SETS_FILE_NAME)
    }

    pub fn load_settings(&self) -> Result<StoredSettings, ConfigStoreError> {
        self.ensure_config_dir()?;
        let path = self.settings_file_path();
        self.load_or_create_yaml(&path, default_settings())
    }

    pub fn save_settings(&self, settings: &StoredSettings) -> Result<(), ConfigStoreError> {
        self.ensure_config_dir()?;
        self.write_yaml_atomic(&self.settings_file_path(), settings)
    }

    pub fn reset_settings(&self) -> Result<StoredSettings, ConfigStoreError> {
        let settings = default_settings();
        self.save_settings(&settings)?;
        Ok(settings)
    }

    pub fn load_tasks(&self) -> Result<Vec<SyncTaskRecord>, ConfigStoreError> {
        self.ensure_config_dir()?;
        let path = self.tasks_file_path();
        let stored: Vec<SyncTaskRecord> =
            self.load_or_create_yaml(&path, Vec::<SyncTaskRecord>::new())?;
        let normalized = normalize_task_records(stored);
        self.write_if_changed(&path, &normalized)?;
        Ok(normalized)
    }

    pub fn save_tasks(&self, tasks: &[SyncTaskRecord]) -> Result<(), ConfigStoreError> {
        self.ensure_config_dir()?;
        self.write_yaml_atomic(&self.tasks_file_path(), tasks)
    }

    pub fn load_exclusion_sets(&self) -> Result<Vec<ExclusionSetRecord>, ConfigStoreError> {
        self.ensure_config_dir()?;
        let path = self.exclusion_sets_file_path();
        let stored: Vec<ExclusionSetRecord> =
            self.load_or_create_yaml(&path, default_exclusion_sets())?;
        let normalized = normalize_exclusion_sets(stored);
        self.write_if_changed(&path, &normalized)?;
        Ok(normalized)
    }

    pub fn save_exclusion_sets(&self, sets: &[ExclusionSetRecord]) -> Result<(), ConfigStoreError> {
        self.ensure_config_dir()?;
        self.write_yaml_atomic(&self.exclusion_sets_file_path(), sets)
    }

    pub fn write_raw_file_at_path(
        &self,
        path: &Path,
        content: impl AsRef<[u8]>,
    ) -> Result<(), ConfigStoreError> {
        self.ensure_config_dir()?;
        self.write_yaml_atomic_bytes(path, content.as_ref())
    }

    pub async fn load_snapshot(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<AppConfigSnapshot, ConfigStoreError> {
        let settings = self.load_settings()?;
        let tasks = self.load_tasks()?;
        let exclusion_sets = self.load_exclusion_sets()?;
        let settings = settings_snapshot_from_store(app, settings).await?;
        Ok(AppConfigSnapshot {
            settings,
            tasks,
            exclusion_sets,
        })
    }

    fn ensure_config_dir(&self) -> Result<(), ConfigStoreError> {
        fs::create_dir_all(&self.config_dir).map_err(|error| ConfigStoreError::IoError {
            message: format!("Failed to create config dir: {error}"),
            file_path: Some(self.config_dir.to_string_lossy().to_string()),
        })
    }

    fn load_or_create_yaml<T>(&self, path: &Path, default_value: T) -> Result<T, ConfigStoreError>
    where
        T: Clone + Serialize + for<'de> Deserialize<'de>,
    {
        match fs::read_to_string(path) {
            Ok(raw) => {
                if raw.trim().is_empty() {
                    self.write_yaml_atomic(path, &default_value)?;
                    return Ok(default_value);
                }
                serde_yaml::from_str::<T>(&raw).map_err(|error| parse_error(path, raw, error))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.write_yaml_atomic(path, &default_value)?;
                Ok(default_value)
            }
            Err(error) => Err(ConfigStoreError::IoError {
                message: format!("Failed to read config file: {error}"),
                file_path: Some(path.to_string_lossy().to_string()),
            }),
        }
    }

    fn write_if_changed<T>(&self, path: &Path, value: &T) -> Result<(), ConfigStoreError>
    where
        T: Serialize,
    {
        let next =
            serde_yaml::to_string(value).map_err(|error| ConfigStoreError::ValidationError {
                message: format!("Failed to serialize config: {error}"),
            })?;
        match fs::read_to_string(path) {
            Ok(current) if current == next => Ok(()),
            Ok(_) | Err(_) => self.write_yaml_atomic_bytes(path, next.as_bytes()),
        }
    }

    fn write_yaml_atomic<T>(&self, path: &Path, value: &T) -> Result<(), ConfigStoreError>
    where
        T: Serialize + ?Sized,
    {
        let yaml =
            serde_yaml::to_string(value).map_err(|error| ConfigStoreError::ValidationError {
                message: format!("Failed to serialize config: {error}"),
            })?;
        self.write_yaml_atomic_bytes(path, yaml.as_bytes())
    }

    fn write_yaml_atomic_bytes(&self, path: &Path, bytes: &[u8]) -> Result<(), ConfigStoreError> {
        let Some(parent) = path.parent() else {
            return Err(ConfigStoreError::IoError {
                message: "Config file path has no parent".to_string(),
                file_path: Some(path.to_string_lossy().to_string()),
            });
        };

        fs::create_dir_all(parent).map_err(|error| ConfigStoreError::IoError {
            message: format!("Failed to prepare config dir: {error}"),
            file_path: Some(parent.to_string_lossy().to_string()),
        })?;

        let mut temp =
            NamedTempFile::new_in(parent).map_err(|error| ConfigStoreError::IoError {
                message: format!("Failed to create temp config file: {error}"),
                file_path: Some(path.to_string_lossy().to_string()),
            })?;
        std::io::Write::write_all(&mut temp, bytes).map_err(|error| ConfigStoreError::IoError {
            message: format!("Failed to write temp config file: {error}"),
            file_path: Some(path.to_string_lossy().to_string()),
        })?;
        temp.flush().map_err(|error| ConfigStoreError::IoError {
            message: format!("Failed to flush temp config file: {error}"),
            file_path: Some(path.to_string_lossy().to_string()),
        })?;
        temp.persist(path)
            .map_err(|error| ConfigStoreError::IoError {
                message: format!("Failed to persist config file: {}", error.error),
                file_path: Some(path.to_string_lossy().to_string()),
            })?;
        Ok(())
    }
}

pub fn app_support_dir_for_app(app: &tauri::AppHandle) -> Result<PathBuf, ConfigStoreError> {
    if let Some(override_dir) = override_app_support_dir() {
        return Ok(override_dir);
    }

    app.path()
        .app_data_dir()
        .map_err(|error| ConfigStoreError::IoError {
            message: format!("Failed to resolve app data dir: {error}"),
            file_path: None,
        })
}

pub fn default_app_support_dir() -> Result<PathBuf, ConfigStoreError> {
    if let Some(override_dir) = override_app_support_dir() {
        return Ok(override_dir);
    }

    let home = env::var("HOME").map_err(|error| ConfigStoreError::IoError {
        message: format!("HOME is not set: {error}"),
        file_path: None,
    })?;

    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(APP_IDENTIFIER))
}

pub fn config_dir_for_app(app: &tauri::AppHandle) -> Result<PathBuf, ConfigStoreError> {
    Ok(app_support_dir_for_app(app)?.join("config"))
}

pub fn default_config_dir() -> Result<PathBuf, ConfigStoreError> {
    Ok(default_app_support_dir()?.join("config"))
}

pub fn control_plane_socket_path_for_app(
    app: &tauri::AppHandle,
) -> Result<PathBuf, ConfigStoreError> {
    Ok(app_support_dir_for_app(app)?
        .join("control")
        .join(CONTROL_PLANE_SOCKET_FILE_NAME))
}

pub fn default_control_plane_socket_path() -> Result<PathBuf, ConfigStoreError> {
    Ok(default_app_support_dir()?
        .join("control")
        .join(CONTROL_PLANE_SOCKET_FILE_NAME))
}

pub async fn settings_snapshot_from_store(
    app: &tauri::AppHandle,
    settings: StoredSettings,
) -> Result<SettingsSnapshot, ConfigStoreError> {
    let license = license_validation::get_license_status(app.clone())
        .await
        .map_err(|message| ConfigStoreError::IoError {
            message,
            file_path: None,
        })?;
    Ok(SettingsSnapshot {
        language: settings.language,
        theme: settings.theme,
        data_unit_system: settings.data_unit_system,
        notifications: settings.notifications,
        state_location: settings.state_location,
        max_log_lines: settings.max_log_lines,
        close_action: settings.close_action,
        is_registered: license.is_registered,
        launch_at_login: launch_at_login_status_or_default(
            app.autolaunch()
                .is_enabled()
                .map_err(|error| error.to_string()),
        ),
        mcp_enabled: settings.mcp_enabled,
    })
}

pub(crate) fn launch_at_login_status_or_default(result: Result<bool, String>) -> bool {
    match result {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("[Autostart] Failed to read launch-at-login status: {error}");
            false
        }
    }
}

pub fn apply_settings_patch(mut settings: StoredSettings, patch: SettingsPatch) -> StoredSettings {
    if let Some(language) = patch.language {
        settings.language = language;
    }
    if let Some(theme) = patch.theme {
        settings.theme = theme;
    }
    if let Some(data_unit_system) = patch.data_unit_system {
        settings.data_unit_system = data_unit_system;
    }
    if let Some(notifications) = patch.notifications {
        settings.notifications = notifications;
    }
    if let Some(state_location) = patch.state_location {
        settings.state_location = state_location;
    }
    if let Some(max_log_lines) = patch.max_log_lines {
        settings.max_log_lines = max_log_lines;
    }
    if let Some(close_action) = patch.close_action {
        settings.close_action = close_action;
    }
    if let Some(mcp_enabled) = patch.mcp_enabled {
        settings.mcp_enabled = mcp_enabled;
    }
    settings
}

pub fn normalize_sync_task(task: SyncTaskRecord) -> Result<SyncTaskRecord, ConfigStoreError> {
    if task.name.trim().is_empty() {
        return Err(ConfigStoreError::ValidationError {
            message: "Task name cannot be empty".to_string(),
        });
    }
    if task.target.trim().is_empty() {
        return Err(ConfigStoreError::ValidationError {
            message: "Task target cannot be empty".to_string(),
        });
    }

    let mut normalized = task;
    let normalized_source = normalize_task_source(&normalized);
    if normalized_source.trim().is_empty() {
        return Err(ConfigStoreError::ValidationError {
            message: "Task source cannot be empty".to_string(),
        });
    }
    normalized.source = normalized_source;

    if normalized.source_type != Some(SourceType::Uuid) {
        normalized.source_type = Some(SourceType::Path);
        normalized.source_uuid = None;
        normalized.source_uuid_type = None;
        normalized.source_sub_path = None;
        normalized.source_identity = None;
    } else {
        let sub_path = normalized
            .source_sub_path
            .clone()
            .unwrap_or_else(|| "/".to_string());
        normalized.source_sub_path = Some(normalize_uuid_sub_path(&sub_path));
    }

    normalized.recurring_schedules = normalize_recurring_schedules(normalized.recurring_schedules)
        .map_err(|message| ConfigStoreError::ValidationError { message })?;

    normalized
        .exclusion_sets
        .retain(|value| !value.trim().is_empty());
    normalized.verify_after_copy = normalized.verify_after_copy;
    normalized.auto_unmount = should_enable_auto_unmount(&normalized);

    Ok(normalized)
}

pub fn build_sync_task_record(
    id: String,
    request: CreateSyncTaskRequest,
) -> Result<SyncTaskRecord, ConfigStoreError> {
    let task = normalize_sync_task(SyncTaskRecord {
        id,
        name: request.name,
        source: request.source,
        target: request.target,
        checksum_mode: request.checksum_mode,
        verify_after_copy: request.verify_after_copy,
        exclusion_sets: request.exclusion_sets,
        watch_mode: request.watch_mode,
        auto_unmount: request.auto_unmount,
        source_type: request.source_type,
        source_uuid: request.source_uuid,
        source_uuid_type: request.source_uuid_type,
        source_sub_path: request.source_sub_path,
        source_identity: request.source_identity,
        recurring_schedules: request.recurring_schedules,
    })?;

    validate_guided_preset_compatible_schedules(&task.recurring_schedules)
        .map_err(|message| ConfigStoreError::ValidationError { message })?;

    Ok(task)
}

pub fn apply_sync_task_update(
    task: SyncTaskRecord,
    update: &UpdateSyncTaskRequest,
) -> Result<SyncTaskRecord, ConfigStoreError> {
    let source_changed = update
        .source
        .as_ref()
        .is_some_and(|value| value != &task.source)
        || update
            .source_type
            .as_ref()
            .is_some_and(|value| Some(value.clone()) != task.source_type)
        || update
            .source_uuid
            .as_ref()
            .is_some_and(|value| Some(value.clone()) != task.source_uuid)
        || update
            .source_uuid_type
            .as_ref()
            .is_some_and(|value| Some(value.clone()) != task.source_uuid_type)
        || update
            .source_sub_path
            .as_ref()
            .is_some_and(|value| Some(value.clone()) != task.source_sub_path);
    let mut next = SyncTaskRecord {
        id: task.id,
        name: update.name.clone().unwrap_or(task.name),
        source: update.source.clone().unwrap_or(task.source),
        target: update.target.clone().unwrap_or(task.target),
        checksum_mode: update.checksum_mode.unwrap_or(task.checksum_mode),
        verify_after_copy: update.verify_after_copy.unwrap_or(task.verify_after_copy),
        exclusion_sets: update.exclusion_sets.clone().unwrap_or(task.exclusion_sets),
        watch_mode: update.watch_mode.unwrap_or(task.watch_mode),
        auto_unmount: update.auto_unmount.unwrap_or(task.auto_unmount),
        source_type: update.source_type.clone().or(task.source_type),
        source_uuid: update.source_uuid.clone().or(task.source_uuid),
        source_uuid_type: update.source_uuid_type.clone().or(task.source_uuid_type),
        source_sub_path: update.source_sub_path.clone().or(task.source_sub_path),
        source_identity: update.source_identity.clone().or(task.source_identity),
        recurring_schedules: update
            .recurring_schedules
            .clone()
            .unwrap_or(task.recurring_schedules),
    };
    if update.source_identity.is_none() && source_changed {
        next.source_identity = None;
    }
    let next = normalize_sync_task(next)?;

    if update.recurring_schedules.is_some() {
        validate_guided_preset_compatible_schedules(&next.recurring_schedules)
            .map_err(|message| ConfigStoreError::ValidationError { message })?;
    }

    Ok(next)
}

pub fn validate_exclusion_sets(sets: &[ExclusionSetRecord]) -> Result<(), ConfigStoreError> {
    for set in sets {
        input_validation::validate_exclude_patterns(&set.patterns).map_err(|error| {
            ConfigStoreError::ValidationError {
                message: format!("Invalid exclusion set '{}': {error}", set.name),
            }
        })?;
    }
    Ok(())
}

fn parse_error(path: &Path, raw_content: String, error: serde_yaml::Error) -> ConfigStoreError {
    let line = error.location().map(|location| location.line());
    let column = error.location().map(|location| location.column());
    ConfigStoreError::ParseError {
        message: error.to_string(),
        file_path: path.to_string_lossy().to_string(),
        raw_content,
        line,
        column,
    }
}

fn override_app_support_dir() -> Option<PathBuf> {
    env::var(APP_SUPPORT_DIR_OVERRIDE_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn default_language() -> String {
    "en".to_string()
}

fn default_notifications() -> bool {
    true
}

fn default_verify_after_copy() -> bool {
    true
}

fn default_max_log_lines() -> u32 {
    DEFAULT_MAX_LOG_LINES
}

fn default_data_unit_system() -> DataUnitSystem {
    DataUnitSystem::Binary
}

fn default_settings() -> StoredSettings {
    StoredSettings {
        language: default_language(),
        theme: ThemeMode::System,
        data_unit_system: DataUnitSystem::Binary,
        notifications: true,
        state_location: String::new(),
        max_log_lines: DEFAULT_MAX_LOG_LINES,
        close_action: CloseAction::Quit,
        mcp_enabled: false,
    }
}

pub fn default_settings_record() -> StoredSettings {
    default_settings()
}

fn default_exclusion_sets() -> Vec<ExclusionSetRecord> {
    vec![
        default_system_exclusion_set(),
        default_git_exclusion_set(),
        default_program_exclusion_set(),
    ]
}

pub fn default_exclusion_set_records() -> Vec<ExclusionSetRecord> {
    default_exclusion_sets()
}

fn default_system_exclusion_set() -> ExclusionSetRecord {
    ExclusionSetRecord {
        id: SYSTEM_DEFAULTS_SET_ID.to_string(),
        name: "System Junk".to_string(),
        patterns: vec![
            ".DS_Store",
            "Thumbs.db",
            ".Trash",
            "Desktop.ini",
            ".fseventsd",
            ".Spotlight-V100",
            ".Trashes",
            ".TemporaryItems",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
    }
}

fn default_git_exclusion_set() -> ExclusionSetRecord {
    ExclusionSetRecord {
        id: GIT_SET_ID.to_string(),
        name: "Git".to_string(),
        patterns: vec![".git"].into_iter().map(str::to_string).collect(),
    }
}

fn legacy_program_exclusion_sets() -> Vec<ExclusionSetRecord> {
    vec![
        ExclusionSetRecord {
            id: "nodejs".to_string(),
            name: "Node.js".to_string(),
            patterns: vec![
                "node_modules",
                ".pnpm",
                ".pnpm-store",
                ".npm",
                ".yarn/cache",
                ".yarn/unplugged",
                ".pnp",
                ".pnp.js",
                "jspm_packages",
                "web_modules",
                ".next",
                "out",
                ".nuxt",
                ".output",
                ".svelte-kit",
                ".angular",
                ".vite",
                ".parcel-cache",
                ".cache",
                ".docusaurus",
                ".turbo",
                ".nx",
                ".temp",
                ".tmp",
                "dist",
                "build",
                "coverage",
                ".serverless",
                ".firebase",
                ".vercel",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "python".to_string(),
            name: "Python".to_string(),
            patterns: vec![
                "__pycache__",
                "*.pyc",
                ".venv",
                "venv",
                "env",
                "ENV",
                ".tox",
                ".nox",
                ".pytest_cache",
                ".mypy_cache",
                ".ruff_cache",
                ".hypothesis",
                ".pyre",
                ".pytype",
                "__pypackages__",
                ".pdm-build",
                ".pdm-python",
                ".pixi",
                ".ipynb_checkpoints",
                "htmlcov",
                ".eggs",
                "*.egg-info",
                "build",
                "dist",
                ".pybuilder",
                "cython_debug",
                "instance",
                ".scrapy",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "rust".to_string(),
            name: "Rust (Tauri)".to_string(),
            patterns: vec![
                "src-tauri/target",
                "**/src-tauri/target",
                "target",
                "debug",
                "Cargo.lock",
                "**/*.rs.bk",
                "**/mutants.out*",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "jvm-build".to_string(),
            name: "JVM (Java/Kotlin/Gradle)".to_string(),
            patterns: vec![
                ".gradle",
                ".kotlin",
                "build",
                "out",
                "target",
                ".gradletasknamecache",
                ".mtj.tmp",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "dotnet".to_string(),
            name: ".NET".to_string(),
            patterns: vec![
                "bin",
                "obj",
                "Debug",
                "Release",
                "artifacts",
                "TestResults",
                "CodeCoverage",
                "Logs",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "ruby-rails".to_string(),
            name: "Ruby/Rails".to_string(),
            patterns: vec![
                ".bundle",
                "vendor/bundle",
                "tmp",
                "log",
                "coverage",
                ".yardoc",
                "_yardoc",
                "public/packs",
                "public/packs-test",
                "public/assets",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "php-laravel".to_string(),
            name: "PHP/Laravel".to_string(),
            patterns: vec![
                "vendor",
                "bootstrap/cache",
                "storage",
                "public/storage",
                "public/build",
                "public/hot",
                ".vagrant",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "dart-flutter".to_string(),
            name: "Dart/Flutter".to_string(),
            patterns: vec![
                ".dart_tool",
                ".pub",
                ".pub-preload-cache",
                ".flutter-plugins",
                ".flutter-plugins-dependencies",
                ".packages",
                ".packages.generated",
                "build",
                "coverage",
                "**/Flutter/ephemeral",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "swift-xcode".to_string(),
            name: "Swift/Xcode".to_string(),
            patterns: vec![
                "DerivedData",
                ".build",
                "Carthage/Build",
                "Pods",
                "xcuserdata",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        ExclusionSetRecord {
            id: "infra-terraform".to_string(),
            name: "Terraform".to_string(),
            patterns: vec![".terraform", ".terragrunt-cache"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        },
    ]
}

fn default_program_exclusion_set() -> ExclusionSetRecord {
    let mut patterns = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for set in legacy_program_exclusion_sets() {
        extend_unique_patterns(&mut patterns, &mut seen, set.patterns);
    }
    ExclusionSetRecord {
        id: PROGRAM_SET_ID.to_string(),
        name: "Program".to_string(),
        patterns,
    }
}

fn is_legacy_program_set_id(id: &str) -> bool {
    LEGACY_PROGRAM_SET_IDS.contains(&id)
}

fn extend_unique_patterns(
    target: &mut Vec<String>,
    seen: &mut std::collections::HashSet<String>,
    patterns: Vec<String>,
) {
    for pattern in patterns {
        if seen.insert(pattern.clone()) {
            target.push(pattern);
        }
    }
}

fn normalize_git_patterns(patterns: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for pattern in std::iter::once(".git".to_string()).chain(
        patterns
            .into_iter()
            .filter(|pattern| pattern != ".gitignore"),
    ) {
        if seen.insert(pattern.clone()) {
            normalized.push(pattern);
        }
    }
    normalized
}

fn normalize_exclusion_sets(sets: Vec<ExclusionSetRecord>) -> Vec<ExclusionSetRecord> {
    let mut system_patterns = None;
    let mut git_patterns = None;
    let mut program_patterns = default_program_exclusion_set().patterns;
    let mut seen_program_patterns: std::collections::HashSet<String> =
        program_patterns.iter().cloned().collect();
    let mut custom_sets = Vec::new();

    for set in sets {
        match set.id.as_str() {
            SYSTEM_DEFAULTS_SET_ID => {
                if system_patterns.is_none() {
                    system_patterns = Some(set.patterns);
                }
            }
            GIT_SET_ID => {
                git_patterns = Some(normalize_git_patterns(set.patterns));
            }
            PROGRAM_SET_ID => {
                extend_unique_patterns(
                    &mut program_patterns,
                    &mut seen_program_patterns,
                    set.patterns,
                );
            }
            id if is_legacy_program_set_id(id) => {
                extend_unique_patterns(
                    &mut program_patterns,
                    &mut seen_program_patterns,
                    set.patterns,
                );
            }
            _ => custom_sets.push(set),
        }
    }

    let system = ExclusionSetRecord {
        id: SYSTEM_DEFAULTS_SET_ID.to_string(),
        name: "System Junk".to_string(),
        patterns: system_patterns.unwrap_or_else(|| default_system_exclusion_set().patterns),
    };
    let git = ExclusionSetRecord {
        id: GIT_SET_ID.to_string(),
        name: "Git".to_string(),
        patterns: git_patterns.unwrap_or_else(|| default_git_exclusion_set().patterns),
    };
    let program = ExclusionSetRecord {
        id: PROGRAM_SET_ID.to_string(),
        name: "Program".to_string(),
        patterns: program_patterns,
    };

    let mut normalized = vec![system, git, program];
    normalized.extend(custom_sets);
    normalized
}

fn normalize_task_exclusion_set_ids(ids: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut program_added = false;

    for id in ids {
        if id == PROGRAM_SET_ID || is_legacy_program_set_id(id.as_str()) {
            if !program_added {
                normalized.push(PROGRAM_SET_ID.to_string());
                program_added = true;
            }
            continue;
        }
        normalized.push(id);
    }

    normalized
}

fn normalize_task_records(tasks: Vec<SyncTaskRecord>) -> Vec<SyncTaskRecord> {
    tasks
        .into_iter()
        .map(|mut task| {
            task.exclusion_sets = normalize_task_exclusion_set_ids(task.exclusion_sets);
            task
        })
        .collect()
}

fn normalize_task_source(task: &SyncTaskRecord) -> String {
    if task.source_type == Some(SourceType::Uuid) {
        if let (Some(uuid), Some(uuid_type)) = (&task.source_uuid, &task.source_uuid_type) {
            let prefix = match uuid_type {
                SourceUuidType::Disk => "[DISK_UUID:",
                SourceUuidType::Volume => "[VOLUME_UUID:",
            };
            return format!(
                "{prefix}{uuid}]{}",
                normalize_uuid_sub_path(task.source_sub_path.as_deref().unwrap_or("/"))
            );
        }
    }
    task.source.clone()
}

fn normalize_uuid_sub_path(sub_path: &str) -> String {
    let trimmed = sub_path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    let leading = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    let collapsed = leading.replace("//", "/");
    if collapsed.len() > 1 {
        collapsed.trim_end_matches('/').to_string()
    } else {
        collapsed
    }
}

fn should_enable_auto_unmount(task: &SyncTaskRecord) -> bool {
    let source = task.source.trim();
    let is_uuid = task.source_type == Some(SourceType::Uuid)
        || source.starts_with("[DISK_UUID:")
        || source.starts_with("[VOLUME_UUID:")
        || source.starts_with("[UUID:");
    task.auto_unmount && task.watch_mode && is_uuid
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalize_uuid_source_rebuilds_token() {
        let task = normalize_sync_task(SyncTaskRecord {
            id: "task-1".to_string(),
            name: "Task".to_string(),
            source: String::new(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
            watch_mode: true,
            auto_unmount: true,
            source_type: Some(SourceType::Uuid),
            source_uuid: Some("disk-a".to_string()),
            source_uuid_type: Some(SourceUuidType::Disk),
            source_sub_path: Some("DCIM".to_string()),
            source_identity: None,
            recurring_schedules: Vec::new(),
        })
        .expect("task should normalize");

        assert_eq!(task.source, "[DISK_UUID:disk-a]/DCIM");
        assert!(task.auto_unmount);
    }

    #[test]
    fn default_exclusion_sets_collapse_to_three_builtins() {
        let defaults = default_exclusion_sets();

        assert_eq!(defaults.len(), 3);
        assert_eq!(defaults[0].id, SYSTEM_DEFAULTS_SET_ID);
        assert_eq!(defaults[1].id, GIT_SET_ID);
        assert_eq!(defaults[2].id, PROGRAM_SET_ID);
        assert!(defaults[2]
            .patterns
            .iter()
            .any(|pattern| pattern == ".pnpm-store"));
        assert!(!defaults[2]
            .patterns
            .iter()
            .any(|pattern| pattern == ".pnpm_store"));
    }

    #[test]
    fn normalize_exclusion_sets_merges_legacy_program_sets_and_preserves_custom_order() {
        let normalized = normalize_exclusion_sets(vec![
            ExclusionSetRecord {
                id: "custom-a".to_string(),
                name: "Custom A".to_string(),
                patterns: vec!["custom-a".to_string()],
            },
            ExclusionSetRecord {
                id: "nodejs".to_string(),
                name: "Node".to_string(),
                patterns: vec!["node_modules".to_string(), "custom-node".to_string()],
            },
            ExclusionSetRecord {
                id: "git".to_string(),
                name: "Git Custom".to_string(),
                patterns: vec![".gitignore".to_string(), "git-extra".to_string()],
            },
            ExclusionSetRecord {
                id: "custom-b".to_string(),
                name: "Custom B".to_string(),
                patterns: vec!["custom-b".to_string()],
            },
            ExclusionSetRecord {
                id: "python".to_string(),
                name: "Python".to_string(),
                patterns: vec!["__pycache__".to_string(), "custom-python".to_string()],
            },
        ]);

        assert_eq!(
            normalized
                .iter()
                .map(|set| set.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                SYSTEM_DEFAULTS_SET_ID,
                GIT_SET_ID,
                PROGRAM_SET_ID,
                "custom-a",
                "custom-b"
            ]
        );
        assert_eq!(
            normalized[1].patterns,
            vec![".git".to_string(), "git-extra".to_string()]
        );
        assert!(normalized[2]
            .patterns
            .iter()
            .any(|pattern| pattern == "custom-node"));
        assert!(normalized[2]
            .patterns
            .iter()
            .any(|pattern| pattern == "custom-python"));
        assert!(normalized[2]
            .patterns
            .iter()
            .any(|pattern| pattern == ".pnpm-store"));
        assert!(!normalized[2]
            .patterns
            .iter()
            .any(|pattern| pattern == ".pnpm_store"));
        assert_eq!(
            normalized[2].patterns.first().map(String::as_str),
            Some("node_modules")
        );
        assert!(normalized[2]
            .patterns
            .windows(2)
            .any(|pair| pair[0] == "node_modules" && pair[1] == ".pnpm"));
        assert_eq!(
            normalized[2].patterns.last().map(String::as_str),
            Some("custom-python")
        );
    }

    #[test]
    fn normalize_task_exclusion_set_ids_collapses_legacy_program_ids() {
        let normalized = normalize_task_exclusion_set_ids(vec![
            "custom-a".to_string(),
            "python".to_string(),
            PROGRAM_SET_ID.to_string(),
            "git".to_string(),
            "rust".to_string(),
            "custom-b".to_string(),
        ]);

        assert_eq!(
            normalized,
            vec![
                "custom-a".to_string(),
                PROGRAM_SET_ID.to_string(),
                "git".to_string(),
                "custom-b".to_string(),
            ]
        );
    }

    #[test]
    fn load_tasks_and_exclusion_sets_normalize_on_disk() {
        let temp = tempdir().expect("tempdir should be created");
        let store = ConfigStore::from_config_dir(temp.path().to_path_buf());
        let exclusion_sets = vec![
            ExclusionSetRecord {
                id: "python".to_string(),
                name: "Python".to_string(),
                patterns: vec!["__pycache__".to_string()],
            },
            ExclusionSetRecord {
                id: "git".to_string(),
                name: "Git".to_string(),
                patterns: vec![".gitignore".to_string()],
            },
            ExclusionSetRecord {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                patterns: vec!["custom".to_string()],
            },
        ];
        let tasks = vec![SyncTaskRecord {
            id: "task-1".to_string(),
            name: "Task".to_string(),
            source: "/tmp/source".to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: vec![
                "python".to_string(),
                "custom".to_string(),
                "rust".to_string(),
            ],
            watch_mode: false,
            auto_unmount: false,
            source_type: None,
            source_uuid: None,
            source_uuid_type: None,
            source_sub_path: None,
            source_identity: None,
            recurring_schedules: Vec::new(),
        }];

        store
            .write_yaml_atomic(&store.exclusion_sets_file_path(), &exclusion_sets)
            .expect("should write exclusion sets");
        store
            .write_yaml_atomic(&store.tasks_file_path(), &tasks)
            .expect("should write tasks");

        let loaded_sets = store.load_exclusion_sets().expect("should load sets");
        let loaded_tasks = store.load_tasks().expect("should load tasks");

        assert_eq!(
            loaded_sets
                .iter()
                .map(|set| set.id.as_str())
                .collect::<Vec<_>>(),
            vec![SYSTEM_DEFAULTS_SET_ID, GIT_SET_ID, PROGRAM_SET_ID, "custom"]
        );
        assert_eq!(loaded_sets[1].patterns, vec![".git".to_string()]);
        assert_eq!(
            loaded_tasks[0].exclusion_sets,
            vec![PROGRAM_SET_ID.to_string(), "custom".to_string()]
        );
    }

    #[test]
    fn load_tasks_allows_existing_unsupported_custom_recurring_cron() {
        let temp = tempdir().expect("tempdir should be created");
        let store = ConfigStore::from_config_dir(temp.path().to_path_buf());
        let tasks = vec![SyncTaskRecord {
            id: "task-1".to_string(),
            name: "Task".to_string(),
            source: "/tmp/source".to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
            watch_mode: false,
            auto_unmount: false,
            source_type: None,
            source_uuid: None,
            source_uuid_type: None,
            source_sub_path: None,
            source_identity: None,
            recurring_schedules: vec![RecurringScheduleRecord {
                id: "schedule-1".to_string(),
                cron_expression: "*/15 9-17 * * 1-5".to_string(),
                timezone: "Asia/Seoul".to_string(),
                enabled: true,
                checksum_mode: false,
                retention_count: 20,
            }],
        }];

        store
            .write_yaml_atomic(&store.tasks_file_path(), &tasks)
            .expect("should write tasks");

        let loaded_tasks = store.load_tasks().expect("should load tasks");
        assert_eq!(
            loaded_tasks[0].recurring_schedules[0].cron_expression,
            "*/15 9-17 * * 1-5"
        );
    }

    #[test]
    fn create_rejects_unsupported_custom_recurring_cron() {
        let error = build_sync_task_record(
            "task-1".to_string(),
            CreateSyncTaskRequest {
                name: "Task".to_string(),
                source: "/tmp/source".to_string(),
                target: "/tmp/target".to_string(),
                checksum_mode: false,
                verify_after_copy: true,
                exclusion_sets: Vec::new(),
                watch_mode: false,
                auto_unmount: false,
                source_type: None,
                source_uuid: None,
                source_uuid_type: None,
                source_sub_path: None,
                source_identity: None,
                recurring_schedules: vec![RecurringScheduleRecord {
                    id: "schedule-1".to_string(),
                    cron_expression: "*/15 9-17 * * 1-5".to_string(),
                    timezone: "Asia/Seoul".to_string(),
                    enabled: true,
                    checksum_mode: false,
                    retention_count: 20,
                }],
            },
        )
        .expect_err("create should reject unsupported custom cron");

        assert!(matches!(error, ConfigStoreError::ValidationError { .. }));
    }

    #[test]
    fn update_rejects_explicit_unsupported_custom_recurring_cron() {
        let task = normalize_sync_task(SyncTaskRecord {
            id: "task-1".to_string(),
            name: "Task".to_string(),
            source: "/tmp/source".to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
            watch_mode: false,
            auto_unmount: false,
            source_type: None,
            source_uuid: None,
            source_uuid_type: None,
            source_sub_path: None,
            source_identity: None,
            recurring_schedules: Vec::new(),
        })
        .expect("task should normalize");

        let error = apply_sync_task_update(
            task,
            &UpdateSyncTaskRequest {
                task_id: "task-1".to_string(),
                recurring_schedules: Some(vec![RecurringScheduleRecord {
                    id: "schedule-1".to_string(),
                    cron_expression: "*/15 9-17 * * 1-5".to_string(),
                    timezone: "Asia/Seoul".to_string(),
                    enabled: true,
                    checksum_mode: false,
                    retention_count: 20,
                }]),
                ..UpdateSyncTaskRequest::default()
            },
        )
        .expect_err("explicit recurring schedule update should reject unsupported custom cron");

        assert!(matches!(error, ConfigStoreError::ValidationError { .. }));
    }

    #[test]
    fn update_preserves_existing_unsupported_custom_recurring_cron_when_omitted() {
        let task = normalize_sync_task(SyncTaskRecord {
            id: "task-1".to_string(),
            name: "Task".to_string(),
            source: "/tmp/source".to_string(),
            target: "/tmp/target".to_string(),
            checksum_mode: false,
            verify_after_copy: true,
            exclusion_sets: Vec::new(),
            watch_mode: false,
            auto_unmount: false,
            source_type: None,
            source_uuid: None,
            source_uuid_type: None,
            source_sub_path: None,
            source_identity: None,
            recurring_schedules: vec![RecurringScheduleRecord {
                id: "schedule-1".to_string(),
                cron_expression: "*/15 9-17 * * 1-5".to_string(),
                timezone: "Asia/Seoul".to_string(),
                enabled: true,
                checksum_mode: false,
                retention_count: 20,
            }],
        })
        .expect("task should normalize");

        let updated = apply_sync_task_update(
            task,
            &UpdateSyncTaskRequest {
                task_id: "task-1".to_string(),
                name: Some("Task Updated".to_string()),
                ..UpdateSyncTaskRequest::default()
            },
        )
        .expect("update should preserve omitted recurring schedules");

        assert_eq!(updated.name, "Task Updated");
        assert_eq!(updated.recurring_schedules.len(), 1);
        assert_eq!(
            updated.recurring_schedules[0].cron_expression,
            "*/15 9-17 * * 1-5"
        );
    }
}
